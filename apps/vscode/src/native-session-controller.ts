import { DexRpcError, type DexRpcClient } from '@dex/rpc/client';
import type { NativeConversationView, NativeRpcResult, NativeSessionSummary } from '@dex/rpc';
import { parseAgentFocus, parseAgentSessionList, type AgentFocus, type AgentSessionSnapshot, type OwnedAgentSession } from '@dex/protocol/agent-session';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import {
  AgentSessionLifecycleOutcomeUnknown,
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

export interface NativeSessionViewState {
  status: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'stopped';
  focus: AgentFocus | null;
  conversation: NativeConversationView | null;
  hasMore: boolean;
  scope?: AgentTurnScope | null;
  turn?: AgentTurnComposerView;
  connectionVersion?: number;
  catalog?: {
    scope: AgentTurnScope | null;
    focus: AgentFocus | null;
    items: OwnedAgentSession[];
    nextCursor: string | null;
    hasMore: boolean;
    busy: boolean;
    writeBlocked: boolean;
    notice?: string;
  };
}
type SessionState = Omit<NativeSessionViewState, 'turn' | 'catalog'> & { scope: AgentTurnScope | null };
const empty = (status: SessionState['status']): SessionState => ({ status, focus: null, conversation: null, hasMore: false, scope: null });
export class NativeSessionController {
  private generation = 0;
  private connection = 0;
  private selected: NativeRpcResult | null = null;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private watchMethod: 'native/watch' | 'native/watch-conversation' | 'native/watch-live' | null = null;
  private restoreLiveAfterCatalog = false;
  private pendingWatch = false;
  private buffered: unknown = null;
  private sessionState: SessionState = empty('idle');
  private turnView!: AgentTurnComposerView;
  private canonicalTurns = false;
  private verifiedScope: AgentTurnScope | null = null;
  private verifiedSnapshot: AgentSessionSnapshot | null = null;
  private mutating = false;
  private catalog = { scope: null as AgentTurnScope | null, focus: null as AgentFocus | null, items: [] as OwnedAgentSession[],
    nextCursor: null as string | null, hasMore: false, busy: false, writeBlocked: false, notice: undefined as string | undefined };
  private mutationBarrier: Promise<void> | null = null;
  private releaseMutation: (() => void) | null = null;
  private readBarrier: Promise<void> | null = null;
  private readonly composer: AgentTurnComposer;
  private readonly remove: Array<() => void>;
  constructor(private readonly rpc: Pick<DexRpcClient, 'start' | 'request' | 'onNotification' | 'onStateChange' | 'state'>,
    private readonly render: (state: NativeSessionViewState) => void) {
    this.composer = new AgentTurnComposer(async (request) => {
      await this.requireTurnHost();
      const selected = this.selected;
      if (!selected || selected.platform_type !== request.scope.platform_type || selected.profile !== request.scope.profile
        || selected.server_url !== request.scope.server_url || selected.user_id !== request.scope.user_id
        || this.sessionState.conversation?.snapshot?.id !== request.agent_session_id) {
        throw new AgentTurnComposeFailure('unavailable');
      }
      try {
        return await this.rpc.request<NativeRpcResult>(request.operation === 'submit' ? 'native/submit-turn' : 'native/stop-turn', {
          profile: request.scope.profile,
          user_id: request.scope.user_id,
          agent_session_id: request.agent_session_id,
          ...request.input,
        });
      } catch (error) { throw composeFailure(error); }
    }, (view) => { this.turnView = view; this.publish(); });
    this.remove = [rpc.onNotification((n) => {
      if (n.method === 'native/focus') this.update(n.params, 'focus');
      else if (n.method === 'native/conversation') this.update(n.params, 'conversation');
    }),
      rpc.onStateChange((state) => { if (state === 'stopped' || state === 'stopping') this.reset(false); })];
    this.publish();
  }
  get connectionVersion(): number { return this.connection; }
  account(profile: string, origin: string): string | null {
    return this.selected?.profile === profile && this.selected.server_url === new URL(origin).origin ? this.selected.user_id : null;
  }
  reset(cancel = true): void {
    this.connection++; this.generation++; this.selected = null; this.canonicalTurns = false; this.restoreLiveAfterCatalog = false; this.clear(); this.clearVerified();
    this.clearCatalog();
    this.setState(empty('idle'));
    if (cancel && this.rpc.state === 'ready') void this.rpc.request('native/cancel').catch(() => {});
  }
  dispose(): void { this.reset(); for (const remove of this.remove) remove(); }
  private clear(): void { this.watchId = null; this.watchView = null; this.watchMethod = null; this.pendingWatch = false; this.buffered = null; }
  async perform(method: 'native/device' | 'native/session', params: Record<string, unknown>): Promise<NativeRpcResult | null> {
    const routine = ['status', 'refresh', 'approvers'].includes(typeof params.action === 'string' ? params.action : '');
    if (routine) await this.waitForMutation();
    const generation = ++this.generation;
    if (routine) this.makeUnavailable('waiting');
    else { this.clear(); this.clearVerified(); this.clearCatalog(); this.setState(empty('waiting')); }
    try {
      await this.requireHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>(method, params);
      if (generation !== this.generation) return null;
      if (routine && this.verifiedScope && !this.sameScope(result, this.verifiedScope)) this.clearVerified();
      if (routine && this.catalog.scope && !this.sameScope(result, this.catalog.scope)) this.clearCatalog();
      this.selected = result; this.setState(empty('idle')); return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (routine) this.makeUnavailable('stopped'); else this.setState(empty('stopped'));
      throw error;
    }
  }
  async watch(profile: string, userId: string): Promise<void> {
    await this.waitForMutation();
    return this.readOperation(() => this.startWatch('focus', profile, userId));
  }
  async conversation(profile: string, userId: string): Promise<NativeRpcResult | null> {
    await this.waitForMutation();
    return this.readOperation(() => this.readConversation(profile, userId));
  }
  private async readConversation(profile: string, userId: string): Promise<NativeRpcResult | null> {
    const generation = ++this.generation;
    const preserve = this.verifiedMatches(profile, userId);
    if (!preserve) this.clearVerified();
    this.clear(); this.setTransient('waiting', preserve);
    try {
      await this.requireConversationHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>('native/conversation', { profile, user_id: userId });
      if (generation !== this.generation) return null;
      this.validateScope(result, profile, userId, 'conversation');
      const conversation = parseAgentConversationView(result.conversation);
      if (typeof result.has_more !== 'boolean') throw new Error('현재 공유 대화 응답을 확인할 수 없습니다.');
      const validated: NativeRpcResult = { platform_type: 'vscode', profile, server_url: result.server_url, user_id: userId,
        view: 'conversation', conversation, has_more: result.has_more };
      this.selected = validated;
      const scope = this.scopeOf(validated);
      this.acceptConversation(scope, conversation);
      this.setState({ status: 'connected', focus: null, conversation, hasMore: result.has_more, scope });
      return validated;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.setTransient('stopped', preserve); throw error;
    }
  }
  async watchConversation(profile: string, userId: string): Promise<void> {
    await this.waitForMutation();
    return this.readOperation(() => this.startWatch('conversation', profile, userId, 'native/watch-conversation'));
  }
  async watchLive(profile: string, userId: string): Promise<void> {
    await this.waitForMutation();
    return this.readOperation(() => this.startWatch('conversation', profile, userId, 'native/watch-live'));
  }
  async stopWatch(): Promise<void> {
    await this.waitForMutation();
    const generation = ++this.generation; const watchId = this.watchId; const pendingWatch = this.pendingWatch;
    const pendingRead = this.readBarrier;
    this.makeUnavailable('idle');
    if ((!watchId && !pendingWatch) || this.rpc.state !== 'ready') {
      if (this.readBarrier === pendingRead) this.readBarrier = null;
      return;
    }
    try {
      await this.rpc.request(pendingWatch ? 'native/cancel' : 'native/unwatch', watchId ? { watch_id: watchId } : {});
    }
    catch (error) { if (generation === this.generation) { this.setState(empty('stopped')); throw error; } }
    finally { if (this.readBarrier === pendingRead) this.readBarrier = null; }
  }
  async submitTurn(input: string): Promise<void> {
    await this.mutate(() => this.composer.submit(input));
  }
  async retryTurn(): Promise<void> {
    await this.mutate(() => this.composer.retry());
  }
  async stopTurn(): Promise<void> {
    await this.mutate(() => this.composer.stop());
  }
  async refreshAgentSessions(profile: string, userId: string, beforeId?: string): Promise<void> {
    await this.waitForMutation();
    await this.waitForRead();
    await this.lifecycle(async () => {
      const generation = ++this.generation;
      const resumeLive = this.watchMethod === 'native/watch-live' || this.restoreLiveAfterCatalog;
      this.clear(); this.catalog = { ...this.catalog, busy: true, notice: undefined }; this.publish();
      try {
        await this.requireSessionCatalogHost();
        const expectedScope = this.selected && this.selected.profile === profile && this.selected.user_id === userId
          ? this.scopeOf(this.selected) : null;
        const result = await this.rpc.request<NativeRpcResult>('native/agent-sessions', {
          profile, user_id: userId, limit: 100, ...(beforeId ? { before_id: beforeId } : {}),
        });
        if (generation !== this.generation) return;
        this.validateScope(result, profile, userId, 'focus');
        const priorScope = this.catalog.scope;
        if (expectedScope && result.server_url !== expectedScope.server_url) throw new Error('Agent 세션 응답 서버 범위가 변경되었습니다.');
        if (priorScope && priorScope.profile === profile && priorScope.user_id === userId
          && result.server_url !== priorScope.server_url) throw new Error('Agent 세션 응답 서버 범위가 변경되었습니다.');
        const focus = parseAgentFocus(result.focus);
        const sessions = parseAgentSessionList(result.sessions);
        const scope = this.scopeOf(result);
        const oldFocus = this.catalog.scope && this.sameScope(scope, this.catalog.scope) ? this.catalog.focus : null;
        const displayed = this.sessionState.conversation?.snapshot?.id ?? oldFocus?.active_agent_session_id ?? null;
        const changed = displayed !== focus.active_agent_session_id;
        if (changed) {
          this.clearVerified();
          this.setState({ status: 'connected', focus, conversation: null, hasMore: false, scope: null });
        }
        this.catalog = { scope, focus, items: sessions.items, nextCursor: sessions.next_cursor, hasMore: sessions.has_more,
          busy: false, writeBlocked: false, notice: beforeId ? 'Agent 세션 목록을 더 불러왔습니다.' : 'Agent 세션 목록과 현재 포커스를 다시 확인했습니다.' };
        this.publish();
        if (focus.active_agent_session_id) await this.recoverSelectedConversation(scope, resumeLive);
        this.restoreLiveAfterCatalog = false;
      } catch (error) {
        if (generation !== this.generation) return;
        this.catalog = { ...this.catalog, busy: false, notice: lifecycleMessage(error, false) }; this.publish();
        throw error;
      }
    });
  }
  async createAgentSession(workflowId: string, title?: string): Promise<void> {
    await this.waitForRead();
    const catalog = this.requireWritableCatalog();
    const input = validateCreateAgentSession({ workflow_id: workflowId, title: title ?? '', expected_version: catalog.focus.version });
    await this.writeLifecycle('native/create-agent-session', input, (result) => parseCreatedAgentSession(result.created, input));
  }
  async switchAgentFocus(agentSessionId: string | null): Promise<void> {
    await this.waitForRead();
    const catalog = this.requireWritableCatalog();
    if (agentSessionId !== null && !catalog.items.some((item) => item.id === agentSessionId && item.status === 'active')) {
      throw new Error('새로 확인한 내 활성 Agent 세션만 선택할 수 있습니다.');
    }
    const input = validateSwitchAgentFocus({ active_agent_session_id: agentSessionId, expected_version: catalog.focus.version });
    await this.writeLifecycle('native/switch-agent-focus', input, (result) => parseSwitchedAgentFocus(result.focus, input));
  }
  private async startWatch(view: 'focus' | 'conversation', profile: string, userId: string,
    method: 'native/watch' | 'native/watch-conversation' | 'native/watch-live' = 'native/watch'): Promise<void> {
    const generation = ++this.generation;
    const preserve = this.verifiedMatches(profile, userId);
    if (!preserve) this.clearVerified();
    this.clear(); this.setTransient('waiting', preserve);
    try {
      if (method === 'native/watch-live') await this.requireLiveHost();
      else if (view === 'conversation') await this.requireConversationHost(); else await this.requireHost();
      if (generation !== this.generation) return;
      this.pendingWatch = true;
      const result = await this.rpc.request<NativeRpcResult>(method, { profile, user_id: userId });
      if (generation !== this.generation) {
        if (this.rpc.state === 'ready' && this.validWatchId(result.watch_id)) {
          void this.rpc.request('native/unwatch', { watch_id: result.watch_id }).catch(() => {});
        }
        return;
      }
      this.validateScope(result, profile, userId, view);
      if (!this.validWatchId(result.watch_id)) throw new Error('현재 대화 구독을 시작하지 못했습니다.');
      this.selected = { platform_type: 'vscode', profile, server_url: result.server_url, user_id: userId, watch_id: result.watch_id,
        ...(view === 'conversation' ? { view: 'conversation' as const } : {}) };
      this.watchId = result.watch_id; this.watchView = view; this.pendingWatch = false;
      this.watchMethod = method;
      const buffered = this.buffered; this.buffered = null;
      if (buffered) this.update(buffered, view);
    } catch (error) {
      if (generation !== this.generation) return;
      this.clear();
      if (!preserve) this.composer.reset();
      this.setTransient('stopped', preserve);
      throw error;
    }
  }
  private async requireHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode') {
      throw new Error('VSCode 기기·세션을 지원하는 CLI가 필요합니다. 개발 중에는 빌드한 apps/cli/dist/cli.js를 CLI 경로로 설정하세요.');
    }
  }
  private async requireConversationHost(): Promise<void> {
    const initialized = await this.rpc.start();
    this.canonicalTurns = initialized.capabilities.nativePlatformSession?.canonicalTurns === true;
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode'
      || initialized.capabilities.nativePlatformSession.canonicalConversation !== true) {
      throw new Error('현재 공유 대화 조회를 지원하는 CLI가 필요합니다.');
    }
  }
  private async requireTurnHost(): Promise<void> {
    const initialized = await this.rpc.start();
    this.canonicalTurns = initialized.capabilities.nativePlatformSession?.platform === 'vscode'
      && initialized.capabilities.nativePlatformSession.canonicalTurns === true;
    if (!this.canonicalTurns) throw new AgentTurnComposeFailure('unavailable');
  }
  private async requireSessionCatalogHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode'
      || initialized.capabilities.nativePlatformSession.canonicalSessions !== true) {
      throw new Error('Canonical Agent 세션 선택을 지원하는 CLI가 필요합니다.');
    }
  }
  private async requireLiveHost(): Promise<void> {
    const initialized = await this.rpc.start();
    this.canonicalTurns = initialized.capabilities.nativePlatformSession?.canonicalTurns === true;
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode'
      || initialized.capabilities.nativePlatformSession.canonicalLive !== true) {
      throw new Error('현재 공유 대화 실시간 연결을 지원하는 CLI가 필요합니다.');
    }
  }
  private validWatchId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
  }
  private validateScope(result: NativeRpcResult, profile: string, userId: string, view: 'focus' | 'conversation'): void {
    let origin = false;
    try { const url = new URL(result.server_url); origin = url.protocol === 'https:' && url.origin === result.server_url; } catch { /* rejected below */ }
    if (!origin || result.platform_type !== 'vscode' || result.profile !== profile || result.user_id !== userId
      || (view === 'conversation' && result.view !== 'conversation')) {
      throw new Error('네이티브 세션 응답 범위를 확인할 수 없습니다.');
    }
  }
  private update(value: unknown, view: 'focus' | 'conversation'): void {
    if (this.pendingWatch) { this.buffered = value; return; }
    if (!value || typeof value !== 'object') return;
    const n = value as Record<string, any>;
    if (!this.watchId || this.watchView !== view || n.watch_id !== this.watchId || n.platform_type !== 'vscode' || n.profile !== this.selected?.profile
      || n.server_url !== this.selected?.server_url || n.update?.user_id !== this.selected?.user_id
      || (view === 'conversation') !== (n.view === 'conversation')) return;
    if (view === 'conversation' && n.update.type === 'conversation') {
      try {
        const conversation = parseAgentConversationView(n.update.conversation);
        if (typeof n.update.has_more !== 'boolean' || !['snapshot', 'replay', 'recovered'].includes(n.update.source)) throw new Error();
        const scope = this.scopeOf(this.selected!);
        this.acceptConversation(scope, conversation);
        this.setState({ status: 'connected', focus: null, conversation, hasMore: n.update.has_more, scope });
      }
      catch { this.rejectWatch(); }
    } else if (view === 'focus' && n.update.type === 'focus') {
      try {
        const focus = parseAgentFocus(n.update.focus);
        const scope = this.scopeOf(this.selected!);
        if (this.verifiedScope && this.sameScope(scope, this.verifiedScope)
          && this.verifiedSnapshot?.id === focus.active_agent_session_id) {
          this.composer.context(this.verifiedScope, this.verifiedSnapshot, false);
        } else {
          this.clearVerified();
          this.verifiedScope = scope;
          this.composer.context(scope, null, true);
        }
        this.setState({ status: 'connected', focus, conversation: null, hasMore: false, scope: null });
      }
      catch {
        this.rejectWatch();
      }
    } else if (n.update.type === 'reset') this.setTransient('waiting', view === 'conversation');
    else if (n.update.type === 'reconnecting') this.setTransient('reconnecting', view === 'conversation');
    else if (n.update.type === 'stopped') this.makeUnavailable('stopped');
  }
  private rejectWatch(): void {
    const watchId = this.watchId; this.makeUnavailable('stopped');
    if (watchId) void this.rpc.request('native/unwatch', { watch_id: watchId }).catch(() => {});
  }
  private scopeOf(result: NativeRpcResult): AgentTurnScope {
    return { platform_type: 'vscode', profile: result.profile, server_url: result.server_url, user_id: result.user_id };
  }
  private setState(state: SessionState): void { this.sessionState = state; this.publish(); }
  private setTransient(status: 'waiting' | 'reconnecting' | 'stopped', preserve: boolean): void {
    if (preserve && this.verifiedScope) {
      this.composer.context(this.verifiedScope, this.verifiedSnapshot, false);
      this.setState({ ...this.sessionState, status });
      return;
    }
    this.setState(empty(status));
  }
  private makeUnavailable(status: 'idle' | 'waiting' | 'stopped'): void {
    if (this.verifiedScope) this.composer.context(this.verifiedScope, this.verifiedSnapshot, false);
    else this.composer.reset();
    this.clear();
    this.setState(empty(status));
  }
  private acceptConversation(scope: AgentTurnScope, conversation: NativeConversationView): void {
    this.composer.context(scope, conversation.snapshot, this.canonicalTurns);
    this.verifiedScope = scope;
    this.verifiedSnapshot = conversation.snapshot;
  }
  private verifiedMatches(profile: string, userId: string): boolean {
    return !!this.verifiedScope && this.verifiedScope.profile === profile && this.verifiedScope.user_id === userId;
  }
  private sameScope(left: Pick<AgentTurnScope, 'platform_type' | 'profile' | 'server_url' | 'user_id'>,
    right: AgentTurnScope): boolean {
    return left.platform_type === right.platform_type && left.profile === right.profile
      && left.server_url === right.server_url && left.user_id === right.user_id;
  }
  private clearVerified(): void {
    this.verifiedScope = null;
    this.verifiedSnapshot = null;
    this.composer.reset();
  }
  private clearCatalog(): void {
    this.catalog = { scope: null, focus: null, items: [], nextCursor: null, hasMore: false,
      busy: false, writeBlocked: false, notice: undefined };
  }
  private publish(): void {
    if (!this.turnView) return;
    const visibleCatalog = this.catalog.scope || this.catalog.busy || this.catalog.writeBlocked || this.catalog.notice;
    this.render({ ...this.sessionState, turn: this.turnView, connectionVersion: this.connection,
      ...(visibleCatalog ? { catalog: this.catalog } : {}) });
  }
  private async mutate(action: () => Promise<unknown>): Promise<void> {
    if (this.mutating) return;
    const scope = this.sessionState.scope;
    if (!scope || !this.sessionState.conversation?.snapshot) return;
    const generation = this.generation;
    this.mutating = true;
    this.mutationBarrier = new Promise<void>((resolve) => { this.releaseMutation = resolve; });
    try {
      try { await action(); } catch (error) {
        if (!(error instanceof AgentTurnComposeFailure)) throw error;
      }
      if (generation === this.generation && this.selected && this.selected.profile === scope.profile && this.selected.server_url === scope.server_url
        && this.selected.user_id === scope.user_id) await this.restartConversation(scope);
    } finally {
      this.mutating = false;
      this.releaseMutation?.();
      this.releaseMutation = null;
      this.mutationBarrier = null;
    }
  }
  private async restartConversation(scope: AgentTurnScope): Promise<void> {
    try {
      const read = await this.readConversation(scope.profile, scope.user_id);
      if (read && this.selected?.server_url === scope.server_url) await this.startWatch('conversation', scope.profile, scope.user_id, 'native/watch-live');
    } catch {
      // The composer retains rejected/unknown intent. A later explicit read or live reconnect remains authoritative.
    }
  }
  private async waitForMutation(): Promise<void> {
    const pending = this.mutationBarrier;
    if (pending) await pending;
  }
  private async readOperation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.readBarrier;
    let release!: () => void;
    const own = new Promise<void>((resolve) => { release = resolve; });
    this.readBarrier = own;
    if (previous) await previous;
    try { return await action(); }
    finally { release(); if (this.readBarrier === own) this.readBarrier = null; }
  }
  private async waitForRead(): Promise<void> {
    const pending = this.readBarrier;
    if (pending) await pending;
  }
  private async lifecycle(action: () => Promise<void>): Promise<void> {
    if (this.mutating) return;
    this.mutating = true;
    this.mutationBarrier = new Promise<void>((resolve) => { this.releaseMutation = resolve; });
    try { await action(); }
    finally {
      this.mutating = false; this.releaseMutation?.(); this.releaseMutation = null; this.mutationBarrier = null;
    }
  }
  private requireWritableCatalog(): { scope: AgentTurnScope; focus: AgentFocus; items: OwnedAgentSession[] } {
    const { scope, focus, items } = this.catalog;
    if (!scope || !focus || this.catalog.busy) throw new Error('Agent 세션 목록을 먼저 새로 고쳐 주세요.');
    if (this.catalog.writeBlocked) throw new Error('이전 작업 결과가 불명확합니다. Agent 세션 목록을 명시적으로 새로 고쳐 주세요.');
    if (!this.selected || !this.sameScope(this.selected, scope)) throw new Error('현재 계정 범위의 Agent 세션 목록을 다시 확인해 주세요.');
    if (this.mutating || ['unknown', 'sending', 'stopping', 'accepted', 'stop-requested'].includes(this.turnView.status)) {
      throw new Error('현재 턴 요청 상태를 먼저 확인해 주세요.');
    }
    return { scope, focus, items };
  }
  private async writeLifecycle(method: 'native/create-agent-session' | 'native/switch-agent-focus', input: object,
    parse: (result: NativeRpcResult) => { focus: AgentFocus } | AgentFocus): Promise<void> {
    const catalog = this.requireWritableCatalog();
    await this.lifecycle(async () => {
      const generation = ++this.generation;
      const resumeLive = this.watchMethod === 'native/watch-live';
      if (resumeLive) this.restoreLiveAfterCatalog = true;
      const previous = catalog.focus.active_agent_session_id;
      this.clear(); this.catalog = { ...this.catalog, busy: true, notice: undefined }; this.publish();
      try {
        await this.requireSessionCatalogHost();
        const result = await this.rpc.request<NativeRpcResult>(method, {
          profile: catalog.scope.profile, user_id: catalog.scope.user_id, ...input,
        });
        if (generation !== this.generation || !this.catalog.scope || !this.sameScope(this.catalog.scope, catalog.scope)) return;
        this.validateScope(result, catalog.scope.profile, catalog.scope.user_id, 'focus');
        if (result.server_url !== catalog.scope.server_url) throw new Error('Agent 세션 응답 서버 범위가 변경되었습니다.');
        const parsed = parse(result); const focus = 'focus' in parsed ? parsed.focus : parsed;
        const changed = previous !== focus.active_agent_session_id;
        if (changed) {
          this.clearVerified();
          this.setState({ status: 'connected', focus, conversation: null, hasMore: false, scope: null });
        }
        this.catalog = { ...this.catalog, focus, busy: false, writeBlocked: false,
          notice: method === 'native/create-agent-session' ? '새 Agent 세션을 만들고 현재 세션으로 선택했습니다.' : '현재 Agent 세션 포커스를 변경했습니다.' };
        this.publish();
        if (focus.active_agent_session_id) await this.recoverSelectedConversation(catalog.scope, resumeLive);
        else {
          this.setState({ status: 'connected', focus, conversation: null, hasMore: false, scope: null });
        }
        this.restoreLiveAfterCatalog = false;
      } catch (error) {
        if (generation !== this.generation) return;
        const failure = lifecycleFailure(error);
        if (failure.focus) {
          if (failure.focus.active_agent_session_id !== previous) {
            this.clearVerified();
            this.setState({ status: 'connected', focus: failure.focus, conversation: null, hasMore: false, scope: null });
          }
          this.catalog = { ...this.catalog, focus: failure.focus, busy: false, writeBlocked: true, notice: failure.message };
        } else this.catalog = { ...this.catalog, busy: false, writeBlocked: failure.unknown || this.catalog.writeBlocked, notice: failure.message };
        this.publish();
        if (!failure.handled) throw error;
      }
    });
  }
  private async recoverSelectedConversation(scope: AgentTurnScope, resumeLive: boolean): Promise<void> {
    const read = await this.readConversation(scope.profile, scope.user_id);
    if (read && read.server_url !== scope.server_url) {
      this.clearVerified(); this.setState(empty('stopped'));
      throw new Error('현재 대화 응답 서버 범위가 변경되었습니다.');
    }
    const snapshot = read?.conversation?.snapshot;
    if (snapshot && this.catalog.scope && this.sameScope(this.catalog.scope, scope)
      && this.catalog.focus?.active_agent_session_id === snapshot.id) {
      const item: OwnedAgentSession = { id: snapshot.id, workflow_id: snapshot.workflow_id, title: snapshot.title,
        status: 'active', current_sequence: snapshot.current_sequence, state_version: snapshot.state_version };
      this.catalog = { ...this.catalog, items: [item, ...this.catalog.items.filter((candidate) => candidate.id !== item.id)] };
      this.publish();
    }
    if (read && resumeLive && this.selected?.server_url === scope.server_url) {
      await this.startWatch('conversation', scope.profile, scope.user_id, 'native/watch-live');
    }
  }
}

function lifecycleFailure(error: unknown): { handled: boolean; unknown: boolean; focus?: AgentFocus; message: string } {
  if (error instanceof AgentSessionLifecycleOutcomeUnknown) return { handled: true, unknown: true,
    message: '작업 완료 여부를 확인할 수 없습니다. 목록을 새로 고쳐 현재 포커스를 확인하기 전에는 다른 세션 작업을 보낼 수 없습니다.' };
  if (error instanceof DexRpcError) {
    const data = error.data && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data as Record<string, unknown> : null;
    const details = data?.details && typeof data.details === 'object' && !Array.isArray(data.details) ? data.details as Record<string, unknown> : null;
    if (details?.outcome === 'unknown') return { handled: true, unknown: true,
      message: '작업 완료 여부를 확인할 수 없습니다. 목록을 새로 고쳐 현재 포커스를 확인하기 전에는 다른 세션 작업을 보낼 수 없습니다.' };
    if (details?.outcome === 'rejected') {
      const conflict = details.conflict && typeof details.conflict === 'object' && !Array.isArray(details.conflict)
        ? details.conflict as Record<string, unknown> : null;
      let focus: AgentFocus | undefined;
      try { if (conflict?.code === 'FOCUS_VERSION_CONFLICT') focus = parseAgentFocus(conflict.current); } catch { /* unsafe conflict omitted */ }
      return { handled: true, unknown: false, ...(focus ? { focus } : {}),
        message: focus ? '다른 클라이언트에서 포커스가 바뀌었습니다. 새 상태를 확인하고 다시 선택해 주세요.' : '서버가 Agent 세션 작업을 거절했습니다.' };
    }
    if (['auth_required', 'usage_error', 'not_found'].includes(error.engineCode ?? '')) {
      return { handled: false, unknown: false, message: lifecycleMessage(error, true) };
    }
  }
  return { handled: false, unknown: true, message: lifecycleMessage(error, true) };
}
function lifecycleMessage(error: unknown, write: boolean): string {
  if (error instanceof TypeError) return 'Agent 세션 입력 형식을 확인해 주세요.';
  if (error instanceof Error && error.message) return error.message;
  return write ? 'Agent 세션 작업을 완료하지 못했습니다.' : 'Agent 세션 목록을 확인하지 못했습니다.';
}
function composeFailure(error: unknown): AgentTurnComposeFailure {
  if (!(error instanceof DexRpcError)) return new AgentTurnComposeFailure('unknown');
  const data = error.data && typeof error.data === 'object' && !Array.isArray(error.data)
    ? error.data as Record<string, unknown> : null;
  const details = data?.details && typeof data.details === 'object' && !Array.isArray(data.details)
    ? data.details as Record<string, unknown> : null;
  const conflict = details?.conflict && typeof details.conflict === 'object' && !Array.isArray(details.conflict)
    ? details.conflict as any : undefined;
  if (details?.outcome === 'rejected') return new AgentTurnComposeFailure('rejected', conflict);
  if (details?.outcome === 'unknown') return new AgentTurnComposeFailure('unknown');
  if (['auth_required', 'usage_error', 'protocol_mismatch', 'not_found'].includes(error.engineCode ?? '')) {
    return new AgentTurnComposeFailure('unavailable');
  }
  return new AgentTurnComposeFailure('unknown');
}
export function nativeSessionSummary(result: NativeRpcResult): NativeSessionSummary | null {
  return result.result && 'session_id' in result.result ? result.result : null;
}
