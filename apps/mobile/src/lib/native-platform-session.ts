import { NativePlatformSessionClient, NativeAccountChanged, NativePlatformHttpError, NativePlatformProtocolError, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import { mobileKeyThumbprint, type MobileDeviceIdentity } from './native-device-key';
import { MobileVaultError, type MobilePlatformRecord, type createMobileSessionVault } from './native-session-vault';

export interface MobilePlatformSummary {
  userId: string; deviceId: string | null; sessionId: string | null; accessExpiresAt: string | null;
  state: 'unchecked' | 'signed_out' | 'active' | 'access_expired' | 'access_unavailable' | MobilePlatformRecord['phase'];
}
export class MobilePlatformError extends Error {
  constructor(readonly code: 'busy' | 'closed' | 'existing' | 'trusted_required' | 'session_required' | 'access_required' | 'password_required') { super(code); }
}
export function mobilePlatformMessage(e: unknown): string {
  if (e instanceof MobileVaultError) return e.message;
  if (e instanceof NativeAccountChanged) return '계정 또는 서버가 변경되어 세션 작업을 중단했습니다.';
  if (e instanceof NativePlatformHttpError) {
    if (e.status === 503) return '현재 서버에서 Mobile 세션 발급·갱신을 사용할 수 없습니다. 처리 중 기록은 상태 확인 후 복구하세요.';
    if ([401, 403].includes(e.status)) return '비밀번호·기기 권한 또는 서버 세션을 확인하세요. 자동 재시도하지 않습니다.';
    if (e.status === 409) return '서버 세션 상태가 변경되었습니다. PC의 내 페이지에서 확인하세요.';
    if (e.status === 429) return '요청이 많습니다. 잠시 후 상태를 직접 확인하세요.';
  }
  if (e instanceof MobilePlatformError) return { busy: '세션 작업이 진행 중입니다.', closed: '화면이 변경되어 세션 작업을 중단했습니다.',
    existing: '기존 세션 기록을 먼저 확인하세요. 중단된 세션은 PC에서 폐기한 뒤 로컬 기록을 지우세요.',
    trusted_required: '이 휴대폰의 등록과 PC 브라우저 승인을 먼저 완료하세요.', session_required: '사용 가능한 Mobile 세션이 없습니다. 처리 중 기록은 PC에서 확인한 뒤 복구하세요.',
    access_required: '사용 가능한 Mobile access 토큰이 없습니다. 먼저 세션 갱신을 실행하세요.', password_required: '현재 계정 비밀번호를 입력하세요.' }[e.code];
  return '세션 결과를 확인하지 못했습니다. PC의 내 페이지에서 서버 상태를 확인하세요. 이전 토큰을 복원하거나 자동 재시도하지 않습니다.';
}
function usable(r: MobilePlatformRecord): boolean { return r.phase === 'ready' && r.accessToken !== null && r.accessExpiresAt !== null
  && Math.floor(Date.parse(r.accessExpiresAt) / 1000) * 1000 > Date.now() + 1000; }
function summary(userId: string, r: MobilePlatformRecord | null): MobilePlatformSummary {
  return { userId, deviceId: r?.deviceId ?? null, sessionId: r?.sessionId ?? null, accessExpiresAt: r?.accessExpiresAt ?? null,
    state: !r ? 'signed_out' : r.phase !== 'ready' ? r.phase : r.accessToken === null ? 'access_unavailable' : usable(r) ? 'active' : 'access_expired' };
}
function passwordRequired(value: string): void { if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 1024) throw new MobilePlatformError('password_required'); }
function ready(r: MobilePlatformRecord | null): MobilePlatformRecord { if (!r || r.phase !== 'ready') throw new MobilePlatformError('session_required'); return r; }

/** Explicit operations only; secure credentials never enter snapshots, legacy chat or diagnostics. */
export function createMobilePlatformSession(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  vault: ReturnType<typeof createMobileSessionVault>; generation(): string;
  enrollmentFetch: typeof fetch; sessionFetch: typeof fetch;
}) {
  const initial = options.current(); if (!initial) throw new NativeAccountChanged();
  const authority = { origin: initial.origin, userId: initial.userId, authScope: initial.authScope }; let closed = false; let active: AbortController | null = null;
  let state: MobilePlatformSummary = { userId: initial.userId, deviceId: null, sessionId: null, accessExpiresAt: null, state: 'unchecked' };
  const snapshot = () => ({ ...state });
  async function run(action: 'inspect' | 'login' | 'refresh' | 'logout' | 'forget', password = ''): Promise<MobilePlatformSummary> {
    if (closed) throw new MobilePlatformError('closed'); if (active) throw new MobilePlatformError('busy');
    const account = options.current(); const controller = new AbortController(); active = controller; const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 20000);
    const check = () => {
      signal.throwIfAborted(); const actual = options.current();
      if (closed || !account || !actual || actual.origin !== authority.origin || actual.userId !== authority.userId || actual.authScope !== authority.authScope
        || (action === 'login' && actual.accessToken !== account.accessToken)) throw new NativeAccountChanged();
    };
    const generation = () => { const value = options.generation(); if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new MobileVaultError(); return value; };
    try {
      check(); if (action === 'login' || action === 'logout') passwordRequired(password);
      if (action === 'forget') { await options.vault.forget(authority, check); state = summary(authority.userId, null); return snapshot(); }
      const identity = await options.keys.identity(false, signal); check();
      return await options.vault.withIdentity(authority, identity, check, async (vault) => {
        const old = await vault.read(); check(); state = summary(authority.userId, old);
        if (action === 'inspect') return snapshot();
        const client = (fetchImpl: typeof fetch, requireToken: boolean) => new NativePlatformSessionClient({ origin: authority.origin, platform: 'mobile', identity, fetch: fetchImpl,
          account: { current: () => { check(); return { authScope: authority.authScope, accessToken: requireToken ? account!.accessToken : null }; } } });
        const marker = (r: MobilePlatformRecord, phase: 'refreshing' | 'logout_pending'): MobilePlatformRecord => ({ ...r, generation: generation(), phase,
          refreshToken: null, accessToken: null, accessExpiresAt: null });
        if (action === 'login') {
          if (old) throw new MobilePlatformError('existing');
          const device = await client(options.enrollmentFetch, true).registrationStatus(signal); check();
          if (!device || device.state !== 'trusted') throw new MobilePlatformError('trusted_required');
          const pending: MobilePlatformRecord = { version: 1, platform: 'mobile', origin: authority.origin, userId: authority.userId,
            installId: identity.installId, keyThumbprint: mobileKeyThumbprint(identity.publicKey), deviceId: device.device_id, sessionId: null,
            generation: generation(), phase: 'login_pending', refreshToken: null, accessToken: null, accessExpiresAt: null };
          await vault.begin(pending); check(); state = summary(authority.userId, pending);
          const result = await client(options.sessionFetch, true).login(device.device_id, password, signal); check();
          const next: MobilePlatformRecord = { ...pending, sessionId: result.session_id, generation: generation(), phase: result.state === 'active' ? 'ready' : 'pending_takeover',
            refreshToken: result.refresh_token, accessToken: result.access_token, accessExpiresAt: result.access_expires_at };
          await vault.commit(next); check(); state = summary(authority.userId, next); return snapshot();
        }
        const record = ready(old);
        if (action === 'refresh') {
          const pending = marker(record, 'refreshing'); await vault.begin(pending); check(); state = summary(authority.userId, pending);
          const result = await client(options.sessionFetch, false).refresh(record.deviceId, record.sessionId!, record.refreshToken!, signal); check();
          const next: MobilePlatformRecord = { ...record, generation: generation(), refreshToken: result.refresh_token,
            accessToken: result.access_token, accessExpiresAt: result.access_expires_at };
          await vault.commit(next); check(); state = summary(authority.userId, next); return snapshot();
        }
        if (!usable(record)) throw new MobilePlatformError('access_required');
        const pending = marker(record, 'logout_pending'); await vault.begin(pending); check(); state = summary(authority.userId, pending);
        if (!identity.signDpop) throw new NativePlatformTransportError();
        const htu = `${authority.origin}/api/me/platform-sessions/${record.sessionId}`;
        const proof = await identity.signDpop('DELETE', htu, record.accessToken!, signal); check();
        const response = await options.sessionFetch(htu, { method: 'DELETE', headers: { Authorization: `DPoP ${record.accessToken}`, DPoP: proof,
          Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal }); check();
        if (response.status !== 204) { if (!response.ok) throw new NativePlatformHttpError(response.status); throw new NativePlatformProtocolError('Invalid Mobile logout response'); }
        await vault.clear(); check(); state = summary(authority.userId, null); return snapshot();
      });
    } catch (e) {
      if (e instanceof MobileVaultError) state = { userId: authority.userId, deviceId: null, sessionId: null, accessExpiresAt: null, state: 'unchecked' };
      if (e instanceof NativeAccountChanged) { state = { userId: authority.userId, deviceId: null, sessionId: null, accessExpiresAt: null, state: 'unchecked' };
        const now = options.current(); closed = !now || now.origin !== authority.origin || now.userId !== authority.userId || now.authScope !== authority.authScope; }
      throw e;
    } finally { password = ''; clearTimeout(timer); if (active === controller) active = null; }
  }
  return { snapshot, inspect: () => run('inspect'), login: (password: string) => run('login', password), refresh: () => run('refresh'),
    logout: (password: string) => run('logout', password), forgetLocal: () => run('forget'),
    dispose() { closed = true; active?.abort(); state = { userId: authority.userId, deviceId: null, sessionId: null, accessExpiresAt: null, state: 'unchecked' }; },
  };
}
