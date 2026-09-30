import { parseAgentFocus, type AgentFocus } from '@dex/protocol/agent-session';
import type { NativeRpcResult } from '@dex/rpc';
import type { DesktopNativeBridge, DesktopNativeMethod, DesktopNativeNotice } from '../../native-session-types';

export interface DesktopNativeView {
  busy: boolean;
  result: NativeRpcResult | null;
  focus: AgentFocus | null;
  connection: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'stopped';
  error: string;
}
const empty = (): DesktopNativeView => ({ busy: false, result: null, focus: null, connection: 'idle', error: '' });
export class DesktopNativeSessionModel {
  private generation = 0;
  private watchId: string | null = null;
  private waiting = false;
  private buffered: DesktopNativeNotice | null = null;
  private readonly remove: () => void;
  state = empty();
  constructor(private readonly bridge: DesktopNativeBridge, private readonly render: (state: DesktopNativeView) => void) {
    this.remove = bridge.onUpdate((notice) => this.notice(notice));
  }
  private show(patch: Partial<DesktopNativeView>): void { this.state = { ...this.state, ...patch }; this.render(this.state); }
  private clearWatch(): void { this.watchId = null; this.waiting = false; this.buffered = null; }
  clear(): void { this.generation++; this.clearWatch(); this.state = empty(); this.render(this.state); }
  dispose(): void { this.clear(); this.remove(); void this.bridge.request('cancel').catch(() => {}); }
  async execute(method: DesktopNativeMethod, params: Record<string, unknown> = {}): Promise<NativeRpcResult | null> {
    const generation = ++this.generation;
    this.clearWatch(); this.waiting = method === 'watch';
    this.show({ busy: true, focus: null, connection: method === 'watch' ? 'waiting' : 'idle', error: '' });
    try {
      const reply = await this.bridge.request(method, params);
      if (generation !== this.generation) return null;
      if (!reply.ok) throw new Error(reply.message);
      if (!('user_id' in reply.value)) { this.clear(); return null; }
      const result = reply.value;
      if (result.platform_type !== 'desktop' || result.profile !== 'desktop') throw new Error('Desktop 세션 응답 범위를 확인할 수 없습니다.');
      this.show({ result: result.result !== undefined ? result : this.state.result ?? result });
      if (method === 'watch') {
        if (!result.watch_id) throw new Error('구독을 시작하지 못했습니다.');
        this.watchId = result.watch_id; this.waiting = false;
        // Use the watch ACK account/origin as the scope, preserving only its public session detail.
        this.show({ result: { ...result, result: this.state.result?.result } });
        const buffered = this.buffered; this.buffered = null; if (buffered) this.notice(buffered);
      }
      return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.clearWatch(); this.show({ connection: 'stopped', focus: null, error: error instanceof Error ? error.message : '기기·세션 확인에 실패했습니다.' });
      return null;
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  private notice(notice: DesktopNativeNotice): void {
    if (notice.type === 'cleared') { this.clear(); return; }
    if (this.waiting) { this.buffered = notice; return; }
    const value = notice.value; const selected = this.state.result;
    if (!this.watchId || value.watch_id !== this.watchId || value.platform_type !== 'desktop' || value.profile !== 'desktop'
      || value.server_url !== selected?.server_url || value.update.user_id !== selected?.user_id) return;
    const update = value.update;
    if (update.type === 'focus') {
      try { this.show({ connection: 'connected', focus: parseAgentFocus(update.focus) }); }
      catch {
        const watchId = this.watchId; this.clearWatch(); this.show({ connection: 'stopped', focus: null, error: '현재 대화 응답을 확인할 수 없습니다.' });
        void this.bridge.request('unwatch', { watch_id: watchId }).catch(() => {});
      }
    } else if (update.type === 'reset') this.show({ connection: 'waiting', focus: null });
    else if (update.type === 'reconnecting') this.show({ connection: 'reconnecting', focus: null });
    else if (update.type === 'stopped') { this.clearWatch(); this.show({ connection: 'stopped', focus: null }); }
  }
}
