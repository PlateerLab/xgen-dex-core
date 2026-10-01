import { NativePlatformSessionClient, NativePlatformHttpError, NativeAccountChanged, type NativeDeviceStatus,
  type NativeTrustOverview, type NativeApprovalRequest, type NativeTrustedDevice } from '@dex/protocol/native-platform-session';
import type { MobileDeviceIdentity, MobileNativeContext } from './native-device-key';

export interface MobileEnrollmentAccount extends MobileNativeContext { accessToken: string }
export interface MobileEnrollmentState {
  registration: NativeDeviceStatus | null;
  overview: NativeTrustOverview | null;
  selectedApproverId: string | null;
  approval: NativeApprovalRequest | null;
  outcomeUncertain: boolean;
}
export class MobileEnrollmentError extends Error {
  constructor(readonly code: 'busy' | 'pending_required' | 'select_approver' | 'approver_changed' | 'closed') { super(code); }
}
export function mobileEnrollmentMessage(error: unknown): string {
  if (error instanceof NativePlatformHttpError) {
    if ([401, 403].includes(error.status)) return '로그인 또는 기기 권한을 다시 확인하세요. 인증 요청은 자동 재시도하지 않습니다.';
    if (error.status === 429) return '요청이 많습니다. 잠시 후 직접 다시 확인하세요.';
    if (error.status === 409) return '기기 상태가 변경되었습니다. 등록 상태를 다시 확인하세요.';
    if (error.status === 503) return '현재 서버에서 기기 등록을 사용할 수 없습니다.';
  }
  if (error instanceof NativeAccountChanged || (error instanceof MobileEnrollmentError && error.code === 'closed')) return '계정 또는 화면이 변경되어 작업을 중단했습니다.';
  if (error instanceof MobileEnrollmentError) return {
    busy: '기기 작업이 진행 중입니다.', pending_required: '승인 대기 기기를 먼저 등록하세요.',
    select_approver: '승인할 신뢰 브라우저를 선택하세요.', approver_changed: '선택한 브라우저의 신뢰 상태가 변경되었습니다. 다시 선택하세요.',
    closed: '작업이 종료되었습니다.',
  }[error.code];
  return '요청 결과를 확인하지 못했습니다. 등록 상태와 선택한 브라우저를 확인한 뒤 직접 다시 요청하세요.';
}
export function browserApprovers(state: MobileEnrollmentState): NativeTrustedDevice[] { return state.overview?.trusted_devices.filter((d) => d.platform === 'web') ?? []; }

/** Enrollment only. No session issuance, refresh, disk, password cache or automatic approval. */
export function createMobileEnrollment(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  fetch: typeof fetch;
}) {
  let state: MobileEnrollmentState = { registration: null, overview: null, selectedApproverId: null, approval: null, outcomeUncertain: false };
  let selectedOnce = false; let closed = false; let active: AbortController | null = null;
  const snapshot = (): MobileEnrollmentState => structuredSnapshot(state);
  const check = (expected: MobileEnrollmentAccount, signal: AbortSignal) => {
    signal.throwIfAborted(); const actual = options.current();
    if (closed || !actual || actual.authScope !== expected.authScope || actual.origin !== expected.origin || actual.userId !== expected.userId || actual.accessToken !== expected.accessToken) throw new NativeAccountChanged();
  };
  const applyOverview = (overview: NativeTrustOverview) => {
    const browsers = overview.trusted_devices.filter((d) => d.platform === 'web');
    const stillPresent = browsers.some((d) => d.device_id === state.selectedApproverId);
    const initialDefault = !selectedOnce ? browsers.filter((d) => d.is_default_approver) : [];
    state = { ...state, overview, selectedApproverId: stillPresent ? state.selectedApproverId : initialDefault.length === 1 ? initialDefault[0]!.device_id : null };
    selectedOnce = true;
  };
  async function run(action: 'inspect' | 'register' | 'request', deviceName?: string): Promise<MobileEnrollmentState> {
    if (closed) throw new MobileEnrollmentError('closed'); if (active) throw new MobileEnrollmentError('busy');
    const current = options.current(); if (!current) throw new NativeAccountChanged();
    const account = { ...current };
    // Context validation is also performed by the key provider before touching OS storage.
    const controller = new AbortController(); active = controller; const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 10000); let mutationStarted = false;
    try {
      check(account, signal);
      const identity = await options.keys.identity(false, signal); check(account, signal);
      const client = new NativePlatformSessionClient({ origin: account.origin, platform: 'mobile', identity, fetch: options.fetch,
        account: { current: () => { check(account, signal); return { authScope: account.authScope, accessToken: account.accessToken }; } } });
      let registration = await client.registrationStatus(signal); check(account, signal);
      if (action === 'register' && registration === null) { mutationStarted = true; registration = await client.register(deviceName, signal); check(account, signal); }
      const overview = await client.trustOverview(signal); check(account, signal);
      const selectedBefore = state.selectedApproverId;
      state = { ...state, registration }; applyOverview(overview);
      if (!registration || registration.state !== 'pending') state = { ...state, approval: null, outcomeUncertain: false };
      if (action === 'request') {
        if (selectedBefore && state.selectedApproverId !== selectedBefore) throw new MobileEnrollmentError('approver_changed');
        if (!registration || registration.state !== 'pending') throw new MobileEnrollmentError('pending_required');
        if (!state.selectedApproverId) throw new MobileEnrollmentError('select_approver');
        mutationStarted = true;
        const approval = await client.requestApproval(registration.device_id, state.selectedApproverId, signal); check(account, signal);
        state = { ...state, approval, outcomeUncertain: false };
      }
      return snapshot();
    } catch (error) {
      if (error instanceof NativeAccountChanged) {
        state = { registration: null, overview: null, selectedApproverId: null, approval: null, outcomeUncertain: false };
        closed = true;
      }
      if (mutationStarted && !closed) state = { ...state, approval: null, outcomeUncertain: true };
      // If the selected approver disappeared, do not silently choose another trusted device.
      throw error;
    } finally { clearTimeout(timeout); if (active === controller) active = null; }
  }
  return {
    snapshot,
    inspect: () => run('inspect'),
    register: (name?: string) => run('register', name),
    requestApproval: () => run('request'),
    selectApprover(id: string) {
      if (closed) throw new MobileEnrollmentError('closed'); if (active) throw new MobileEnrollmentError('busy');
      if (!browserApprovers(state).some((d) => d.device_id === id)) throw new MobileEnrollmentError('approver_changed');
      selectedOnce = true; state = { ...state, selectedApproverId: id }; return snapshot();
    },
    dispose() { closed = true; active?.abort(); state = { registration: null, overview: null, selectedApproverId: null, approval: null, outcomeUncertain: false }; },
  };
}
function structuredSnapshot(state: MobileEnrollmentState): MobileEnrollmentState {
  return { ...state, registration: state.registration ? { ...state.registration } : null,
    overview: state.overview ? { ...state.overview, trusted_devices: state.overview.trusted_devices.map((d) => ({ ...d })) } : null,
    approval: state.approval ? { ...state.approval } : null };
}
