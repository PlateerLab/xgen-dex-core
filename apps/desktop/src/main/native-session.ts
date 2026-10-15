import { DexError, MemoryConfigStore, defaultConfig, nativeKeyScope } from '@dex/engine';
import { NativePlatformHttpError, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import type { AgentSessionMutationConflict, AgentSessionMutationConflictCode } from '@dex/protocol/agent-session-mutation';
import { parseAgentFocus } from '@dex/protocol/agent-session';
import type { AgentSessionLifecycleConflict } from '@dex/protocol/agent-session-lifecycle';
import { NativeSessionRpcHost, type NativeSessionHostOptions } from '@dex/rpc/native-session-host';
import type { DesktopNativeMutationFailure, DesktopNativeReply, DesktopNativeNotice } from '../native-session-types';

export interface DesktopNativeContext { origin: string; userId: string | null }
export interface DesktopNativeOptions extends NativeSessionHostOptions {
  current: () => DesktopNativeContext;
  notify: (notice: DesktopNativeNotice) => void;
}
const mutationConflictCodes = new Set<AgentSessionMutationConflictCode>([
  'STATE_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'TURN_IN_PROGRESS', 'TURN_NOT_RUNNING',
  'TURN_ID_CONFLICT', 'TURN_NOT_STARTED', 'TURN_STOP_UNAVAILABLE',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function safeConflict(value: unknown): AgentSessionMutationConflict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== 'string' || !mutationConflictCodes.has(raw.code as AgentSessionMutationConflictCode)) return undefined;
  if (raw.current_state_version !== undefined && (typeof raw.current_state_version !== 'number'
    || !Number.isSafeInteger(raw.current_state_version) || raw.current_state_version < 1)) return undefined;
  if (raw.current_turn_id !== undefined && (typeof raw.current_turn_id !== 'string' || !uuid.test(raw.current_turn_id))) return undefined;
  return { code: raw.code as AgentSessionMutationConflictCode,
    ...(raw.current_state_version === undefined ? {} : { current_state_version: raw.current_state_version as number }),
    ...(raw.current_turn_id === undefined ? {} : { current_turn_id: raw.current_turn_id as string }) };
}
function safeLifecycleConflict(value: unknown): AgentSessionLifecycleConflict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.code !== 'FOCUS_VERSION_CONFLICT') return undefined;
  try { return { code: 'FOCUS_VERSION_CONFLICT', current: parseAgentFocus(raw.current) }; }
  catch { return undefined; }
}
function safeMutationFailure(value: unknown, code: DexError['code']): DesktopNativeMutationFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.outcome === 'unknown' && code === 'network_error') return { outcome: 'unknown' };
  if (raw.outcome !== 'rejected' || (code !== 'auth_required' && code !== 'usage_error')
    || typeof raw.status !== 'number' || !Number.isSafeInteger(raw.status)
    || raw.status < 400 || raw.status > 499 || raw.status === 408) return undefined;
  const conflict = safeConflict(raw.conflict) ?? safeLifecycleConflict(raw.conflict);
  return { outcome: 'rejected', status: raw.status, ...(conflict ? { conflict } : {}) };
}
function safeError(error: unknown): Extract<DesktopNativeReply, { ok: false }> {
  if (error instanceof DexError) {
    const mutation = safeMutationFailure(error.details, error.code);
    return { ok: false, code: error.code, message: error.message, ...mutation };
  }
  if (error instanceof NativePlatformHttpError) return { ok: false, code: `http_${error.status}`, message: `서버가 기기·세션 요청을 거절했습니다 (${error.status}).` };
  if (error instanceof NativePlatformTransportError) return { ok: false, code: 'network_error', message: 'HTTPS 서버 연결을 확인하세요.' };
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'cancelled', message: '기기·세션 작업이 취소되었습니다.' };
  return { ok: false, code: 'protocol_mismatch', message: '기기·세션 작업을 완료하지 못했습니다. 상태를 다시 확인하세요.' };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DexError('usage_error', '기기·세션 요청 형식을 확인하세요.');
  return value as Record<string, unknown>;
}
/** Main-process account binding; owns no renderer credentials, config writes or legacy fallback. */
export class DesktopNativeSessions {
  private host: NativeSessionRpcHost | null = null;
  private scope: string | null = null;
  private generation = 0;
  constructor(private readonly options: DesktopNativeOptions) {}
  reset(): void {
    this.generation++; this.host?.close(); this.host = null; this.scope = null;
    this.options.notify({ type: 'cleared' });
  }
  private current() {
    const current = this.options.current();
    if (!current.userId) throw new DexError('auth_required', '앱에 먼저 로그인하세요.');
    const scope = nativeKeyScope({ origin: current.origin, userId: current.userId, platform: 'desktop' });
    return { ...scope, key: JSON.stringify([scope.origin, scope.userId]) };
  }
  private discardStaleOwner(): void {
    if (!this.host) return;
    try { if (this.current().key !== this.scope) this.reset(); }
    catch { this.reset(); }
  }
  async request(rawMethod: unknown, rawParams: unknown = {}): Promise<DesktopNativeReply> {
    try {
      if (typeof rawMethod !== 'string' || !['device', 'session', 'watch', 'conversation', 'watch-conversation', 'watch-live',
        'submit-turn', 'stop-turn', 'agent-sessions', 'create-agent-session', 'switch-agent-focus', 'unwatch', 'cancel',
        'pick-attachments', 'attachments', 'upload-attachment', 'recover-attachment', 'cancel-attachment', 'discard-attachments'].includes(rawMethod)) {
        throw new DexError('usage_error', '지원하지 않는 기기·세션 작업입니다.');
      }
      const params = object(rawParams);
      // Renderer cannot select another origin/profile/account or make a host platform override.
      if (['profile', 'user_id', 'platform', 'platform_type', 'server_url', 'origin'].some((key) => key in params)) throw new DexError('usage_error', '기기·세션 계정과 서버는 앱이 지정합니다.');
      if (rawMethod === 'cancel') {
        if (Object.keys(params).length) throw new DexError('usage_error', '취소 요청에는 추가 항목을 넣을 수 없습니다.');
        this.generation++;
        const value = this.host ? await this.host.request('native/cancel', {}) : { watching: false as const };
        return { ok: true, value };
      }
      const scope = this.current();
      if (this.scope !== scope.key) {
        if (this.host) this.reset();
        this.scope = scope.key;
        const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'desktop', profiles: { desktop: { serverUrl: scope.origin } } });
        this.host = new NativeSessionRpcHost(configs, (value) => {
          try { if (this.scope === scope.key && this.current().key === scope.key) this.options.notify({ type: 'update', value }); }
          catch { this.reset(); }
        }, { ...this.options, expectedUserId: scope.userId }, 'desktop');
      }
      const generation = this.generation;
      const scoped = rawMethod === 'unwatch' ? params : { ...params, profile: 'desktop',
        ...(rawMethod === 'device' || (rawMethod === 'session' && params.action === 'login') ? {} : { user_id: scope.userId }) };
      const value = await this.host!.request(`native/${rawMethod}`, scoped);
      if (generation !== this.generation || this.current().key !== scope.key) {
        this.discardStaleOwner();
        if (rawMethod === 'submit-turn' || rawMethod === 'stop-turn' || rawMethod === 'create-agent-session' || rawMethod === 'switch-agent-focus'
          || rawMethod === 'upload-attachment' || rawMethod === 'cancel-attachment') {
          throw new DexError('network_error', rawMethod === 'create-agent-session' || rawMethod === 'switch-agent-focus'
            ? '작업 완료 여부를 확인할 수 없습니다. 현재 포커스와 세션 목록을 다시 확인하세요.'
            : '송신 완료 여부를 확인할 수 없습니다. 대화 상태를 확인하고 같은 요청으로 재확인하세요.',
            { outcome: 'unknown' });
        }
        throw new DOMException('Cancelled', 'AbortError');
      }
      return { ok: true, value };
    } catch (error) { this.discardStaleOwner(); return safeError(error); }
  }
}

/** Only the main renderer's top-level frame may invoke the new native credential boundary. */
export function isNativeSessionSender(sender: unknown, frame: unknown, main: { mainFrame: unknown } | null, trustedRendererUrl: string): boolean {
  if (main === null || sender !== main || frame === null || frame !== main.mainFrame) return false;
  try {
    const actualUrl = (frame as { url?: unknown }).url;
    if (typeof actualUrl !== 'string') return false;
    const actual = new URL(actualUrl); const trusted = new URL(trustedRendererUrl);
    actual.hash = ''; trusted.hash = '';
    return actual.href === trusted.href;
  } catch { return false; }
}
