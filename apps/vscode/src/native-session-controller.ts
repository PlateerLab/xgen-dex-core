import type { DexRpcClient } from '@dex/rpc/client';
import type { NativeRpcResult, NativeSessionSummary } from '@dex/rpc';
import { parseAgentFocus, type AgentFocus } from '@dex/protocol/agent-session';

export interface NativeSessionViewState {
  status: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'stopped';
  focus: AgentFocus | null;
}
export class NativeSessionController {
  private generation = 0;
  private connection = 0;
  private selected: NativeRpcResult | null = null;
  private watchId: string | null = null;
  private pendingWatch = false;
  private buffered: unknown = null;
  private readonly remove: Array<() => void>;
  constructor(private readonly rpc: Pick<DexRpcClient, 'start' | 'request' | 'onNotification' | 'onStateChange' | 'state'>,
    private readonly render: (state: NativeSessionViewState) => void) {
    this.remove = [rpc.onNotification((n) => { if (n.method === 'native/focus') this.update(n.params); }),
      rpc.onStateChange((state) => { if (state === 'stopped' || state === 'stopping') this.reset(false); })];
    this.render({ status: 'idle', focus: null });
  }
  get connectionVersion(): number { return this.connection; }
  account(profile: string, origin: string): string | null {
    return this.selected?.profile === profile && this.selected.server_url === new URL(origin).origin ? this.selected.user_id : null;
  }
  reset(cancel = true): void {
    this.connection++; this.generation++; this.selected = null; this.clear(); this.render({ status: 'idle', focus: null });
    if (cancel && this.rpc.state === 'ready') void this.rpc.request('native/cancel').catch(() => {});
  }
  dispose(): void { this.reset(); for (const remove of this.remove) remove(); }
  private clear(): void { this.watchId = null; this.pendingWatch = false; this.buffered = null; }
  async perform(method: 'native/device' | 'native/session', params: Record<string, unknown>): Promise<NativeRpcResult | null> {
    const generation = ++this.generation; this.clear(); this.render({ status: 'waiting', focus: null });
    try {
      await this.requireHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>(method, params);
      if (generation !== this.generation) return null;
      this.selected = result; this.render({ status: 'idle', focus: null }); return result;
    } catch (error) { if (generation !== this.generation) return null; this.render({ status: 'stopped', focus: null }); throw error; }
  }
  async watch(profile: string, userId: string): Promise<void> {
    const generation = ++this.generation; this.clear(); this.render({ status: 'waiting', focus: null });
    try {
      await this.requireHost(); if (generation !== this.generation) return;
      this.pendingWatch = true;
      const result = await this.rpc.request<NativeRpcResult>('native/watch', { profile, user_id: userId });
      if (generation !== this.generation) return;
      this.selected = result; this.watchId = result.watch_id ?? null; this.pendingWatch = false;
      const buffered = this.buffered; this.buffered = null;
      if (buffered) this.update(buffered);
    } catch (error) { if (generation !== this.generation) return; this.clear(); this.render({ status: 'stopped', focus: null }); throw error; }
  }
  private async requireHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode') {
      throw new Error('VSCode 기기·세션을 지원하는 CLI가 필요합니다. 개발 중에는 빌드한 apps/cli/dist/cli.js를 CLI 경로로 설정하세요.');
    }
  }
  private update(value: unknown): void {
    if (this.pendingWatch) { this.buffered = value; return; }
    if (!value || typeof value !== 'object') return;
    const n = value as Record<string, any>;
    if (!this.watchId || n.watch_id !== this.watchId || n.platform_type !== 'vscode' || n.profile !== this.selected?.profile
      || n.server_url !== this.selected?.server_url || n.update?.user_id !== this.selected?.user_id) return;
    if (n.update.type === 'focus') {
      try { this.render({ status: 'connected', focus: parseAgentFocus(n.update.focus) }); }
      catch {
        const watchId = this.watchId; this.clear(); this.render({ status: 'stopped', focus: null });
        void this.rpc.request('native/unwatch', { watch_id: watchId }).catch(() => {});
      }
    } else if (n.update.type === 'reset') this.render({ status: 'waiting', focus: null });
    else if (n.update.type === 'reconnecting') this.render({ status: 'reconnecting', focus: null });
    else if (n.update.type === 'stopped') { this.clear(); this.render({ status: 'stopped', focus: null }); }
  }
}
export function nativeSessionSummary(result: NativeRpcResult): NativeSessionSummary | null {
  return result.result && 'session_id' in result.result ? result.result : null;
}
