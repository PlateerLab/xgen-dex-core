import { DexRpcError, type DexRpcClient } from '@dex/rpc/client';
import type { NativeConversationView, NativeRpcResult, NativeSessionSummary } from '@dex/rpc';
import { parseAgentFocus, type AgentFocus, type AgentSessionSnapshot } from '@dex/protocol/agent-session';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
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
}
type SessionState = Omit<NativeSessionViewState, 'turn'> & { scope: AgentTurnScope | null };
const empty = (status: SessionState['status']): SessionState => ({ status, focus: null, conversation: null, hasMore: false, scope: null });
export class NativeSessionController {
  private generation = 0;
  private connection = 0;
  private selected: NativeRpcResult | null = null;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private pendingWatch = false;
  private buffered: unknown = null;
  private sessionState: SessionState = empty('idle');
  private turnView!: AgentTurnComposerView;
  private canonicalTurns = false;
  private verifiedScope: AgentTurnScope | null = null;
  private verifiedSnapshot: AgentSessionSnapshot | null = null;
  private mutating = false;
  private mutationBarrier: Promise<void> | null = null;
  private releaseMutation: (() => void) | null = null;
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
    this.connection++; this.generation++; this.selected = null; this.canonicalTurns = false; this.clear(); this.clearVerified(); this.setState(empty('idle'));
    if (cancel && this.rpc.state === 'ready') void this.rpc.request('native/cancel').catch(() => {});
  }
  dispose(): void { this.reset(); for (const remove of this.remove) remove(); }
  private clear(): void { this.watchId = null; this.watchView = null; this.pendingWatch = false; this.buffered = null; }
  async perform(method: 'native/device' | 'native/session', params: Record<string, unknown>): Promise<NativeRpcResult | null> {
    const routine = ['status', 'refresh', 'approvers'].includes(typeof params.action === 'string' ? params.action : '');
    if (routine) await this.waitForMutation();
    const generation = ++this.generation;
    if (routine) this.makeUnavailable('waiting');
    else { this.clear(); this.clearVerified(); this.setState(empty('waiting')); }
    try {
      await this.requireHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>(method, params);
      if (generation !== this.generation) return null;
      if (routine && this.verifiedScope && !this.sameScope(result, this.verifiedScope)) this.clearVerified();
      this.selected = result; this.setState(empty('idle')); return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (routine) this.makeUnavailable('stopped'); else this.setState(empty('stopped'));
      throw error;
    }
  }
  async watch(profile: string, userId: string): Promise<void> {
    await this.waitForMutation();
    return this.startWatch('focus', profile, userId);
  }
  async conversation(profile: string, userId: string): Promise<NativeRpcResult | null> {
    await this.waitForMutation();
    return this.readConversation(profile, userId);
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
    return this.startWatch('conversation', profile, userId, 'native/watch-conversation');
  }
  async watchLive(profile: string, userId: string): Promise<void> {
    await this.waitForMutation();
    return this.startWatch('conversation', profile, userId, 'native/watch-live');
  }
  async stopWatch(): Promise<void> {
    await this.waitForMutation();
    const generation = ++this.generation; const watchId = this.watchId; const pendingWatch = this.pendingWatch;
    this.makeUnavailable('idle');
    if ((!watchId && !pendingWatch) || this.rpc.state !== 'ready') return;
    try {
      await this.rpc.request(pendingWatch ? 'native/cancel' : 'native/unwatch', watchId ? { watch_id: watchId } : {});
    }
    catch (error) { if (generation === this.generation) { this.setState(empty('stopped')); throw error; } }
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
  private publish(): void {
    if (!this.turnView) return;
    this.render({ ...this.sessionState, turn: this.turnView, connectionVersion: this.connection });
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
