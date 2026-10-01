import type { DexRpcClient } from '@dex/rpc/client';
import type { NativeConversationView, NativeRpcResult, NativeSessionSummary } from '@dex/rpc';
import { parseAgentFocus, type AgentFocus } from '@dex/protocol/agent-session';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';

export interface NativeSessionViewState {
  status: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'stopped';
  focus: AgentFocus | null;
  conversation: NativeConversationView | null;
  hasMore: boolean;
}
const empty = (status: NativeSessionViewState['status']): NativeSessionViewState => ({ status, focus: null, conversation: null, hasMore: false });
export class NativeSessionController {
  private generation = 0;
  private connection = 0;
  private selected: NativeRpcResult | null = null;
  private watchId: string | null = null;
  private watchView: 'focus' | 'conversation' | null = null;
  private pendingWatch = false;
  private buffered: unknown = null;
  private readonly remove: Array<() => void>;
  constructor(private readonly rpc: Pick<DexRpcClient, 'start' | 'request' | 'onNotification' | 'onStateChange' | 'state'>,
    private readonly render: (state: NativeSessionViewState) => void) {
    this.remove = [rpc.onNotification((n) => {
      if (n.method === 'native/focus') this.update(n.params, 'focus');
      else if (n.method === 'native/conversation') this.update(n.params, 'conversation');
    }),
      rpc.onStateChange((state) => { if (state === 'stopped' || state === 'stopping') this.reset(false); })];
    this.render(empty('idle'));
  }
  get connectionVersion(): number { return this.connection; }
  account(profile: string, origin: string): string | null {
    return this.selected?.profile === profile && this.selected.server_url === new URL(origin).origin ? this.selected.user_id : null;
  }
  reset(cancel = true): void {
    this.connection++; this.generation++; this.selected = null; this.clear(); this.render(empty('idle'));
    if (cancel && this.rpc.state === 'ready') void this.rpc.request('native/cancel').catch(() => {});
  }
  dispose(): void { this.reset(); for (const remove of this.remove) remove(); }
  private clear(): void { this.watchId = null; this.watchView = null; this.pendingWatch = false; this.buffered = null; }
  async perform(method: 'native/device' | 'native/session', params: Record<string, unknown>): Promise<NativeRpcResult | null> {
    const generation = ++this.generation; this.clear(); this.render(empty('waiting'));
    try {
      await this.requireHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>(method, params);
      if (generation !== this.generation) return null;
      this.selected = result; this.render(empty('idle')); return result;
    } catch (error) { if (generation !== this.generation) return null; this.render(empty('stopped')); throw error; }
  }
  async watch(profile: string, userId: string): Promise<void> {
    return this.startWatch('focus', profile, userId);
  }
  async conversation(profile: string, userId: string): Promise<NativeRpcResult | null> {
    const generation = ++this.generation; this.clear(); this.render(empty('waiting'));
    try {
      await this.requireConversationHost(); if (generation !== this.generation) return null;
      const result = await this.rpc.request<NativeRpcResult>('native/conversation', { profile, user_id: userId });
      if (generation !== this.generation) return null;
      this.validateScope(result, profile, userId, 'conversation');
      const conversation = parseAgentConversationView(result.conversation);
      if (typeof result.has_more !== 'boolean') throw new Error('현재 공유 대화 응답을 확인할 수 없습니다.');
      const validated: NativeRpcResult = { platform_type: 'vscode', profile, server_url: result.server_url, user_id: userId,
        view: 'conversation', conversation, has_more: result.has_more };
      this.selected = validated; this.render({ status: 'connected', focus: null, conversation, hasMore: result.has_more });
      return validated;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.render(empty('stopped')); throw error;
    }
  }
  async watchConversation(profile: string, userId: string): Promise<void> {
    return this.startWatch('conversation', profile, userId);
  }
  async stopWatch(): Promise<void> {
    const generation = ++this.generation; const watchId = this.watchId; const pendingWatch = this.pendingWatch;
    this.clear(); this.render(empty('idle'));
    if ((!watchId && !pendingWatch) || this.rpc.state !== 'ready') return;
    try {
      await this.rpc.request(pendingWatch ? 'native/cancel' : 'native/unwatch', watchId ? { watch_id: watchId } : {});
    }
    catch (error) { if (generation === this.generation) { this.render(empty('stopped')); throw error; } }
  }
  private async startWatch(view: 'focus' | 'conversation', profile: string, userId: string): Promise<void> {
    const generation = ++this.generation; this.clear(); this.render(empty('waiting'));
    try {
      if (view === 'conversation') await this.requireConversationHost(); else await this.requireHost();
      if (generation !== this.generation) return;
      this.pendingWatch = true;
      const result = await this.rpc.request<NativeRpcResult>(view === 'conversation' ? 'native/watch-conversation' : 'native/watch', { profile, user_id: userId });
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
    } catch (error) { if (generation !== this.generation) return; this.clear(); this.render(empty('stopped')); throw error; }
  }
  private async requireHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode') {
      throw new Error('VSCode 기기·세션을 지원하는 CLI가 필요합니다. 개발 중에는 빌드한 apps/cli/dist/cli.js를 CLI 경로로 설정하세요.');
    }
  }
  private async requireConversationHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode'
      || initialized.capabilities.nativePlatformSession.canonicalConversation !== true) {
      throw new Error('현재 공유 대화 조회를 지원하는 CLI가 필요합니다.');
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
        this.render({ status: 'connected', focus: null, conversation, hasMore: n.update.has_more });
      }
      catch { this.rejectWatch(); }
    } else if (view === 'focus' && n.update.type === 'focus') {
      try { this.render({ status: 'connected', focus: parseAgentFocus(n.update.focus), conversation: null, hasMore: false }); }
      catch {
        this.rejectWatch();
      }
    } else if (n.update.type === 'reset') this.render(empty('waiting'));
    else if (n.update.type === 'reconnecting') this.render(empty('reconnecting'));
    else if (n.update.type === 'stopped') { this.clear(); this.render(empty('stopped')); }
  }
  private rejectWatch(): void {
    const watchId = this.watchId; this.clear(); this.render(empty('stopped'));
    if (watchId) void this.rpc.request('native/unwatch', { watch_id: watchId }).catch(() => {});
  }
}
export function nativeSessionSummary(result: NativeRpcResult): NativeSessionSummary | null {
  return result.result && 'session_id' in result.result ? result.result : null;
}
