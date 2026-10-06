import { randomUUID } from 'node:crypto';
import { DexError, NativeAgentConversationWatcher, NativeAgentFocusWatcher, NativeAgentLiveWatcher, NativeDeviceKeyStore, NativeHostSession, nativeAccountDeviceEnrollment, nativeKeyScope,
  type ConfigStore, type NativeAgentSocketTransport, type NativeEnrollmentAction } from '@dex/engine';
import type { NativeRpcResult, NativeSessionNotification } from './wire';
import { validateSubmitAgentTurn } from '@dex/protocol/agent-session-mutation';

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
export interface NativeSessionHostOptions {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  expectedUserId?: string;
  /** Trusted host dependency. Request parameters can never select or configure the socket transport. */
  socket?: (origin: string) => NativeAgentSocketTransport;
}

/** Host owns all credentials. Request bodies cannot change the constructor's platform. */
export class NativeSessionRpcHost {
  private readonly keys: NativeDeviceKeyStore;
  private active: AbortController | null = null;
  private watch: Watch | null = null;
  private draining: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly configs: ConfigStore, private readonly notify: (value: NativeSessionNotification) => void,
    private readonly options: NativeSessionHostOptions = {}, readonly platform: 'vscode' | 'desktop' = 'vscode') { this.keys = options.keys ?? new NativeDeviceKeyStore(); }
  cancel(): void { this.active?.abort(); const watch = this.watch; this.watch = null; watch?.controller.abort(); }
  close(): void { this.closed = true; this.cancel(); }
  private async stopWatch(signal: AbortSignal = AbortSignal.timeout(15000)): Promise<void> {
    const watch = this.watch; this.watch = null; watch?.controller.abort();
    signal.throwIfAborted();
    // Watcher cancellation can finish before the underlying native vault operation.
    // Keep the drain barrier even when cancel/close already removed this.watch.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.draining.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  async request(method: string, p: Record<string, unknown>): Promise<NativeRpcResult | { watching: false }> {
    p = { ...p };
    if (this.closed) throw new DexError('auth_required', '네이티브 호스트가 종료되었습니다.');
    if (method === 'native/unwatch') {
      fields(p, ['watch_id']); const id = text(p, 'watch_id');
      if (this.watch?.id === id) await this.stopWatch(); return { watching: false };
    }
    if (method === 'native/cancel') { fields(p, []); this.cancel(); return { watching: false }; }
    if (!['native/device', 'native/session', 'native/watch', 'native/conversation', 'native/watch-conversation', 'native/watch-live', 'native/submit-turn', 'native/stop-turn',
      'native/agent-sessions', 'native/create-agent-session', 'native/switch-agent-focus'].includes(method)) {
      throw new DexError('usage_error', '지원하지 않는 네이티브 요청입니다.');
    }
    if (this.active) throw new DexError('usage_error', '이전 네이티브 작업이 끝난 뒤 다시 실행하세요.');
    if (method === 'native/submit-turn' && p.attachments !== undefined) {
      // Nested references must be copied before stopWatch/config/vault can yield.
      try {
        p.attachments = validateSubmitAgentTurn(p.agent_session_id as string, {
          input_text: p.input_text, expected_state_version: p.expected_state_version,
          idempotency_key: p.idempotency_key, ...(p.origin_id !== undefined ? { origin_id: p.origin_id } : {}),
          attachments: p.attachments,
        }).attachments;
      } catch { throw new DexError('usage_error', '첨부 참조와 원래 턴 입력을 확인하세요.'); }
    }
    const controller = new AbortController(); this.active = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 15000);
    let sessionForDrain: NativeHostSession | null = null;
    try {
      await this.stopWatch(signal); signal.throwIfAborted();
      const conversation = method === 'native/conversation' || method === 'native/watch-conversation' || method === 'native/watch-live';
      const watching = method === 'native/watch' || method === 'native/watch-conversation' || method === 'native/watch-live';
      const live = method === 'native/watch-live';
      const mutation = method === 'native/submit-turn' || method === 'native/stop-turn';
      const catalog = method === 'native/agent-sessions';
      const lifecycle = method === 'native/create-agent-session' || method === 'native/switch-agent-focus';
      const action = mutation || catalog || lifecycle ? method.slice(7) : watching ? 'watch' : conversation ? 'conversation' : text(p, 'action')!;
      const device = method === 'native/device'; const passwordAction = device || ['login', 'logout'].includes(action);
      const accountField = device || action === 'login' ? 'email' : 'user_id';
      fields(p, ['profile', ...(mutation ? ['user_id', 'agent_session_id', 'expected_state_version',
        ...(method === 'native/submit-turn' ? ['input_text', 'idempotency_key', 'origin_id', 'attachments'] : ['turn_id'])]
        : catalog ? ['user_id', 'limit', 'before_id']
        : lifecycle ? ['user_id', 'expected_version', 'origin_id', ...(method === 'native/create-agent-session' ? ['workflow_id', 'title'] : ['active_agent_session_id'])]
        : watching ? ['user_id', 'interval_ms'] : conversation ? ['user_id'] : ['action', accountField]),
        ...(passwordAction ? ['password'] : []), ...(device && action === 'register' ? ['device_name'] : []),
        ...(device && action === 'request-approval' ? ['approver_device_id'] : [])]);
      const account = text(p, accountField)!; const password = passwordAction ? text(p, 'password')! : '';
      const interval = watching ? p.interval_ms : undefined;
      if (interval !== undefined && (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 200 || interval > 60000)) {
        throw new DexError('usage_error', '구독 간격은 200~60000 사이의 정수 ms여야 합니다.');
      }
      if (accountField === 'user_id' && this.options.expectedUserId !== undefined && account !== this.options.expectedUserId) {
        throw new DexError('auth_required', '현재 앱에 로그인한 계정만 사용할 수 있습니다.');
      }
      const config = await this.configs.read(); signal.throwIfAborted();
      const profile = text(p, 'profile', false) ?? config.currentProfile;
      const configured = config.profiles[profile]; if (!configured) throw new DexError('not_found', 'HTTPS 서버 프로필을 먼저 설정하세요.');
      const scope = nativeKeyScope({ origin: configured.serverUrl, platform: this.platform, userId: accountField === 'email' ? '1' : account });
      const envelope = { platform_type: this.platform, profile, server_url: scope.origin };
      const session = new NativeHostSession(scope.origin, this.platform, this.keys, this.options.fetch, this.options.expectedUserId,
        live ? this.options.socket?.(scope.origin) : undefined);
      sessionForDrain = session;
      if (catalog) {
        if (p.limit !== undefined && (typeof p.limit !== 'number' || !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100)) {
          throw new DexError('usage_error', '대화 목록 개수는 1~100 사이의 정수여야 합니다.');
        }
        if (p.before_id !== undefined && (typeof p.before_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.before_id))) {
          throw new DexError('usage_error', '대화 목록 커서를 확인하세요.');
        }
        const focus = await session.focus(account, signal);
        const sessions = await session.agentSessions(account, p.limit as number | undefined, p.before_id as string | undefined, signal);
        signal.throwIfAborted();
        return { ...envelope, user_id: account, focus, sessions };
      }
      if (lifecycle) {
        if (method === 'native/create-agent-session') {
          const created = await session.createAgentSession(account, { workflow_id: p.workflow_id as string, expected_version: p.expected_version as number,
            ...(p.title !== undefined ? { title: p.title as string } : {}), ...(p.origin_id !== undefined ? { origin_id: p.origin_id as string } : {}) }, signal);
          return { ...envelope, user_id: account, created };
        }
        const focus = await session.switchAgentFocus(account, { active_agent_session_id: p.active_agent_session_id as string | null,
          expected_version: p.expected_version as number, ...(p.origin_id !== undefined ? { origin_id: p.origin_id as string } : {}) }, signal);
        return { ...envelope, user_id: account, focus };
      }
      if (mutation) {
        const agentSessionId = text(p, 'agent_session_id')!;
        const result = method === 'native/submit-turn'
          ? await session.submitTurn(account, agentSessionId, { input_text: p.input_text as string,
            expected_state_version: p.expected_state_version as number, idempotency_key: text(p, 'idempotency_key')!,
            ...(p.attachments !== undefined ? { attachments: p.attachments as import('@dex/protocol/agent-session-mutation').SubmitAgentTurnInput['attachments'] } : {}),
            ...(p.origin_id !== undefined ? { origin_id: text(p, 'origin_id')! } : {}) }, signal)
          : await session.stopTurn(account, agentSessionId, { turn_id: text(p, 'turn_id')!, expected_state_version: p.expected_state_version as number }, signal);
        // A validated mutation ack may already be durable. Do not replace it with a late generic cancellation.
        return { ...envelope, user_id: account, agent_session_id: agentSessionId, mutation: result };
      }
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
        const conversationWatcher = conversation
          ? live
            ? new NativeAgentLiveWatcher(session, account, { intervalMs: interval as number | undefined })
            : new NativeAgentConversationWatcher(session, account, { intervalMs: interval as number | undefined })
          : null;
        const focusWatcher = conversation ? null : new NativeAgentFocusWatcher(session, account, { intervalMs: interval as number | undefined });
        const status = await session.status(account, signal);
        if (status.state !== 'active') throw new DexError('auth_required', '사용 가능한 플랫폼 access가 없습니다. 로그인 또는 갱신을 먼저 실행하세요.');
        const watch: Watch = { id: randomUUID(), controller: new AbortController(), done: Promise.resolve() }; this.watch = watch;
        // Acknowledgment precedes notifications, as with chat/start.
        // Track the scheduled launch before ACK: replacement must also wait for a watcher
        // that has not entered run() yet, otherwise both owners can enter the OS vault.
        watch.done = new Promise<void>((resolve) => { setImmediate(() => {
          if (this.closed || this.watch !== watch || watch.controller.signal.aborted) { resolve(); return; }
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
          void done.catch(() => {
            // The watcher has emitted its safe stopped reason. Never log raw transport/keychain data.
          }).finally(() => { if (this.watch === watch) this.watch = null; resolve(); });
        }); });
        this.draining = Promise.all([this.draining, watch.done.then(() => session.settleProofOperations())]).then(() => undefined);
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
    } finally {
      if (sessionForDrain) this.draining = Promise.all([this.draining, sessionForDrain.settleProofOperations()]).then(() => undefined);
      clearTimeout(timeout); this.active = null;
    }
  }
}
