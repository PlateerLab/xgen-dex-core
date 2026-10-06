import { createHash, randomUUID } from 'node:crypto';
import { DexError, NativeAgentConversationWatcher, NativeAgentFocusWatcher, NativeAgentLiveWatcher, NativeDeviceKeyStore, NativeHostSession, nativeAccountDeviceEnrollment, nativeKeyScope,
  type ConfigStore, type NativeAgentSocketTransport, type NativeEnrollmentAction } from '@dex/engine';
import type { NativeRpcResult, NativeSessionNotification } from './wire';
import { validateSubmitAgentTurn } from '@dex/protocol/agent-session-mutation';
import { NativeAttachmentDraftRegistry, type NativeAttachmentDraftScope, type NativeAttachmentSelectionLimits,
  type TrustedNativeAttachment } from './native-attachment-drafts';
import { parseAgentAttachmentScope, validateAgentAttachmentId } from '@dex/protocol/agent-session-attachments';

function text(p: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = p[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > 1024) throw new DexError('usage_error', '네이티브 요청의 필수 문자열을 확인하세요.');
  return value;
}
function fields(p: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(p).some((key) => !allowed.includes(key))) throw new DexError('usage_error', '지원하지 않는 네이티브 요청 항목입니다.');
}
function wipeSelected(values: readonly TrustedNativeAttachment[]): void {
  if (!Array.isArray(values)) return;
  for (let index = 0; index < values.length; index++) {
    try {
      const bytes = values[index]?.bytes;
      if (bytes instanceof Uint8Array) bytes.fill(0);
    } catch { /* trusted picker cleanup is best-effort and never exposes source values */ }
  }
}
interface Watch {
  id: string; controller: AbortController; done: Promise<void>;
}
interface PendingAttachedTurn {
  readonly digest: string;
  readonly authScope: string;
}
export interface NativeSessionHostOptions {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  expectedUserId?: string;
  /** Trusted host dependency. Request parameters can never select or configure the socket transport. */
  socket?: (origin: string) => NativeAgentSocketTransport;
  /** Trusted host picker; returned byte arrays transfer ownership and are wiped after bounded private copies are made. */
  attachmentPicker?: (signal: AbortSignal, limits: Readonly<NativeAttachmentSelectionLimits>) => Promise<readonly TrustedNativeAttachment[]>;
}

/** Host owns all credentials. Request bodies cannot change the constructor's platform. */
export class NativeSessionRpcHost {
  private readonly keys: NativeDeviceKeyStore;
  private active: AbortController | null = null;
  private watch: Watch | null = null;
  private draining: Promise<void> = Promise.resolve();
  private readonly attachmentDrafts = new NativeAttachmentDraftRegistry();
  private pendingAttachedTurn: PendingAttachedTurn | null = null;
  private closed = false;
  constructor(private readonly configs: ConfigStore, private readonly notify: (value: NativeSessionNotification) => void,
    private readonly options: NativeSessionHostOptions = {}, readonly platform: 'vscode' | 'desktop' = 'vscode') { this.keys = options.keys ?? new NativeDeviceKeyStore(); }
  cancel(): void {
    this.active?.abort(); const watch = this.watch; this.watch = null; watch?.controller.abort();
    this.attachmentDrafts.clearDrafts();
  }
  close(): void { this.closed = true; this.cancel(); this.attachmentDrafts.clear(); this.pendingAttachedTurn = null; }
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
      'native/agent-sessions', 'native/create-agent-session', 'native/switch-agent-focus', 'native/pick-attachments', 'native/attachments',
      'native/upload-attachment', 'native/recover-attachment', 'native/cancel-attachment', 'native/discard-attachments'].includes(method)) {
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
    const timeout = setTimeout(() => controller.abort(), method === 'native/upload-attachment' || method === 'native/pick-attachments' ? 120000 : 15000);
    let sessionForDrain: NativeHostSession | null = null;
    try {
      await this.stopWatch(signal); signal.throwIfAborted();
      const conversation = method === 'native/conversation' || method === 'native/watch-conversation' || method === 'native/watch-live';
      const watching = method === 'native/watch' || method === 'native/watch-conversation' || method === 'native/watch-live';
      const live = method === 'native/watch-live';
      const mutation = method === 'native/submit-turn' || method === 'native/stop-turn';
      const catalog = method === 'native/agent-sessions';
      const lifecycle = method === 'native/create-agent-session' || method === 'native/switch-agent-focus';
      const attachment = ['native/pick-attachments', 'native/attachments', 'native/upload-attachment', 'native/recover-attachment',
        'native/cancel-attachment', 'native/discard-attachments'].includes(method);
      const attachmentIndividual = ['native/upload-attachment', 'native/recover-attachment', 'native/cancel-attachment'].includes(method);
      const action = mutation || catalog || lifecycle || attachment ? method.slice(7) : watching ? 'watch' : conversation ? 'conversation' : text(p, 'action')!;
      const device = method === 'native/device'; const passwordAction = device || ['login', 'logout'].includes(action);
      const accountField = device || action === 'login' ? 'email' : 'user_id';
      fields(p, ['profile', ...(mutation ? ['user_id', 'agent_session_id', 'expected_state_version',
        ...(method === 'native/submit-turn' ? ['input_text', 'idempotency_key', 'origin_id', 'attachments'] : ['turn_id'])]
        : catalog ? ['user_id', 'limit', 'before_id']
        : lifecycle ? ['user_id', 'expected_version', 'origin_id', ...(method === 'native/create-agent-session' ? ['workflow_id', 'title'] : ['active_agent_session_id'])]
        : attachment ? ['user_id', 'agent_session_id', 'workflow_id', ...(attachmentIndividual ? ['selection_id'] : [])]
        : watching ? ['user_id', 'interval_ms'] : conversation ? ['user_id'] : ['action', accountField]),
        ...(passwordAction ? ['password'] : []), ...(device && action === 'register' ? ['device_name'] : []),
        ...(device && action === 'request-approval' ? ['approver_device_id'] : [])]);
      const account = text(p, accountField)!; const password = passwordAction ? text(p, 'password')! : '';
      const interval = watching ? p.interval_ms : undefined;
      if (interval !== undefined && (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 200 || interval > 60000)) {
        throw new DexError('usage_error', '구독 간격은 200~60000 사이의 정수 ms여야 합니다.');
      }
      if (accountField === 'user_id' && this.options.expectedUserId !== undefined && account !== this.options.expectedUserId) {
        this.attachmentDrafts.clear();
        throw new DexError('auth_required', '현재 앱에 로그인한 계정만 사용할 수 있습니다.');
      }
      const config = await this.configs.read(); signal.throwIfAborted();
      const profile = text(p, 'profile', false) ?? config.currentProfile;
      const configured = config.profiles[profile]; if (!configured) throw new DexError('not_found', 'HTTPS 서버 프로필을 먼저 설정하세요.');
      const scope = nativeKeyScope({ origin: configured.serverUrl, platform: this.platform, userId: accountField === 'email' ? '1' : account });
      const envelope = { platform_type: this.platform, profile, server_url: scope.origin };
      const publicAttachmentScopeChanged = accountField === 'user_id'
        ? this.attachmentDrafts.clearIfPublicScopeChanged(profile, scope.origin, account) : false;
      if (action === 'login' || action === 'logout' || action === 'forget-local') {
        this.attachmentDrafts.clear(); this.pendingAttachedTurn = null;
      }
      const session = new NativeHostSession(scope.origin, this.platform, this.keys, this.options.fetch, this.options.expectedUserId,
        live ? this.options.socket?.(scope.origin) : undefined);
      sessionForDrain = session;
      if (attachment) {
        const agentSessionId = text(p, 'agent_session_id')!;
        const workflowId = text(p, 'workflow_id')!;
        const selectionId = attachmentIndividual ? text(p, 'selection_id')! : undefined;
        try {
          parseAgentAttachmentScope({ origin: scope.origin, user_id: account,
            session_id: agentSessionId, workflow_id: workflowId });
          if (selectionId !== undefined) validateAgentAttachmentId(selectionId);
        } catch { throw new DexError('usage_error', '첨부 파일의 Agent 세션, 워크플로 또는 선택 ID를 확인하세요.'); }
        let authScope: string;
        try { authScope = await session.withProofSource(account, async (_proof, current) => current, signal); }
        catch {
          this.attachmentDrafts.clear(); signal.throwIfAborted();
          throw new DexError('auth_required', '현재 로그인 세션에서 첨부 파일을 다시 선택하세요.');
        }
        signal.throwIfAborted();
        const draftScope: NativeAttachmentDraftScope = {
          profile, origin: scope.origin, user_id: account, agent_session_id: agentSessionId,
          workflow_id: workflowId, auth_scope: authScope,
        };
        const result = () => ({ ...envelope, user_id: account, agent_session_id: agentSessionId,
          workflow_id: workflowId, attachments: this.attachmentDrafts.views(draftScope) });
        if (method === 'native/pick-attachments') {
          const picker = this.options.attachmentPicker;
          if (!picker) throw new DexError('protocol_mismatch', '이 네이티브 호스트는 파일 선택을 지원하지 않습니다.');
          const limits = this.attachmentDrafts.remaining(draftScope);
          if (limits.max_files === 0) throw new DexError('usage_error', '첨부 파일은 최대 10개까지 선택할 수 있습니다.');
          let selected: readonly TrustedNativeAttachment[];
          try { selected = await picker(signal, limits); }
          catch (error) {
            signal.throwIfAborted();
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            throw new DexError('usage_error', '선택한 첨부 파일을 안전하게 읽을 수 없습니다.');
          }
          try {
            signal.throwIfAborted();
            let afterPicker: string;
            try { afterPicker = await session.withProofSource(account, async (_proof, current) => current, signal); }
            catch {
              this.attachmentDrafts.clear(); signal.throwIfAborted();
              throw new DexError('auth_required', '파일을 선택하는 동안 로그인 세션이 바뀌었습니다. 다시 선택하세요.');
            }
            signal.throwIfAborted();
            if (afterPicker !== authScope) {
              this.attachmentDrafts.clear();
              throw new DexError('auth_required', '파일을 선택하는 동안 로그인 세션이 바뀌었습니다. 다시 선택하세요.');
            }
            try { this.attachmentDrafts.bind(draftScope); this.attachmentDrafts.add(draftScope, selected); }
            catch { throw new DexError('usage_error', '첨부 파일은 최대 10개, 합계 100 MiB까지 선택할 수 있습니다.'); }
            return result();
          } finally { wipeSelected(selected); }
        }
        const samePrivateScope = this.attachmentDrafts.bind(draftScope);
        if (method === 'native/attachments') return result();
        if (method === 'native/discard-attachments') {
          if (samePrivateScope) this.attachmentDrafts.discard(draftScope);
          return result();
        }
        if (!samePrivateScope || publicAttachmentScopeChanged) {
          throw new DexError('auth_required', '첨부 선택의 계정 또는 대화 범위가 바뀌었습니다. 파일을 다시 선택하세요.');
        }
        let draft: ReturnType<NativeAttachmentDraftRegistry['get']>;
        try { draft = this.attachmentDrafts.get(draftScope, selectionId!); }
        catch { throw new DexError('not_found', '선택한 첨부 파일을 찾을 수 없습니다.'); }
        const recover = async () => {
          if (!draft.attachment_id) throw new DexError('usage_error', '먼저 첨부 업로드를 시작하세요.');
          const receipt = await session.readAttachmentReceipt(account, agentSessionId, workflowId,
            draft.attachment_id, signal, authScope);
          try { this.attachmentDrafts.ready(draftScope, selectionId!, receipt); }
          catch { throw new DexError('protocol_mismatch', '서버 첨부 receipt가 선택한 파일과 일치하지 않습니다.'); }
        };
        if (method === 'native/recover-attachment') {
          await recover();
          return result();
        }
        if (method === 'native/cancel-attachment') {
          if (!draft.attachment_id) this.attachmentDrafts.removeLocal(draftScope, selectionId!);
          else {
            await session.cancelAttachment(account, agentSessionId, workflowId, draft.attachment_id, signal, authScope);
            this.attachmentDrafts.removeLocal(draftScope, selectionId!);
          }
          return result();
        }
        if (draft.status === 'uncertain') {
          throw new DexError('network_error', '업로드 결과를 먼저 복구하세요.', { outcome: 'unknown' });
        }
        if (draft.status === 'ready') {
          await recover();
          return result();
        }
        if (draft.status === 'selected') {
          const reservation = await session.reserveAttachment(account, agentSessionId, workflowId,
            draft.metadata, signal, authScope);
          try { this.attachmentDrafts.reserved(draftScope, selectionId!, reservation.attachment_id); }
          catch { throw new DexError('protocol_mismatch', '서버 첨부 예약 ID가 원래 선택과 일치하지 않습니다.'); }
          if (reservation.status === 'uploading') {
            this.attachmentDrafts.uncertain(draftScope, selectionId!, reservation.attachment_id);
            throw new DexError('network_error', '이전 첨부 업로드 결과를 먼저 복구하세요.', { outcome: 'unknown' });
          }
          if (reservation.status === 'ready') {
            this.attachmentDrafts.uncertain(draftScope, selectionId!, reservation.attachment_id);
            draft = this.attachmentDrafts.get(draftScope, selectionId!);
            await recover();
            return result();
          }
          draft = this.attachmentDrafts.get(draftScope, selectionId!);
        }
        try {
          const uploadBytes = this.attachmentDrafts.uploadBytes(draftScope, selectionId!);
          let receipt;
          try {
            receipt = await session.uploadAttachment(account, agentSessionId, workflowId,
              draft.attachment_id!, draft.metadata, uploadBytes, signal, authScope);
          } finally { uploadBytes.fill(0); }
          try { this.attachmentDrafts.ready(draftScope, selectionId!, receipt); }
          catch { throw new DexError('protocol_mismatch', '서버 첨부 receipt가 선택한 파일과 일치하지 않습니다.'); }
        } catch (error) {
          if (error instanceof DexError && error.details && typeof error.details === 'object'
            && (error.details as { outcome?: unknown }).outcome === 'unknown') {
            try { this.attachmentDrafts.uncertain(draftScope, selectionId!, draft.attachment_id); } catch { /* cancellation cleared private bytes */ }
          }
          throw error;
        }
        return result();
      }
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
        const references = method === 'native/submit-turn' && p.attachments !== undefined
          ? p.attachments as import('@dex/protocol/agent-session-mutation').SubmitAgentTurnInput['attachments'] : undefined;
        const turnDigest = method === 'native/submit-turn' ? createHash('sha256').update(JSON.stringify([
          this.platform, profile, scope.origin, account, agentSessionId, p.input_text, p.expected_state_version,
          p.idempotency_key, p.origin_id ?? null,
          references?.map((reference) => [reference.attachment_id, reference.sha256]) ?? [],
        ])).digest('hex') : undefined;
        let expectedAuthScope: string | undefined;
        if (method === 'native/submit-turn' && this.pendingAttachedTurn) {
          if (turnDigest !== this.pendingAttachedTurn.digest) {
            throw new DexError('network_error', '이전 첨부 턴의 완료 여부를 먼저 같은 요청으로 확인하세요.', { outcome: 'unknown' });
          }
          expectedAuthScope = this.pendingAttachedTurn.authScope;
        } else if (references) {
          expectedAuthScope = this.attachmentDrafts.authScopeForReferences(profile, scope.origin, account, agentSessionId, references);
          if (expectedAuthScope) this.pendingAttachedTurn = { digest: turnDigest!, authScope: expectedAuthScope };
        }
        let result;
        try {
          result = method === 'native/submit-turn'
            ? await session.submitTurn(account, agentSessionId, { input_text: p.input_text as string,
              expected_state_version: p.expected_state_version as number, idempotency_key: text(p, 'idempotency_key')!,
              ...(p.attachments !== undefined ? { attachments: p.attachments as import('@dex/protocol/agent-session-mutation').SubmitAgentTurnInput['attachments'] } : {}),
              ...(p.origin_id !== undefined ? { origin_id: text(p, 'origin_id')! } : {}) }, signal, expectedAuthScope)
            : await session.stopTurn(account, agentSessionId, { turn_id: text(p, 'turn_id')!, expected_state_version: p.expected_state_version as number }, signal);
        } catch (error) {
          if (this.pendingAttachedTurn && error instanceof DexError && error.details && typeof error.details === 'object'
            && (error.details as { outcome?: unknown }).outcome === 'rejected') this.pendingAttachedTurn = null;
          throw error;
        }
        if (method === 'native/submit-turn') this.pendingAttachedTurn = null;
        if (method === 'native/submit-turn' && references) {
          this.attachmentDrafts.releaseSubmitted(profile, scope.origin, account, agentSessionId, references);
        }
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
      if (action === 'status' && result.state !== 'active') this.attachmentDrafts.clear();
      signal.throwIfAborted(); return { ...envelope, user_id: result.user_id, result,
        ...(action === 'forget-local' ? { server_revoked: false as const } : {}) };
    } finally {
      if (sessionForDrain) this.draining = Promise.all([this.draining, sessionForDrain.settleProofOperations()]).then(() => undefined);
      clearTimeout(timeout); this.active = null;
    }
  }
}
