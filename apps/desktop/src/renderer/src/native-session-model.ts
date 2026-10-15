import { parseAgentFocus, type AgentFocus, type OwnedAgentSession } from '@dex/protocol/agent-session';
import { parseAgentSessionCatalogPage } from '@dex/protocol/agent-session-catalog';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import {
  parseCreatedAgentSession,
  parseSwitchedAgentFocus,
  validateCreateAgentSession,
  validateSwitchAgentFocus,
} from '@dex/protocol/agent-session-lifecycle';
import {
  AgentTurnComposer,
  AgentTurnComposeFailure,
  type AgentTurnComposerView,
  type AgentTurnScope,
} from '@dex/protocol/agent-turn-composer';
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  parseAgentAttachmentReceipt,
  prepareAgentAttachmentReferences,
  validateAgentAttachmentId,
  validateReserveAgentAttachment,
  type AgentAttachmentReceipt,
  type AgentAttachmentScope,
  type AgentAttachmentReference,
} from '@dex/protocol/agent-session-attachments';
import type { NativeAttachmentDraftView, NativeConversationView, NativeRpcResult } from '@dex/rpc';
import type { DesktopNativeBridge, DesktopNativeMethod, DesktopNativeNotice } from '../../native-session-types';

export interface DesktopNativeView {
  busy: boolean;
  result: NativeRpcResult | null;
  focus: AgentFocus | null;
  conversation: NativeConversationView | null;
  hasMore: boolean;
  connection: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'stopped';
  transport: 'none' | 'focus-http' | 'read-http' | 'poll-http' | 'live-wss';
  error: string;
  turn: AgentTurnComposerView;
  attachments: {
    items: readonly NativeAttachmentDraftView[];
    busy: boolean;
    notice: string;
  };
  catalog: {
    focus: AgentFocus | null;
    items: OwnedAgentSession[];
    nextCursor: string | null;
    hasMore: boolean;
    olderPage: boolean;
    pageKnown: boolean;
    busy: boolean;
    writeBlocked: boolean;
    notice: string;
  };
}
type DesktopNativeSessionState = Omit<DesktopNativeView, 'turn'>;
type DesktopReadMethod = Exclude<DesktopNativeMethod,
  'submit-turn' | 'stop-turn' | 'agent-sessions' | 'create-agent-session' | 'switch-agent-focus'
  | 'pick-attachments' | 'attachments' | 'upload-attachment' | 'recover-attachment' | 'cancel-attachment'
  | 'discard-attachments'>;
type DesktopWatchMethod = Extract<DesktopReadMethod, 'watch' | 'watch-conversation' | 'watch-live'>;
const empty = (): DesktopNativeSessionState => ({ busy: false, result: null, focus: null, conversation: null, hasMore: false,
  connection: 'idle', transport: 'none', error: '', catalog: { focus: null, items: [], nextCursor: null, hasMore: false,
    olderPage: false, pageKnown: false, busy: false, writeBlocked: false, notice: '' },
  attachments: { items: Object.freeze([]), busy: false, notice: '' } });

interface DesktopAttachmentTarget {
  scope: AgentTurnScope;
  sessionId: string;
  workflowId: string;
}

const TURN_DRAFT_LOCKS = new Set<AgentTurnComposerView['status']>([
  'unknown', 'sending', 'stopping', 'accepted', 'stop-requested',
]);

function attachmentRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError();
    result[key] = descriptor.value;
  }
  return result;
}
export class DesktopNativeSessionModel {
  private generation = 0;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private watchMethod: DesktopWatchMethod | null = null;
  private restoreLiveAfterCatalog = false;
  private waiting = false;
  private mutating = false;
  private disposed = false;
  private turnSessionId: string | null = null;
  private turnContextGeneration = 0;
  private focusNoticeRevision = 0;
  private noticedFocus: AgentFocus | null = null;
  private selectionNoticeRevision = 0;
  private noticedSessionId: string | null | undefined;
  private attachmentGeneration = 0;
  private attachmentTarget: DesktopAttachmentTarget | null = null;
  private buffered: DesktopNativeNotice | null = null;
  private turnView!: AgentTurnComposerView;
  private sessionState = empty();
  private readonly composer: AgentTurnComposer;
  private readonly remove: () => void;
  state!: DesktopNativeView;
  constructor(private readonly bridge: DesktopNativeBridge, private readonly render: (state: DesktopNativeView) => void) {
    this.composer = new AgentTurnComposer(async (request) => {
      const selected = this.sessionState.result;
      if (!selected || selected.platform_type !== 'desktop' || request.scope.platform_type !== 'desktop'
        || selected.profile !== request.scope.profile || selected.server_url !== request.scope.server_url
        || selected.user_id !== request.scope.user_id
        || this.sessionState.conversation?.snapshot?.id !== request.agent_session_id) {
        throw new AgentTurnComposeFailure('unavailable');
      }
      const reply = await this.bridge.request(request.operation === 'submit' ? 'submit-turn' : 'stop-turn', {
        agent_session_id: request.agent_session_id,
        ...request.input,
      });
      if (reply.ok) return reply.value;
      if (reply.outcome === 'rejected') {
        const conflict = reply.conflict && reply.conflict.code !== 'FOCUS_VERSION_CONFLICT' ? reply.conflict : undefined;
        throw new AgentTurnComposeFailure('rejected', conflict);
      }
      if (reply.outcome === 'unknown') throw new AgentTurnComposeFailure('unknown');
      throw new AgentTurnComposeFailure('unavailable');
    }, (turn) => { this.turnView = turn; if (this.state) this.publish(); });
    this.turnView = this.composer.view; this.publish();
    this.remove = bridge.onUpdate((notice) => this.notice(notice));
  }
  private publish(): void {
    this.state = { ...this.sessionState, turn: this.turnView };
    if (!this.disposed) this.render(this.state);
  }
  private show(patch: Partial<DesktopNativeSessionState>): void { this.sessionState = { ...this.sessionState, ...patch }; this.publish(); }
  private clearWatch(): void {
    this.watchId = null; this.watchView = null; this.watchMethod = null; this.waiting = false; this.buffered = null;
  }
  private resetTurn(): void {
    this.turnContextGeneration++; this.turnSessionId = null;
    this.clearAttachmentDraft(true); this.composer.reset();
  }
  clear(): void {
    this.generation++; this.focusNoticeRevision++; this.noticedFocus = null;
    this.selectionNoticeRevision++; this.noticedSessionId = undefined; this.restoreLiveAfterCatalog = false;
    this.clearWatch(); this.resetTurn(); this.sessionState = empty(); this.publish();
  }
  dispose(): void { this.disposed = true; this.clear(); this.remove(); void this.bridge.request('cancel').catch(() => {}); }
  async stopWatch(): Promise<void> {
    if (this.disposed || this.mutating) return;
    const generation = ++this.generation; const watchId = this.watchId; const pendingWatch = this.waiting;
    this.clearWatch(); this.show({ busy: Boolean(watchId || pendingWatch), focus: null, conversation: null, hasMore: false,
      connection: 'idle', transport: 'none', error: '' });
    this.context(null, false);
    if (!watchId && !pendingWatch) return;
    try {
      const reply = await this.bridge.request(pendingWatch ? 'cancel' : 'unwatch', watchId ? { watch_id: watchId } : {});
      if (generation === this.generation && !reply.ok) throw new Error(reply.message);
    } catch (error) {
      if (generation === this.generation) this.show({ connection: 'stopped', error: error instanceof Error ? error.message : '대화 폴링을 중단하지 못했습니다.' });
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async execute(method: DesktopReadMethod, params: Record<string, unknown> = {}): Promise<NativeRpcResult | null> {
    if (this.disposed) return null;
    if (method === 'cancel' && this.sessionState.attachments.items.length && TURN_DRAFT_LOCKS.has(this.turnView.status)) {
      return null;
    }
    if (this.mutating) {
      if (method === 'cancel') {
        this.clearAttachmentDraft(false);
        const reply = await this.bridge.request('cancel');
        if (!reply.ok) this.show({ error: reply.message });
      }
      return null;
    }
    if (method === 'cancel') this.clearAttachmentDraft(false);
    return this.run(method, params, false);
  }
  async refreshAgentSessions(): Promise<boolean> {
    if (this.disposed || this.mutating || this.sessionState.busy || !this.scope()) return false;
    const generation = ++this.generation;
    const resume = this.watchMethod === 'watch-live' || this.restoreLiveAfterCatalog;
    const previousId = this.sessionState.catalog.focus?.active_agent_session_id ?? this.turnSessionId;
    this.mutating = true; this.clearWatch();
    this.show({ busy: true, catalog: { ...this.sessionState.catalog, busy: true, notice: '' }, error: '' });
    try {
      const reply = await this.bridge.request('agent-sessions', { limit: 100 });
      if (generation !== this.generation || !reply.ok) {
        if (generation === this.generation && !reply.ok) throw new Error(reply.message);
        return false;
      }
      if (!('user_id' in reply.value)) throw new Error('Desktop Agent 세션 응답을 확인할 수 없습니다.');
      const result = this.validatedScope(reply.value);
      const focus = parseAgentFocus(result.focus);
      const sessions = parseAgentSessionCatalogPage(result.sessions);
      const changed = previousId !== focus.active_agent_session_id;
      if (changed) this.resetTurn();
      this.show({ result: { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
        result: this.sessionState.result?.result }, focus,
        ...(changed ? { conversation: null, hasMore: false, connection: 'connected' as const, transport: 'none' as const } : {}),
        catalog: { focus, items: sessions.items, nextCursor: sessions.next_cursor, hasMore: sessions.has_more, olderPage: false, pageKnown: true,
          busy: false, writeBlocked: false, notice: 'Agent 세션 목록과 현재 포커스를 다시 확인했습니다.' } });
      if (focus.active_agent_session_id) await this.recoverConversation(this.scope()!, resume ? 'watch-live' : null);
      this.restoreLiveAfterCatalog = false;
      return true;
    } catch (error) {
      if (generation === this.generation) this.show({ catalog: { ...this.sessionState.catalog, busy: false,
        notice: 'Agent 세션 목록을 확인하지 못했습니다. 현재 페이지를 유지합니다.' } });
      return false;
    } finally {
      this.mutating = false;
      if (generation === this.generation) this.show({ busy: false });
    }
  }
  async loadOlderAgentSessions(): Promise<boolean> {
    const catalog = this.sessionState.catalog; const scope = this.scope();
    if (this.disposed || this.mutating || this.sessionState.busy || catalog.busy || !scope || !catalog.focus
      || !catalog.hasMore || !catalog.nextCursor) return false;
    const generation = ++this.generation; const beforeId = catalog.nextCursor;
    const previousItems = catalog.items; const previousFocus = catalog.focus;
    const focusNoticeRevision = this.focusNoticeRevision;
    const selectionNoticeRevision = this.selectionNoticeRevision;
    this.mutating = true;
    this.show({ busy: true, catalog: { ...catalog, busy: true, notice: '' }, error: '' });
    try {
      const reply = await this.bridge.request('agent-sessions', { limit: 100, before_id: beforeId });
      if (generation !== this.generation) return false;
      if (!reply.ok) throw new Error();
      if (!('user_id' in reply.value)) throw new Error();
      const result = this.validatedScope(reply.value);
      const responseFocus = parseAgentFocus(result.focus);
      if (selectionNoticeRevision !== this.selectionNoticeRevision
        && this.noticedSessionId !== undefined
        && previousFocus.active_agent_session_id !== this.noticedSessionId) {
        const observedFocus = responseFocus.active_agent_session_id === this.noticedSessionId ? responseFocus : null;
        this.clearWatch();
        this.show({ focus: observedFocus, connection: 'connected', transport: 'none',
          catalog: { focus: observedFocus, items: [], nextCursor: null, hasMore: false, olderPage: false, pageKnown: false,
            busy: false, writeBlocked: true,
            notice: '다른 클라이언트에서 현재 대화가 바뀌었습니다. 최신 Agent 세션 목록을 다시 확인해 주세요.' } });
        return false;
      }
      const focus = focusNoticeRevision !== this.focusNoticeRevision && this.noticedFocus
        && !this.sameFocus(previousFocus, this.noticedFocus) ? this.noticedFocus : responseFocus;
      if (!this.sameFocus(previousFocus, focus)) {
        const changedSession = previousFocus.active_agent_session_id !== focus.active_agent_session_id;
        if (changedSession) this.resetTurn();
        else this.context(null, false);
        this.clearWatch();
        this.show({ focus, conversation: null, hasMore: false, connection: 'connected', transport: 'none',
          catalog: { focus, items: [], nextCursor: null, hasMore: false, olderPage: false, pageKnown: false, busy: false, writeBlocked: true,
            notice: '다른 클라이언트에서 포커스가 바뀌었습니다. 최신 Agent 세션 목록을 다시 확인해 주세요.' } });
        return false;
      }
      const sessions = parseAgentSessionCatalogPage(result.sessions, beforeId, previousItems);
      this.show({ catalog: { ...this.sessionState.catalog, focus, items: sessions.items, nextCursor: sessions.next_cursor,
        hasMore: sessions.has_more, olderPage: true, pageKnown: true, busy: false,
        notice: '이전 Agent 세션 페이지를 확인했습니다.' } });
      return true;
    } catch {
      if (generation === this.generation) this.show({ catalog: { ...this.sessionState.catalog, busy: false,
        notice: '이전 Agent 세션 페이지를 확인하지 못했습니다. 현재 페이지를 유지합니다.' } });
      return false;
    } finally {
      this.mutating = false;
      if (generation === this.generation) this.show({ busy: false });
    }
  }
  async createAgentSession(workflowId: string, title?: string): Promise<boolean> {
    const catalog = this.writableCatalog(); if (!catalog) return false;
    let input;
    try { input = validateCreateAgentSession({ workflow_id: workflowId, title: title ?? '', expected_version: catalog.focus.version }); }
    catch { this.show({ error: 'Agent 세션 입력 형식을 확인하세요.' }); return false; }
    return this.lifecycleWrite('create-agent-session', input, (result) => parseCreatedAgentSession(result.created, input).focus);
  }
  async switchAgentFocus(agentSessionId: string | null): Promise<boolean> {
    const catalog = this.writableCatalog(); if (!catalog) return false;
    if (agentSessionId !== null && !catalog.items.some((item) => item.id === agentSessionId && item.status === 'active')) {
      this.show({ error: '새로 확인한 내 활성 Agent 세션만 선택할 수 있습니다.' }); return false;
    }
    let input;
    try { input = validateSwitchAgentFocus({ active_agent_session_id: agentSessionId, expected_version: catalog.focus.version }); }
    catch { this.show({ error: 'Agent 세션 입력 형식을 확인하세요.' }); return false; }
    return this.lifecycleWrite('switch-agent-focus', input, (result) => parseSwitchedAgentFocus(result.focus, input));
  }
  private async run(method: DesktopReadMethod, params: Record<string, unknown>, recovering: boolean): Promise<NativeRpcResult | null> {
    if (this.mutating && !recovering) return null;
    const generation = ++this.generation;
    const resetsTurn = method === 'session' && ['login', 'logout', 'forget-local'].includes(String(params.action));
    if (resetsTurn) this.resetTurn();
    else this.composer.context(this.scope(), this.sessionState.conversation?.snapshot ?? null, false);
    this.clearWatch(); this.waiting = method === 'watch' || method === 'watch-conversation' || method === 'watch-live';
    this.show({ busy: true, focus: null, conversation: null, hasMore: false,
      connection: this.waiting || method === 'conversation' ? 'waiting' : 'idle',
      transport: method === 'watch' ? 'focus-http' : method === 'conversation' ? 'read-http'
        : method === 'watch-conversation' ? 'poll-http' : method === 'watch-live' ? 'live-wss' : 'none', error: '' });
    try {
      const reply = await this.bridge.request(method, params);
      if (generation !== this.generation) {
        if ((method === 'watch' || method === 'watch-conversation' || method === 'watch-live') && reply.ok && 'watch_id' in reply.value
          && this.validWatchId(reply.value.watch_id)) {
          void this.bridge.request('unwatch', { watch_id: reply.value.watch_id }).catch(() => {});
        }
        return null;
      }
      if (!reply.ok) throw new Error(reply.message);
      if (!('user_id' in reply.value)) {
        if (method === 'cancel') {
          this.clearAttachmentDraft(false);
          this.clearWatch(); this.show({ focus: null, conversation: null, hasMore: false, connection: 'idle', transport: 'none' });
          this.context(null, false); return null;
        }
        this.clear(); return null;
      }
      let result = this.validatedScope(reply.value);
      if (method === 'conversation') {
        if (result.view !== 'conversation' || typeof result.has_more !== 'boolean') throw new Error('현재 공유 대화 응답을 확인할 수 없습니다.');
        const conversation = parseAgentConversationView(result.conversation);
        result = { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
          view: 'conversation', conversation, has_more: result.has_more };
        const selectedResult = { ...result, result: this.state.result?.result };
        this.sessionState = { ...this.sessionState, result: selectedResult };
        this.context(conversation, true);
        this.show({ result: selectedResult, conversation, hasMore: result.has_more, connection: 'connected' });
      } else if (method !== 'watch' && method !== 'watch-conversation' && method !== 'watch-live') {
        this.show({ result: result.result !== undefined ? result : this.state.result ?? result });
      }
      if (method === 'watch' || method === 'watch-conversation' || method === 'watch-live') {
        const watchId = result.watch_id;
        if (!this.validWatchId(watchId)) throw new Error('구독을 시작하지 못했습니다.');
        if ((method === 'watch-conversation' || method === 'watch-live') && result.view !== 'conversation') throw new Error('현재 공유 대화 구독 응답을 확인할 수 없습니다.');
        result = { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
          watch_id: watchId, ...(method === 'watch-conversation' || method === 'watch-live' ? { view: 'conversation' as const } : {}) };
        this.watchId = watchId; this.watchView = method === 'watch-conversation' || method === 'watch-live' ? 'conversation' : 'focus';
        this.watchMethod = method; this.waiting = false;
        // Use the watch ACK account/origin as the scope, preserving only its public session detail.
        this.show({ result: { ...result, result: this.state.result?.result } });
        const buffered = this.buffered; this.buffered = null; if (buffered) this.notice(buffered);
      }
      return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.clearWatch(); this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false,
        error: error instanceof Error ? error.message : '기기·세션 확인에 실패했습니다.' });
      if (!resetsTurn) this.context(null, false);
      return null;
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  private notice(notice: DesktopNativeNotice): void {
    if (this.disposed) return;
    if (notice.type === 'cleared') { this.clear(); return; }
    if (this.waiting) { this.buffered = notice; return; }
    const value = notice.value; const selected = this.state.result;
    if (!this.watchId || value.watch_id !== this.watchId || value.platform_type !== 'desktop' || value.profile !== 'desktop'
      || value.server_url !== selected?.server_url || value.update.user_id !== selected?.user_id
      || (this.watchView === 'conversation') !== ('view' in value && value.view === 'conversation')) return;
    const update = value.update;
    if ('view' in value && value.view === 'conversation' && update.type === 'conversation') {
      try {
        const conversation = parseAgentConversationView(update.conversation);
        if (typeof update.has_more !== 'boolean' || !['snapshot', 'replay', 'recovered'].includes(update.source)) throw new Error();
        const noticedSessionId = conversation.snapshot?.id ?? null;
        const changedSelection = this.sessionState.catalog.focus
          && noticedSessionId !== this.sessionState.catalog.focus.active_agent_session_id;
        if (changedSelection) {
          this.selectionNoticeRevision++; this.noticedSessionId = noticedSessionId;
        }
        this.context(conversation, true);
        this.show({ connection: 'connected', focus: null, conversation, hasMore: update.has_more,
          ...(changedSelection ? { catalog: { ...this.sessionState.catalog, focus: null, items: [], nextCursor: null,
            hasMore: false, olderPage: false, pageKnown: false, writeBlocked: true,
            notice: '다른 클라이언트에서 현재 대화가 바뀌었습니다. 최신 Agent 세션 목록을 다시 확인해 주세요.' } } : {}) });
      } catch { this.rejectWatch('현재 공유 대화 응답을 확인할 수 없습니다.'); }
    } else if (!('view' in value) && update.type === 'focus') {
      try {
        const focus = parseAgentFocus(update.focus);
        const changedFocus = this.sessionState.catalog.focus
          && !this.sameFocus(this.sessionState.catalog.focus, focus);
        this.focusNoticeRevision++; this.noticedFocus = focus;
        if (focus.active_agent_session_id !== this.turnSessionId) this.resetTurn();
        else this.context(null, false);
        this.show({ connection: 'connected', focus,
          ...(changedFocus ? { catalog: { ...this.sessionState.catalog, focus, items: [], nextCursor: null,
            hasMore: false, olderPage: false, pageKnown: false, writeBlocked: true,
            notice: '다른 클라이언트에서 포커스가 바뀌었습니다. 최신 Agent 세션 목록을 다시 확인해 주세요.' } } : {}) });
      }
      catch {
        this.rejectWatch('현재 대화 응답을 확인할 수 없습니다.');
      }
    } else if (update.type === 'reset') {
      this.show({ connection: 'waiting', focus: null, conversation: null, hasMore: false }); this.context(null, false);
    } else if (update.type === 'reconnecting') {
      this.show({ connection: 'reconnecting', focus: null, conversation: null, hasMore: false }); this.context(null, false);
    } else if (update.type === 'stopped') {
      this.clearWatch(); this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false });
      this.context(null, false);
    }
  }
  private validWatchId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
  }
  private rejectWatch(message: string): void {
    const watchId = this.watchId; this.clearWatch();
    this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false, error: message });
    this.context(null, false);
    if (watchId) void this.bridge.request('unwatch', { watch_id: watchId }).catch(() => {});
  }
  async pickAttachments(): Promise<boolean> {
    return this.attachmentMutation('pick-attachments');
  }
  async uploadAttachment(selectionId: string): Promise<boolean> {
    const item = this.sessionState.attachments.items.find((candidate) => candidate.selection_id === selectionId);
    if (!item || (item.status !== 'selected' && item.status !== 'reserved')) return false;
    return this.attachmentMutation('upload-attachment', selectionId);
  }
  async recoverAttachment(selectionId: string): Promise<boolean> {
    let item = this.sessionState.attachments.items.find((candidate) => candidate.selection_id === selectionId);
    if (!item || item.status !== 'uncertain') return false;
    if (!item.attachment_id) {
      if (!await this.attachmentMutation('attachments')) return false;
      item = this.sessionState.attachments.items.find((candidate) => candidate.selection_id === selectionId);
      if (!item) return false;
      if (item.status !== 'uncertain' || !item.attachment_id) return item.status === 'selected'
        || item.status === 'reserved' || item.status === 'ready';
    }
    return this.attachmentMutation('recover-attachment', selectionId);
  }
  async cancelAttachment(selectionId: string): Promise<boolean> {
    if (!this.sessionState.attachments.items.some((candidate) => candidate.selection_id === selectionId)) return false;
    return this.attachmentMutation('cancel-attachment', selectionId);
  }
  async discardAttachments(): Promise<boolean> {
    if (!this.sessionState.attachments.items.length) return false;
    return this.attachmentMutation('discard-attachments');
  }
  async submitTurn(input: string): Promise<boolean> {
    const attachments = this.turnAttachmentReferences();
    if (attachments === null) return false;
    return this.mutate(async () => {
      const receipt = await this.composer.submit(input, attachments.length ? attachments : undefined);
      if (receipt) await this.releaseAcceptedAttachments();
      return receipt;
    });
  }
  async retryTurn(): Promise<boolean> {
    return this.mutate(async () => {
      const receipt = await this.composer.retry();
      if (receipt && this.turnView.request?.operation === 'submit') await this.releaseAcceptedAttachments();
      return receipt;
    });
  }
  async stopTurn(): Promise<boolean> { return this.mutate(() => this.composer.stop()); }

  private currentAttachmentTarget(): DesktopAttachmentTarget | null {
    const scope = this.scope(); const snapshot = this.sessionState.conversation?.snapshot;
    if (!scope || !snapshot || snapshot.id !== this.turnSessionId) return null;
    return { scope, sessionId: snapshot.id, workflowId: snapshot.workflow_id };
  }

  private sameAttachmentTarget(left: DesktopAttachmentTarget, right: DesktopAttachmentTarget): boolean {
    return left.sessionId === right.sessionId && left.workflowId === right.workflowId
      && left.scope.platform_type === right.scope.platform_type && left.scope.profile === right.scope.profile
      && left.scope.server_url === right.scope.server_url && left.scope.user_id === right.scope.user_id;
  }

  private attachmentScope(target: DesktopAttachmentTarget): AgentAttachmentScope {
    return { origin: target.scope.server_url, user_id: target.scope.user_id,
      session_id: target.sessionId, workflow_id: target.workflowId };
  }

  private clearAttachmentDraft(discardHost: boolean): void {
    const target = this.attachmentTarget;
    const pending = this.sessionState.attachments.busy;
    const hadDraft = this.sessionState.attachments.items.length > 0 || this.sessionState.attachments.busy;
    this.attachmentGeneration++;
    this.attachmentTarget = null;
    if (hadDraft || this.sessionState.attachments.notice) {
      this.show({ attachments: { items: Object.freeze([]), busy: false, notice: '' } });
    }
    if (discardHost && target && hadDraft) {
      const params = { agent_session_id: target.sessionId, workflow_id: target.workflowId };
      void (pending
        ? this.bridge.request('cancel')
        : this.bridge.request('discard-attachments', params)).catch(() => {});
    }
  }

  private parseAttachmentViews(value: NativeRpcResult, target: DesktopAttachmentTarget): readonly NativeAttachmentDraftView[] {
    if (value.agent_session_id !== target.sessionId || value.workflow_id !== target.workflowId
      || !Array.isArray(value.attachments) || value.attachments.length > AGENT_ATTACHMENT_MAX_COUNT) throw new TypeError();
    const expected = this.attachmentScope(target); const selections = new Set<string>(); const attachmentIds = new Set<string>();
    let total = 0; const result: NativeAttachmentDraftView[] = [];
    for (let index = 0; index < value.attachments.length; index++) {
      if (!(index in value.attachments)) throw new TypeError();
      const raw = attachmentRecord(value.attachments[index]);
      const allowed = ['selection_id', 'filename', 'size_bytes', 'media_type', 'sha256', 'status', 'attachment_id', 'receipt'];
      if (!Reflect.ownKeys(raw).every((key) => typeof key === 'string' && allowed.includes(key))
        || typeof raw.selection_id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(raw.selection_id)
        || !['selected', 'reserved', 'uncertain', 'ready'].includes(String(raw.status))) throw new TypeError();
      const metadata = validateReserveAgentAttachment(expected, { upload_key: raw.selection_id,
        filename: raw.filename, size_bytes: raw.size_bytes, media_type: raw.media_type, sha256: raw.sha256 });
      total += metadata.size_bytes;
      if (total > AGENT_ATTACHMENT_MAX_TOTAL_BYTES || selections.has(raw.selection_id)) throw new TypeError();
      selections.add(raw.selection_id);
      const status = raw.status as NativeAttachmentDraftView['status'];
      let attachmentId: string | undefined;
      if (raw.attachment_id !== undefined) {
        attachmentId = validateAgentAttachmentId(raw.attachment_id);
        if (attachmentIds.has(attachmentId)) throw new TypeError();
        attachmentIds.add(attachmentId);
      }
      if (status === 'selected' && attachmentId !== undefined) throw new TypeError();
      if (status === 'reserved' && attachmentId === undefined) throw new TypeError();
      let receipt: AgentAttachmentReceipt | undefined;
      if (status === 'ready') {
        if (!attachmentId || raw.receipt === undefined) throw new TypeError();
        receipt = parseAgentAttachmentReceipt(raw.receipt, expected);
        if (receipt.attachment_id !== attachmentId || receipt.filename !== metadata.filename
          || receipt.size_bytes !== metadata.size_bytes || receipt.media_type !== metadata.media_type
          || receipt.sha256 !== metadata.sha256) throw new TypeError();
      } else if (raw.receipt !== undefined) throw new TypeError();
      result.push(Object.freeze({ selection_id: raw.selection_id, filename: metadata.filename,
        size_bytes: metadata.size_bytes, media_type: metadata.media_type, sha256: metadata.sha256, status,
        ...(attachmentId ? { attachment_id: attachmentId } : {}), ...(receipt ? { receipt } : {}) }));
    }
    return Object.freeze(result);
  }

  private async attachmentMutation(
    method: 'pick-attachments' | 'attachments' | 'upload-attachment' | 'recover-attachment' | 'cancel-attachment' | 'discard-attachments',
    selectionId?: string,
  ): Promise<boolean> {
    const target = this.currentAttachmentTarget();
    if (this.disposed || this.mutating || this.sessionState.busy || !target || !this.turnView.canSubmit
      || TURN_DRAFT_LOCKS.has(this.turnView.status)) return false;
    if (this.attachmentTarget && !this.sameAttachmentTarget(this.attachmentTarget, target)) {
      this.clearAttachmentDraft(true); return false;
    }
    const operationGeneration = ++this.attachmentGeneration; const generation = ++this.generation;
    const resume = this.watchMethod && this.watchView === 'conversation' ? this.watchMethod : null;
    this.mutating = true; this.clearWatch(); this.attachmentTarget = target;
    this.show({ busy: true, error: '', attachments: { ...this.sessionState.attachments, busy: true, notice: '' } });
    try {
      const reply = await this.bridge.request(method, { agent_session_id: target.sessionId, workflow_id: target.workflowId,
        ...(selectionId ? { selection_id: selectionId } : {}) });
      if (generation !== this.generation || operationGeneration !== this.attachmentGeneration
        || !this.sameScope(target.scope)) return false;
      if (!reply.ok) {
        if (reply.outcome === 'unknown' && selectionId) {
          let items: readonly NativeAttachmentDraftView[] = Object.freeze(this.sessionState.attachments.items.map((item) => item.selection_id === selectionId
            ? Object.freeze({ ...item, status: 'uncertain' as const, receipt: undefined }) : item));
          try {
            const observed = await this.bridge.request('attachments', {
              agent_session_id: target.sessionId, workflow_id: target.workflowId,
            });
            if (generation !== this.generation || operationGeneration !== this.attachmentGeneration
              || !this.sameScope(target.scope) || !this.attachmentTarget
              || !this.sameAttachmentTarget(this.attachmentTarget, target)) return false;
            if (observed.ok && 'user_id' in observed.value) {
              items = this.parseAttachmentViews(this.validatedScope(observed.value), target);
            }
          } catch { /* retain the last safe local view */ }
          if (generation !== this.generation || operationGeneration !== this.attachmentGeneration
            || !this.sameScope(target.scope) || !this.attachmentTarget
            || !this.sameAttachmentTarget(this.attachmentTarget, target)) return false;
          this.show({ attachments: { items, busy: false,
            notice: '업로드 또는 취소 결과를 확인할 수 없습니다. 서버 영수증을 복구하거나 다시 취소해 주세요.' } });
        } else {
          this.show({ attachments: { ...this.sessionState.attachments, busy: false,
            notice: method === 'recover-attachment'
              ? '첨부 영수증을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.'
              : method === 'pick-attachments'
                ? '첨부 파일을 선택하지 못했습니다.' : '첨부 작업을 완료하지 못했습니다.' } });
        }
        if (generation === this.generation && operationGeneration === this.attachmentGeneration) {
          await this.recoverConversation(target.scope, resume);
        }
        return false;
      }
      if (!('user_id' in reply.value)) throw new TypeError();
      const scoped = this.validatedScope(reply.value);
      const items = this.parseAttachmentViews(scoped, target);
      this.attachmentTarget = items.length ? target : null;
      this.show({ attachments: { items, busy: false, notice: method === 'pick-attachments'
        ? (items.length ? `${items.length}개 파일을 선택했습니다.` : '선택한 파일이 없습니다.')
        : method === 'attachments' ? '첨부 파일 상태를 다시 확인했습니다.'
        : method === 'upload-attachment' ? '첨부 파일 업로드를 확인했습니다.'
          : method === 'recover-attachment' ? '첨부 파일 영수증을 복구했습니다.'
            : method === 'cancel-attachment' ? '첨부 파일을 취소했습니다.' : '선택한 첨부 파일을 모두 지웠습니다.' } });
      await this.recoverConversation(target.scope, resume);
      return true;
    } catch {
      if (generation === this.generation && operationGeneration === this.attachmentGeneration) {
        this.show({ attachments: { ...this.sessionState.attachments, busy: false,
          notice: '첨부 응답을 확인할 수 없습니다. 파일을 다시 선택해 주세요.' } });
        await this.recoverConversation(target.scope, resume);
      }
      return false;
    } finally {
      this.mutating = false;
      if (generation === this.generation && operationGeneration === this.attachmentGeneration) {
        this.show({ busy: false, attachments: { ...this.sessionState.attachments, busy: false } });
      }
    }
  }

  private turnAttachmentReferences(): readonly AgentAttachmentReference[] | null {
    const items = this.sessionState.attachments.items;
    if (!items.length) return Object.freeze([]);
    const target = this.currentAttachmentTarget();
    if (!target || !this.attachmentTarget || !this.sameAttachmentTarget(this.attachmentTarget, target)
      || items.some((item) => item.status !== 'ready' || !item.receipt)) {
      this.show({ attachments: { ...this.sessionState.attachments,
        notice: '선택한 모든 파일의 업로드와 영수증 확인을 완료한 뒤 턴을 보내세요.' } });
      return null;
    }
    try { return prepareAgentAttachmentReferences(items.map((item) => item.receipt), this.attachmentScope(target)); }
    catch {
      this.show({ attachments: { ...this.sessionState.attachments,
        notice: '첨부 영수증이 선택한 파일과 일치하지 않습니다. 파일을 다시 선택해 주세요.' } });
      return null;
    }
  }

  private async releaseAcceptedAttachments(): Promise<void> {
    const target = this.attachmentTarget;
    if (!target || !this.sessionState.attachments.items.length) return;
    this.clearAttachmentDraft(false);
    try { await this.bridge.request('discard-attachments', {
      agent_session_id: target.sessionId, workflow_id: target.workflowId,
    }); } catch { /* an accepted turn has already released its submitted host references */ }
  }
  private scope(): AgentTurnScope | null {
    const selected = this.sessionState.result;
    if (!selected) return null;
    return { platform_type: 'desktop', profile: selected.profile, server_url: selected.server_url, user_id: selected.user_id };
  }
  private context(conversation: NativeConversationView | null, available: boolean): void {
    const selected = this.scope();
    const nextSessionId = conversation?.snapshot?.id ?? null;
    if (available && selected && conversation?.snapshot) {
      const target = { scope: selected, sessionId: conversation.snapshot.id, workflowId: conversation.snapshot.workflow_id };
      if (this.attachmentTarget && !this.sameAttachmentTarget(this.attachmentTarget, target)) {
        this.clearAttachmentDraft(true);
      }
    }
    if (available && this.turnSessionId !== null && nextSessionId !== this.turnSessionId) this.turnContextGeneration++;
    this.composer.context(selected, conversation?.snapshot ?? null, available && selected !== null);
    if (available) this.turnSessionId = nextSessionId;
  }
  private async mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (this.disposed || this.mutating || this.sessionState.busy) return false;
    const scope = this.scope(); const snapshot = this.sessionState.conversation?.snapshot;
    if (!scope || !snapshot) return false;
    const turnContextGeneration = this.turnContextGeneration;
    const resume = this.watchMethod && this.watchView === 'conversation' ? this.watchMethod : null;
    this.mutating = true; const generation = ++this.generation; this.clearWatch(); this.show({ busy: true, error: '' });
    let receipt: unknown = null; let recover = true;
    try {
      try { receipt = await action(); } catch (error) {
        if (error instanceof TypeError) {
          recover = false; this.show({ error: '대화 입력 형식을 확인하세요.' });
        } else if (!(error instanceof AgentTurnComposeFailure)) throw error;
      }
      if (recover && generation === this.generation && turnContextGeneration === this.turnContextGeneration && this.sameScope(scope)) {
        await this.recoverConversation(scope, resume);
      }
      return receipt !== null && !this.disposed && turnContextGeneration === this.turnContextGeneration && this.sameScope(scope);
    } finally {
      this.mutating = false; this.show({ busy: false });
    }
  }
  private sameScope(scope: AgentTurnScope): boolean {
    const selected = this.sessionState.result;
    return selected?.platform_type === 'desktop' && selected.profile === scope.profile
      && selected.server_url === scope.server_url && selected.user_id === scope.user_id;
  }
  private sameFocus(left: AgentFocus, right: AgentFocus): boolean {
    return left.active_agent_session_id === right.active_agent_session_id
      && left.version === right.version && left.event_id === right.event_id;
  }
  private async recoverConversation(scope: AgentTurnScope, resume: DesktopWatchMethod | null): Promise<void> {
    const read = await this.run('conversation', {}, true);
    if (!read || !this.sameScope(scope) || this.sessionState.conversation?.snapshot?.id === undefined) return;
    const snapshot = this.sessionState.conversation.snapshot;
    if (snapshot && this.sessionState.catalog.focus?.active_agent_session_id === snapshot.id) {
      const item: OwnedAgentSession = { id: snapshot.id, workflow_id: snapshot.workflow_id, title: snapshot.title,
        status: 'active', current_sequence: snapshot.current_sequence, state_version: snapshot.state_version };
      const present = this.sessionState.catalog.items.some((candidate) => candidate.id === item.id);
      this.show({ catalog: { ...this.sessionState.catalog,
        items: present
          ? this.sessionState.catalog.items.map((candidate) => candidate.id === item.id ? item : candidate)
          : !this.sessionState.catalog.pageKnown && this.sessionState.catalog.items.length < 100
            ? [item, ...this.sessionState.catalog.items] : this.sessionState.catalog.items } });
    }
    if (resume === 'watch-conversation' || resume === 'watch-live') await this.run(resume, {}, true);
  }
  private validatedScope(result: NativeRpcResult): NativeRpcResult {
    let origin = false;
    try { const url = new URL(result.server_url); origin = url.protocol === 'https:' && url.origin === result.server_url; } catch { /* rejected below */ }
    if (!origin || !/^[1-9][0-9]{0,9}$/.test(result.user_id) || Number(result.user_id) > 2147483647
      || result.platform_type !== 'desktop' || result.profile !== 'desktop') throw new Error('Desktop 세션 응답 범위를 확인할 수 없습니다.');
    const selected = this.sessionState.result;
    if (selected && (selected.server_url !== result.server_url || selected.user_id !== result.user_id)) {
      throw new Error('Desktop 세션 응답 계정이 변경되었습니다.');
    }
    return result;
  }
  private writableCatalog(): { focus: AgentFocus; items: OwnedAgentSession[] } | null {
    const catalog = this.sessionState.catalog;
    if (!this.scope() || !catalog.focus || catalog.busy) { this.show({ error: 'Agent 세션 목록을 먼저 새로 고쳐 주세요.' }); return null; }
    if (catalog.writeBlocked) { this.show({ error: '이전 작업 결과가 불명확합니다. Agent 세션 목록을 명시적으로 새로 고쳐 주세요.' }); return null; }
    if (this.mutating || this.sessionState.busy || ['unknown', 'sending', 'stopping', 'accepted', 'stop-requested'].includes(this.turnView.status)) {
      this.show({ error: '현재 턴 요청 상태를 먼저 확인해 주세요.' }); return null;
    }
    return { focus: catalog.focus, items: catalog.items };
  }
  private async lifecycleWrite(method: 'create-agent-session' | 'switch-agent-focus', input: object,
    parse: (result: NativeRpcResult) => AgentFocus): Promise<boolean> {
    const catalog = this.writableCatalog(); const scope = this.scope();
    if (!catalog || !scope) return false;
    const generation = ++this.generation; const previous = catalog.focus.active_agent_session_id;
    const resume = this.watchMethod === 'watch-live';
    if (resume) this.restoreLiveAfterCatalog = true;
    this.mutating = true; this.clearWatch();
    this.show({ busy: true, catalog: { ...this.sessionState.catalog, busy: true, notice: '' }, error: '' });
    try {
      const reply = await this.bridge.request(method, { ...input });
      if (generation !== this.generation) return false;
      if (!reply.ok) {
        if (reply.outcome === 'unknown') {
          this.show({ catalog: { ...this.sessionState.catalog, busy: false, writeBlocked: true,
            notice: '작업 완료 여부를 확인할 수 없습니다. 목록을 새로 고쳐 현재 포커스를 확인하기 전에는 다른 세션 작업을 보낼 수 없습니다.' } });
          return false;
        }
        if (reply.outcome === 'rejected' && reply.conflict && reply.conflict.code === 'FOCUS_VERSION_CONFLICT') {
          const focus = parseAgentFocus(reply.conflict.current);
          const changed = focus.active_agent_session_id !== previous;
          if (changed) this.resetTurn();
          this.show({ focus, ...(changed ? { conversation: null, hasMore: false, connection: 'connected' as const, transport: 'none' as const } : {}),
            catalog: { ...this.sessionState.catalog, focus, busy: false, writeBlocked: true,
            notice: '다른 클라이언트에서 포커스가 바뀌었습니다. 새 상태를 확인하고 다시 선택해 주세요.' } });
          return false;
        }
        this.show({ catalog: { ...this.sessionState.catalog, busy: false, notice: reply.message }, error: reply.message });
        return false;
      }
      if (!('user_id' in reply.value)) throw new Error('Desktop Agent 세션 응답을 확인할 수 없습니다.');
      const result = this.validatedScope(reply.value); const focus = parse(result);
      const changed = focus.active_agent_session_id !== previous;
      if (changed) this.resetTurn();
      this.show({ result: { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
        result: this.sessionState.result?.result }, focus,
        ...(changed ? { conversation: null, hasMore: false, connection: 'connected' as const, transport: 'none' as const } : {}),
        catalog: { ...this.sessionState.catalog, focus, busy: false, writeBlocked: false,
          ...(method === 'create-agent-session' ? { nextCursor: null, hasMore: false, olderPage: false, pageKnown: false } : {}),
          notice: method === 'create-agent-session' ? '새 Agent 세션을 만들고 현재 세션으로 선택했습니다.' : '현재 Agent 세션 포커스를 변경했습니다.' } });
      if (focus.active_agent_session_id) await this.recoverConversation(scope, resume ? 'watch-live' : null);
      else this.show({ conversation: null, hasMore: false, connection: 'connected', transport: 'none' });
      this.restoreLiveAfterCatalog = false;
      return true;
    } catch (error) {
      if (generation === this.generation) this.show({ catalog: { ...this.sessionState.catalog, busy: false, writeBlocked: true,
        notice: '작업 완료 여부를 확인할 수 없습니다. 목록을 새로 고쳐 현재 포커스를 확인하기 전에는 다른 세션 작업을 보낼 수 없습니다.' } });
      return false;
    } finally {
      this.mutating = false;
      if (generation === this.generation) this.show({ busy: false });
    }
  }
}
