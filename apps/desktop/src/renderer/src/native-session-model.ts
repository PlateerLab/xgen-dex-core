import { parseAgentFocus, type AgentFocus } from '@dex/protocol/agent-session';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
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
}
const empty = (): DesktopNativeView => ({ busy: false, result: null, focus: null, conversation: null, hasMore: false,
  connection: 'idle', transport: 'none', error: '' });
export class DesktopNativeSessionModel {
  private generation = 0;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private waiting = false;
  private buffered: DesktopNativeNotice | null = null;
  private readonly remove: () => void;
  state = empty();
  constructor(private readonly bridge: DesktopNativeBridge, private readonly render: (state: DesktopNativeView) => void) {
    this.remove = bridge.onUpdate((notice) => this.notice(notice));
  }
  private show(patch: Partial<DesktopNativeView>): void { this.state = { ...this.state, ...patch }; this.render(this.state); }
  private clearWatch(): void { this.watchId = null; this.watchView = null; this.waiting = false; this.buffered = null; }
  clear(): void { this.generation++; this.clearWatch(); this.state = empty(); this.render(this.state); }
  dispose(): void { this.clear(); this.remove(); void this.bridge.request('cancel').catch(() => {}); }
  async stopWatch(): Promise<void> {
    const generation = ++this.generation; const watchId = this.watchId; const pendingWatch = this.waiting;
    this.clearWatch(); this.show({ busy: Boolean(watchId || pendingWatch), focus: null, conversation: null, hasMore: false,
      connection: 'idle', transport: 'none', error: '' });
    if (!watchId && !pendingWatch) return;
    try {
      const reply = await this.bridge.request(pendingWatch ? 'cancel' : 'unwatch', watchId ? { watch_id: watchId } : {});
      if (generation === this.generation && !reply.ok) throw new Error(reply.message);
    } catch (error) {
      if (generation === this.generation) this.show({ connection: 'stopped', error: error instanceof Error ? error.message : '대화 폴링을 중단하지 못했습니다.' });
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async execute(method: DesktopNativeMethod, params: Record<string, unknown> = {}): Promise<NativeRpcResult | null> {
    const generation = ++this.generation;
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
      if (!('user_id' in reply.value)) { this.clear(); return null; }
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
      } else if (method !== 'watch' && method !== 'watch-conversation' && method !== 'watch-live') {
        this.show({ result: result.result !== undefined ? result : this.state.result ?? result });
      }
      if (method === 'watch' || method === 'watch-conversation' || method === 'watch-live') {
        const watchId = result.watch_id;
        if (!this.validWatchId(watchId)) throw new Error('구독을 시작하지 못했습니다.');
        if ((method === 'watch-conversation' || method === 'watch-live') && result.view !== 'conversation') throw new Error('현재 공유 대화 구독 응답을 확인할 수 없습니다.');
        result = { platform_type: 'desktop', profile: 'desktop', server_url: result.server_url, user_id: result.user_id,
          watch_id: watchId, ...(method === 'watch-conversation' || method === 'watch-live' ? { view: 'conversation' as const } : {}) };
        this.watchId = watchId; this.watchView = method === 'watch-conversation' || method === 'watch-live' ? 'conversation' : 'focus'; this.waiting = false;
        // Use the watch ACK account/origin as the scope, preserving only its public session detail.
        this.show({ result: { ...result, result: this.state.result?.result } });
        const buffered = this.buffered; this.buffered = null; if (buffered) this.notice(buffered);
      }
      return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.clearWatch(); this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false,
        error: error instanceof Error ? error.message : '기기·세션 확인에 실패했습니다.' });
      return null;
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  private notice(notice: DesktopNativeNotice): void {
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
      } catch { this.rejectWatch('현재 공유 대화 응답을 확인할 수 없습니다.'); }
    } else if (!('view' in value) && update.type === 'focus') {
      try { this.show({ connection: 'connected', focus: parseAgentFocus(update.focus) }); }
      catch {
        this.rejectWatch('현재 대화 응답을 확인할 수 없습니다.');
      }
    } else if (update.type === 'reset') this.show({ connection: 'waiting', focus: null, conversation: null, hasMore: false });
    else if (update.type === 'reconnecting') this.show({ connection: 'reconnecting', focus: null, conversation: null, hasMore: false });
    else if (update.type === 'stopped') { this.clearWatch(); this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false }); }
  }
  private validWatchId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
  }
  private rejectWatch(message: string): void {
    const watchId = this.watchId; this.clearWatch();
    this.show({ connection: 'stopped', transport: 'none', focus: null, conversation: null, hasMore: false, error: message });
    if (watchId) void this.bridge.request('unwatch', { watch_id: watchId }).catch(() => {});
  }
}
