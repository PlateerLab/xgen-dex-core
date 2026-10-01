import { parseAgentFocus, type AgentFocus } from '@dex/protocol/agent-session';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import {
  AgentTurnComposer,
  AgentTurnComposeFailure,
  type AgentTurnComposerView,
  type AgentTurnScope,
} from '@dex/protocol/agent-turn-composer';
import type { NativeConversationView, NativeRpcResult } from '@dex/rpc';
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
}
type DesktopNativeSessionState = Omit<DesktopNativeView, 'turn'>;
type DesktopReadMethod = Exclude<DesktopNativeMethod, 'submit-turn' | 'stop-turn'>;
type DesktopWatchMethod = Extract<DesktopReadMethod, 'watch' | 'watch-conversation' | 'watch-live'>;
const empty = (): DesktopNativeSessionState => ({ busy: false, result: null, focus: null, conversation: null, hasMore: false,
  connection: 'idle', transport: 'none', error: '' });
export class DesktopNativeSessionModel {
  private generation = 0;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private watchMethod: DesktopWatchMethod | null = null;
  private waiting = false;
  private mutating = false;
  private disposed = false;
  private turnSessionId: string | null = null;
  private turnContextGeneration = 0;
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
        throw new AgentTurnComposeFailure('rejected', reply.conflict);
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
  private resetTurn(): void { this.turnContextGeneration++; this.turnSessionId = null; this.composer.reset(); }
  clear(): void {
    this.generation++; this.clearWatch(); this.resetTurn(); this.sessionState = empty(); this.publish();
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
    if (this.mutating) {
      if (method === 'cancel') {
        const reply = await this.bridge.request('cancel');
        if (!reply.ok) this.show({ error: reply.message });
      }
      return null;
    }
    return this.run(method, params, false);
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
          this.clearWatch(); this.show({ focus: null, conversation: null, hasMore: false, connection: 'idle', transport: 'none' });
          this.context(null, false); return null;
        }
        this.clear(); return null;
      }
      let result = reply.value;
      let origin = false;
      try { const url = new URL(result.server_url); origin = url.protocol === 'https:' && url.origin === result.server_url; } catch { /* rejected below */ }
      if (!origin || !/^[1-9][0-9]{0,9}$/.test(result.user_id) || Number(result.user_id) > 2147483647
        || result.platform_type !== 'desktop' || result.profile !== 'desktop') throw new Error('Desktop 세션 응답 범위를 확인할 수 없습니다.');
      if (method === 'conversation') {
        if (result.view !== 'conversation' || typeof result.has_more !== 'boolean') throw new Error('현재 공유 대화 응답을 확인할 수 없습니다.');
        const conversation = parseAgentConversationView(result.conversation);
        result = { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
          view: 'conversation', conversation, has_more: result.has_more };
        this.show({ result: { ...result, result: this.state.result?.result }, conversation, hasMore: result.has_more, connection: 'connected' });
        this.context(conversation, true);
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
        this.show({ connection: 'connected', focus: null, conversation, hasMore: update.has_more });
        this.context(conversation, true);
      } catch { this.rejectWatch('현재 공유 대화 응답을 확인할 수 없습니다.'); }
    } else if (!('view' in value) && update.type === 'focus') {
      try {
        const focus = parseAgentFocus(update.focus);
        if (focus.active_agent_session_id !== this.turnSessionId) this.resetTurn();
        else this.context(null, false);
        this.show({ connection: 'connected', focus });
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
  async submitTurn(input: string): Promise<boolean> { return this.mutate(() => this.composer.submit(input)); }
  async retryTurn(): Promise<boolean> { return this.mutate(() => this.composer.retry()); }
  async stopTurn(): Promise<boolean> { return this.mutate(() => this.composer.stop()); }
  private scope(): AgentTurnScope | null {
    const selected = this.sessionState.result;
    if (!selected) return null;
    return { platform_type: 'desktop', profile: selected.profile, server_url: selected.server_url, user_id: selected.user_id };
  }
  private context(conversation: NativeConversationView | null, available: boolean): void {
    const selected = this.scope();
    const nextSessionId = conversation?.snapshot?.id ?? null;
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
  private async recoverConversation(scope: AgentTurnScope, resume: DesktopWatchMethod | null): Promise<void> {
    const read = await this.run('conversation', {}, true);
    if (!read || !this.sameScope(scope) || this.sessionState.conversation?.snapshot?.id === undefined) return;
    if (resume === 'watch-conversation' || resume === 'watch-live') await this.run(resume, {}, true);
  }
}
