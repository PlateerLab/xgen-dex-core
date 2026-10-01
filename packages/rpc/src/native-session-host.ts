import { randomUUID } from 'node:crypto';
import { DexError, NativeAgentConversationWatcher, NativeAgentFocusWatcher, NativeDeviceKeyStore, NativeHostSession, nativeAccountDeviceEnrollment, nativeKeyScope,
  type ConfigStore, type NativeEnrollmentAction } from '@dex/engine';
import type { NativeRpcResult, NativeSessionNotification } from './wire';

function text(p: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = p[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > 1024) throw new DexError('usage_error', '네이티브 요청의 필수 문자열을 확인하세요.');
  return value;
}
function fields(p: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(p).some((key) => !allowed.includes(key))) throw new DexError('usage_error', '지원하지 않는 네이티브 요청 항목입니다.');
}
interface Watch {
  id: string; controller: AbortController; done: Promise<void>;
}
export interface NativeSessionHostOptions { keys?: NativeDeviceKeyStore; fetch?: typeof fetch; expectedUserId?: string }

/** Host owns all credentials. Request bodies cannot change the constructor's platform. */
export class NativeSessionRpcHost {
  private readonly keys: NativeDeviceKeyStore;
  private active: AbortController | null = null;
  private watch: Watch | null = null;
  private closed = false;
  constructor(private readonly configs: ConfigStore, private readonly notify: (value: NativeSessionNotification) => void,
    private readonly options: NativeSessionHostOptions = {}, readonly platform: 'vscode' | 'desktop' = 'vscode') { this.keys = options.keys ?? new NativeDeviceKeyStore(); }
  cancel(): void { this.active?.abort(); const watch = this.watch; this.watch = null; watch?.controller.abort(); }
  close(): void { this.closed = true; this.cancel(); }
  private async stopWatch(): Promise<void> {
    const watch = this.watch; this.watch = null; watch?.controller.abort(); await watch?.done;
  }
  async request(method: string, p: Record<string, unknown>): Promise<NativeRpcResult | { watching: false }> {
    if (this.closed) throw new DexError('auth_required', '네이티브 호스트가 종료되었습니다.');
    if (method === 'native/unwatch') {
      fields(p, ['watch_id']); const id = text(p, 'watch_id');
      if (this.watch?.id === id) await this.stopWatch(); return { watching: false };
    }
    if (method === 'native/cancel') { fields(p, []); this.cancel(); return { watching: false }; }
    if (!['native/device', 'native/session', 'native/watch', 'native/conversation', 'native/watch-conversation'].includes(method)) {
      throw new DexError('usage_error', '지원하지 않는 네이티브 요청입니다.');
    }
    if (this.active) throw new DexError('usage_error', '이전 네이티브 작업이 끝난 뒤 다시 실행하세요.');
    const controller = new AbortController(); this.active = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await this.stopWatch(); signal.throwIfAborted();
      const conversation = method === 'native/conversation' || method === 'native/watch-conversation';
      const watching = method === 'native/watch' || method === 'native/watch-conversation';
      const action = watching ? 'watch' : conversation ? 'conversation' : text(p, 'action')!;
      const device = method === 'native/device'; const passwordAction = device || ['login', 'logout'].includes(action);
      const accountField = device || action === 'login' ? 'email' : 'user_id';
      fields(p, ['profile', ...(watching ? ['user_id', 'interval_ms'] : conversation ? ['user_id'] : ['action', accountField]),
        ...(passwordAction ? ['password'] : []), ...(device && action === 'register' ? ['device_name'] : []),
        ...(device && action === 'request-approval' ? ['approver_device_id'] : [])]);
      const account = text(p, accountField)!; const password = passwordAction ? text(p, 'password')! : '';
      if (accountField === 'user_id' && this.options.expectedUserId !== undefined && account !== this.options.expectedUserId) {
        throw new DexError('auth_required', '현재 앱에 로그인한 계정만 사용할 수 있습니다.');
      }
      const config = await this.configs.read(); signal.throwIfAborted();
      const profile = text(p, 'profile', false) ?? config.currentProfile;
      const configured = config.profiles[profile]; if (!configured) throw new DexError('not_found', 'HTTPS 서버 프로필을 먼저 설정하세요.');
      const scope = nativeKeyScope({ origin: configured.serverUrl, platform: this.platform, userId: accountField === 'email' ? '1' : account });
      const envelope = { platform_type: this.platform, profile, server_url: scope.origin };
      const session = new NativeHostSession(scope.origin, this.platform, this.keys, this.options.fetch, this.options.expectedUserId);
      if (device) {
        let operation: NativeEnrollmentAction;
        if (action === 'register') operation = { action, deviceName: text(p, 'device_name', false) ?? (this.platform === 'vscode' ? 'VSCode' : 'Desktop') };
        else if (action === 'status' || action === 'approvers') operation = { action };
        else if (action === 'request-approval') operation = { action, approverDeviceId: text(p, 'approver_device_id')! };
        else throw new DexError('usage_error', '지원하지 않는 기기 작업입니다.');
        const result = await nativeAccountDeviceEnrollment({ origin: scope.origin, platform: this.platform, email: account, password,
          operation, keys: this.keys, fetch: this.options.fetch, signal, expectedUserId: this.options.expectedUserId });
        signal.throwIfAborted(); return { ...envelope, ...result };
      }
      if (watching) {
        const interval = p.interval_ms;
        if (interval !== undefined && (typeof interval !== 'number' || !Number.isSafeInteger(interval))) throw new DexError('usage_error', '구독 간격은 정수 ms여야 합니다.');
        const conversationWatcher = conversation ? new NativeAgentConversationWatcher(session, account, { intervalMs: interval as number | undefined }) : null;
        const focusWatcher = conversation ? null : new NativeAgentFocusWatcher(session, account, { intervalMs: interval as number | undefined });
        const status = await session.status(account, signal);
        if (status.state !== 'active') throw new DexError('auth_required', '사용 가능한 플랫폼 access가 없습니다. 로그인 또는 갱신을 먼저 실행하세요.');
        const watch: Watch = { id: randomUUID(), controller: new AbortController(), done: Promise.resolve() }; this.watch = watch;
        // Acknowledgment precedes notifications, as with chat/start.
        setImmediate(() => {
          const done = conversation
            ? conversationWatcher!.run((update) => {
              if (!this.closed && this.watch === watch && !watch.controller.signal.aborted) {
                this.notify({ ...envelope, watch_id: watch.id, view: 'conversation', update });
              }
            }, watch.controller.signal)
            : focusWatcher!.run((update) => {
              if (!this.closed && this.watch === watch && !watch.controller.signal.aborted) {
                this.notify({ ...envelope, watch_id: watch.id, update });
              }
            }, watch.controller.signal);
          watch.done = done.catch(() => {
            // The watcher has emitted its safe stopped reason. Never log raw transport/keychain data.
          }).finally(() => { if (this.watch === watch) this.watch = null; });
        });
        signal.throwIfAborted(); return { ...envelope, user_id: account, watch_id: watch.id,
          ...(conversation ? { view: 'conversation' as const } : {}) };
      }
      if (conversation) {
        const result = await session.conversation(account, signal);
        signal.throwIfAborted();
        return { ...envelope, user_id: account, view: 'conversation', conversation: result.conversation, has_more: result.has_more };
      }
      const result = action === 'login' ? await session.login(account, password, signal)
        : action === 'status' ? await session.status(account, signal)
        : action === 'refresh' ? await session.refresh(account, signal)
        : action === 'logout' ? await session.logout(account, password, signal)
        : action === 'forget-local' ? await session.forgetLocal(account, signal) : null;
      if (!result) throw new DexError('usage_error', '지원하지 않는 세션 작업입니다.');
      signal.throwIfAborted(); return { ...envelope, user_id: result.user_id, result,
        ...(action === 'forget-local' ? { server_revoked: false as const } : {}) };
    } finally { clearTimeout(timeout); this.active = null; }
  }
}
