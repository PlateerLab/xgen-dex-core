import { AgentTurnComposer, AgentTurnComposeFailure, type AgentTurnComposerView, type AgentTurnComposeRequest, type AgentTurnScope } from '@dex/protocol/agent-turn-composer';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileConversationView } from './native-agent-conversation-watch';
import type { MobileCanonicalUpdate } from './native-agent-focus-watch';

export interface MobileConversationModelView {
  visible: boolean;
  watching: boolean;
  writing: boolean;
  conversation: MobileConversationView | null;
  hasMore: boolean;
  status: string;
  error: string;
  draft: string;
  turn: AgentTurnComposerView;
}
interface Watcher {
  run(update: (value: MobileCanonicalUpdate<MobileConversationView>) => void, signal: AbortSignal, once?: boolean): Promise<void>;
}
/** Login-lifetime UI owner. Hiding a screen cancels work but cannot erase an uncertain logical write. */
export class MobileAgentConversationModel {
  private readonly composer: AgentTurnComposer;
  private turn!: AgentTurnComposerView;
  private scope: AgentTurnScope | null = null;
  private observed: string | null = null;
  private generation = 0;
  private visibilityGeneration = 0;
  private disposed = false;
  private visible = false;
  private draft = '';
  private conversation: MobileConversationView | null = null;
  private hasMore = false;
  private status = '미확인';
  private error = '';
  private read: { control: AbortController; done: Promise<void> } | null = null;
  private write: AbortController | null = null;
  private actionBusy = false;
  state!: MobileConversationModelView;

  constructor(private readonly account: Pick<MobileEnrollmentAccount, 'origin' | 'userId'>,
    private readonly watcher: Watcher,
    private readonly writer: { send(request: AgentTurnComposeRequest, signal?: AbortSignal): Promise<unknown>; dispose(): void },
    private readonly render: (value: MobileConversationModelView) => void,
    createKey: () => string,
    private readonly disposeSource: () => void = () => undefined) {
    this.composer = new AgentTurnComposer((request) => this.dispatch(request), (value) => {
      this.turn = value; if (this.state) this.publish();
    }, createKey);
    this.turn = this.composer.view; this.publish();
  }
  private publish(): void {
    this.state = { visible: this.visible, watching: Boolean(this.read), writing: Boolean(this.write) || this.actionBusy,
      conversation: this.visible ? this.conversation : null, hasMore: this.visible && this.hasMore,
      status: this.status, error: this.error, draft: this.visible ? this.draft : '', turn: this.turn };
    if (!this.disposed) this.render(this.state);
  }
  private unavailable(): void { this.composer.context(this.scope, null, false); }
  setVisible(value: boolean): void {
    if (this.disposed || this.visible === value) return;
    this.visible = value;
    if (!value) {
      this.visibilityGeneration++;
      this.read?.control.abort(); this.write?.abort(); this.conversation = null; this.hasMore = false;
      this.status = '조회 중단'; this.error = ''; this.unavailable();
    }
    this.publish();
  }
  setDraft(value: string): void {
    if (!this.visible || this.disposed || this.write || this.actionBusy) return;
    this.draft = value; this.publish();
  }
  private update(update: MobileCanonicalUpdate<MobileConversationView>): void {
    if (update.type === 'value') {
      const value = update.value;
      const nextScope: AgentTurnScope = { platform_type: 'mobile', profile: value.authScope,
        server_url: this.account.origin, user_id: this.account.userId };
      // A partial replay with no snapshot is not an authoritative empty focus.
      const identity = value.snapshot ? `${value.authScope}:${value.snapshot.id}` : !update.hasMore ? `${value.authScope}:none` : null;
      if ((this.scope && this.scope.profile !== nextScope.profile) || (identity && this.observed && identity !== this.observed)) {
        this.generation++; this.draft = '';
      }
      if (identity) this.observed = identity;
      this.scope = nextScope; this.conversation = value; this.hasMore = update.hasMore;
      this.composer.context(nextScope, value.snapshot, !update.hasMore);
      this.status = update.hasMore ? '기록을 이어서 불러오는 중' : '최신 대화 확인'; this.error = '';
    } else {
      this.conversation = null; this.hasMore = false; this.unavailable();
      this.status = update.type === 'reset' ? '조회 중…' : update.type === 'reconnecting' ? `${update.retryInMs / 1000}초 후 재연결` : '조회 중단';
      if (update.type === 'stopped' && update.reason !== 'cancelled') this.error = update.reason === 'authentication'
        ? '휴대폰 세션이 만료되었거나 접근이 변경되었습니다. 기기·세션을 확인한 뒤 다시 조회하세요.'
        : '공유 대화를 확인하지 못했습니다. 기기 키·세션과 서버 상태를 확인하세요.';
    }
    this.publish();
  }
  async start(once = false): Promise<void> {
    if (!this.visible || this.disposed || this.write || this.actionBusy || this.read) return;
    const control = new AbortController();
    const selected = { control, done: Promise.resolve() }; this.read = selected; this.error = '';
    // Install ownership before calling run; watchers can emit their first value synchronously.
    selected.done = Promise.resolve().then(() => this.watcher.run((value) => {
      if (this.read === selected && this.visible && !this.disposed && !control.signal.aborted) this.update(value);
    }, control.signal, once)).catch(() => {
      if (this.read === selected && this.visible && !this.disposed && !control.signal.aborted && !this.error) {
        this.conversation = null; this.unavailable(); this.status = '조회 중단'; this.error = '공유 대화를 확인하지 못했습니다. 기기 키·세션과 서버 상태를 확인하세요.';
      }
    }).finally(() => {
      if (this.read === selected) { this.read = null; this.publish(); }
    });
    this.publish(); await selected.done;
  }
  stopRead(): void {
    if (this.write || this.actionBusy || this.disposed) return;
    this.read?.control.abort(); this.conversation = null; this.hasMore = false; this.status = '조회 중단'; this.unavailable(); this.publish();
  }
  private async dispatch(request: AgentTurnComposeRequest): Promise<unknown> {
    if (this.write || !this.visible || this.disposed || !this.scope || request.scope.profile !== this.scope.profile
      || this.conversation?.snapshot?.id !== request.agent_session_id) throw new AgentTurnComposeFailure('unavailable');
    const control = new AbortController(); this.write = control;
    // Leave the watcher before acquiring a write proof/vault lock. The shared HTTP latch
    // refuses writes until a cancelled native GET actually settles; cancellation is not turn stop.
    const reading = this.read; reading?.control.abort(); this.publish();
    try {
      await reading?.done; control.signal.throwIfAborted();
      return await this.writer.send(request, control.signal);
    } catch (error) {
      if (error instanceof AgentTurnComposeFailure) throw error;
      throw new AgentTurnComposeFailure('unavailable');
    } finally {
      if (this.write === control) this.write = null;
      this.publish();
    }
  }
  private async action(operation: 'submit' | 'retry' | 'stop'): Promise<void> {
    if (this.disposed || !this.visible || this.write || this.actionBusy) return;
    this.actionBusy = true;
    const generation = this.generation; const visibilityGeneration = this.visibilityGeneration;
    const original = this.draft; const identity = this.observed;
    const retrySubmit = operation === 'retry' && this.turn.request?.operation === 'submit';
    try {
      this.error = '';
      const result = operation === 'submit' ? await this.composer.submit(original)
        : operation === 'retry' ? await this.composer.retry() : await this.composer.stop();
      if (result && (operation === 'submit' || retrySubmit) && generation === this.generation
        && identity === this.observed && original === this.draft) this.draft = '';
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.error = error instanceof AgentTurnComposeFailure
        ? error.message : '입력 형식을 확인하세요. 텍스트는 UTF-8 262144바이트까지 전송할 수 있습니다.';
    }
    this.actionBusy = false; this.unavailable(); this.publish();
    // Reads may recover automatically after a user write; writes themselves never retry.
    if (this.visible && !this.disposed && generation === this.generation && visibilityGeneration === this.visibilityGeneration) void this.start(false);
  }
  submit(): Promise<void> { return this.action('submit'); }
  retry(): Promise<void> { return this.action('retry'); }
  stopTurn(): Promise<void> { return this.action('stop'); }
  dispose(): void {
    this.disposed = true; this.generation++; this.read?.control.abort(); this.write?.abort(); this.writer.dispose(); this.disposeSource();
    this.scope = null; this.observed = null; this.draft = ''; this.conversation = null; this.composer.reset();
  }
}
