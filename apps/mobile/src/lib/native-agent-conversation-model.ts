import { AgentTurnComposer, AgentTurnComposeFailure, type AgentTurnComposerView, type AgentTurnComposeRequest, type AgentTurnScope } from '@dex/protocol/agent-turn-composer';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileConversationView } from './native-agent-conversation-watch';
import type { MobileCanonicalUpdate } from './native-agent-focus-watch';
import { parseAgentFocus, type AgentFocus, type OwnedAgentSession } from '@dex/protocol/agent-session';
import { parseAgentSessionCatalogPage } from '@dex/protocol/agent-session-catalog';
import { validateCreateAgentSession, validateSwitchAgentFocus, parseCreatedAgentSession, parseSwitchedAgentFocus } from '@dex/protocol/agent-session-lifecycle';
import { MobileAgentLifecycleFailure, type MobileAgentLifecycleRequest } from './native-agent-lifecycle';

interface CatalogPort {
  read(signal?: AbortSignal, page?: { beforeId: string; authScope: string }): Promise<{ authScope: string; focus: unknown; sessions: unknown }>;
  send(request: MobileAgentLifecycleRequest, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}
export interface MobileAgentCatalogView {
  focus: AgentFocus | null; items: OwnedAgentSession[]; hasMore: boolean;
  busy: boolean; writeBlocked: boolean; canWrite: boolean; notice: string;
  olderPage: boolean; canLoadOlder: boolean; pageKnown: boolean;
}

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
  catalog: MobileAgentCatalogView;
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
  private catalogFocus: AgentFocus | null = null;
  private catalogItems: OwnedAgentSession[] = [];
  private catalogScope: string | null = null;
  private catalogReady = false;
  private catalogHasMore = false;
  private catalogNextCursor: string | null = null;
  private catalogOlderPage = false;
  private catalogPageKnown = false;
  private lifecycleBlocked = false;
  private catalogNotice = '';
  private catalogTask: AbortController | null = null;
  state!: MobileConversationModelView;

  constructor(private readonly account: Pick<MobileEnrollmentAccount, 'origin' | 'userId'>,
    private readonly watcher: Watcher,
    private readonly writer: { send(request: AgentTurnComposeRequest, signal?: AbortSignal): Promise<unknown>; dispose(): void },
    private readonly render: (value: MobileConversationModelView) => void,
    createKey: () => string,
    private readonly disposeSource: () => void = () => undefined,
    private readonly catalogPort?: CatalogPort) {
    this.composer = new AgentTurnComposer((request) => this.dispatch(request), (value) => {
      this.turn = value; if (this.state) this.publish();
    }, createKey);
    this.turn = this.composer.view; this.publish();
  }
  private publish(): void {
    this.state = { visible: this.visible, watching: Boolean(this.read), writing: Boolean(this.write) || this.actionBusy,
      conversation: this.visible ? this.conversation : null, hasMore: this.visible && this.hasMore,
      status: this.status, error: this.error, draft: this.visible ? this.draft : '', turn: this.turn,
      catalog: { focus: this.visible && this.catalogFocus ? { ...this.catalogFocus } : null, items: this.visible ? this.catalogItems.map((item) => ({ ...item })) : [],
        hasMore: this.visible && this.catalogHasMore, busy: Boolean(this.catalogTask), writeBlocked: this.lifecycleBlocked,
        canWrite: this.canWriteCatalog(), notice: this.visible ? this.catalogNotice : '',
        olderPage: this.visible && this.catalogOlderPage, canLoadOlder: this.canLoadOlderCatalog(), pageKnown: this.visible && this.catalogPageKnown } };
    if (!this.disposed) this.render(this.state);
  }
  private unavailable(): void { this.composer.context(this.scope, null, false); }
  setVisible(value: boolean): void {
    if (this.disposed || this.visible === value) return;
    this.visible = value;
    if (!value) {
      this.visibilityGeneration++;
      this.read?.control.abort(); this.write?.abort(); this.conversation = null; this.hasMore = false;
      this.catalogTask?.abort(); this.catalogReady = false;
      this.catalogFocus = null; this.catalogItems = []; this.catalogHasMore = false;
      this.catalogNextCursor = null; this.catalogOlderPage = false; this.catalogPageKnown = false; this.catalogNotice = '';
      this.status = '조회 중단'; this.error = ''; this.unavailable();
    }
    this.publish();
  }
  setDraft(value: string): void {
    if (!this.visible || this.disposed || this.write || this.actionBusy || this.catalogTask || this.lifecycleBlocked) return;
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
      if (this.catalogPort && this.catalogScope !== nextScope.profile) {
        this.catalogFocus = null; this.catalogItems = []; this.catalogHasMore = false; this.catalogReady = false;
        this.catalogNextCursor = null; this.catalogOlderPage = false; this.catalogPageKnown = false;
        // An unknown lifecycle outcome belongs to its original Platform Session only.
        if (this.catalogScope !== null) this.lifecycleBlocked = false;
        this.catalogScope = nextScope.profile;
      }
      if (this.catalogPort && identity && this.catalogFocus?.active_agent_session_id !== (value.snapshot?.id ?? null)) {
        this.catalogReady = false; this.catalogFocus = null; this.catalogItems = []; this.catalogHasMore = false;
        this.catalogNextCursor = null; this.catalogOlderPage = false; this.catalogPageKnown = false;
        this.catalogNotice = '공유 대화 선택이 바뀌었습니다. 최신 세션 목록을 직접 다시 조회하세요.';
      }
      this.composer.context(nextScope, value.snapshot, !update.hasMore && this.turnAvailable());
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
    if (!this.visible || this.disposed || this.write || this.actionBusy || this.read || this.catalogTask) return;
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
    if (this.write || this.actionBusy || this.disposed || this.catalogTask) return;
    this.read?.control.abort(); this.conversation = null; this.hasMore = false; this.status = '조회 중단'; this.unavailable(); this.publish();
  }
  private async dispatch(request: AgentTurnComposeRequest): Promise<unknown> {
    if (this.write || !this.visible || this.disposed || !this.scope || request.scope.profile !== this.scope.profile
      || !this.turnAvailable() || this.conversation?.snapshot?.id !== request.agent_session_id) throw new AgentTurnComposeFailure('unavailable');
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
    if (this.disposed || !this.visible || this.write || this.actionBusy || this.catalogTask || !this.turnAvailable()) return;
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
  private turnAvailable(): boolean {
    return !this.catalogPort || (!this.catalogTask && !this.lifecycleBlocked && this.catalogReady
      && this.catalogScope === this.scope?.profile && this.catalogFocus?.active_agent_session_id === (this.conversation?.snapshot?.id ?? null));
  }
  private canWriteCatalog(): boolean {
    return Boolean(this.catalogPort && this.visible && !this.disposed && this.catalogReady && this.catalogFocus && this.scope
      && this.catalogScope === this.scope.profile && !this.lifecycleBlocked && !this.catalogTask && !this.write && !this.actionBusy
      && !(this.turn.request && this.turn.status === 'unavailable')
      && !['unknown', 'sending', 'stopping', 'accepted', 'stop-requested'].includes(this.turn.status));
  }
  private acceptFocus(authScope: string, focus: AgentFocus): void {
    const identity = `${authScope}:${focus.active_agent_session_id ?? 'none'}`;
    if ((this.scope && this.scope.profile !== authScope) || (this.observed && identity !== this.observed)) {
      this.generation++; this.draft = ''; this.conversation = null; this.hasMore = false; this.composer.reset();
    }
    if (this.catalogScope !== null && this.catalogScope !== authScope) this.lifecycleBlocked = false;
    this.observed = identity; this.catalogScope = authScope;
    this.scope = { platform_type: 'mobile', profile: authScope, server_url: this.account.origin, user_id: this.account.userId };
    this.catalogFocus = focus;
    // Catalog proves selection, not a conversation snapshot or a running turn.
    this.unavailable();
  }
  private canLoadOlderCatalog(): boolean {
    return Boolean(this.catalogPort && this.visible && !this.disposed && this.catalogReady && this.catalogPageKnown && this.catalogFocus && this.catalogScope
      && this.catalogScope === this.scope?.profile && this.catalogHasMore && this.catalogNextCursor
      && !this.lifecycleBlocked && !this.catalogTask && !this.write && !this.actionBusy);
  }
  refreshCatalog(): Promise<boolean> { return this.readCatalog(false); }
  loadOlderCatalog(): Promise<boolean> { return this.readCatalog(true); }
  private async readCatalog(older: boolean): Promise<boolean> {
    if (!this.catalogPort || !this.visible || this.disposed || this.catalogTask || this.write || this.actionBusy) return false;
    if (older && !this.canLoadOlderCatalog()) return false;
    const priorFocus = this.catalogFocus ? { ...this.catalogFocus } : null;
    const previousItems = this.catalogItems.map((item) => ({ ...item }));
    const page = older ? { beforeId: this.catalogNextCursor!, authScope: this.catalogScope! } : undefined;
    const control = new AbortController(); this.catalogTask = control; const visibility = this.visibilityGeneration;
    const reading = this.read; reading?.control.abort(); this.catalogReady = false; this.catalogNotice = ''; this.unavailable(); this.publish();
    let success = false;
    try {
      await reading?.done; control.signal.throwIfAborted();
      const result = await this.catalogPort.read(control.signal, page);
      if (this.disposed || !this.visible || control.signal.aborted || visibility !== this.visibilityGeneration) return false;
      if (typeof result.authScope !== 'string' || !/^[0-9a-f]{64}$/.test(result.authScope)) throw new TypeError();
      const focus = parseAgentFocus(result.focus);
      if (page && (result.authScope !== page.authScope || !priorFocus || focus.version !== priorFocus.version
        || focus.event_id !== priorFocus.event_id || focus.active_agent_session_id !== priorFocus.active_agent_session_id)) {
        this.acceptFocus(result.authScope, focus); this.catalogItems = []; this.catalogHasMore = false;
        this.catalogNextCursor = null; this.catalogOlderPage = false; this.catalogPageKnown = false;
        this.catalogNotice = '기기 세션 또는 현재 선택이 바뀌었습니다. 최신 목록을 직접 다시 조회하세요.';
        return false;
      }
      const sessions = parseAgentSessionCatalogPage(result.sessions, page?.beforeId, previousItems);
      this.acceptFocus(result.authScope, focus); this.catalogItems = sessions.items; this.catalogHasMore = sessions.has_more;
      this.catalogNextCursor = sessions.next_cursor; this.catalogOlderPage = older; this.catalogPageKnown = true;
      this.catalogReady = true; if (!older) this.lifecycleBlocked = false;
      this.catalogNotice = older ? '이전 세션 목록을 확인했습니다. 현재 대화 선택은 유지됩니다.' : '현재 선택과 내 세션 목록을 확인했습니다.';
      this.error = ''; success = true;
    } catch {
      if (!this.disposed && !control.signal.aborted) this.catalogNotice = '세션 목록을 확인하지 못했습니다. 기기 키·세션과 서버 상태를 확인하세요.';
    } finally { if (this.catalogTask === control) this.catalogTask = null; this.publish(); }
    if (success && this.catalogFocus?.active_agent_session_id && this.visible && visibility === this.visibilityGeneration) void this.start(false);
    return success;
  }
  async createSession(workflowId: string, title = ''): Promise<boolean> {
    if (!this.canWriteCatalog()) return false;
    try { return await this.lifecycle({ scope: { ...this.scope! }, operation: 'create',
      input: validateCreateAgentSession({ workflow_id: workflowId, title, expected_version: this.catalogFocus!.version }) }); }
    catch { this.error = 'Workflow ID와 제목 형식을 확인하세요.'; this.publish(); return false; }
  }
  async selectSession(id: string | null): Promise<boolean> {
    if (!this.canWriteCatalog()) return false;
    if (id !== null && !this.catalogItems.some((item) => item.id === id && item.status === 'active')) {
      this.error = '조회된 내 활성 세션만 선택할 수 있습니다.'; this.publish(); return false;
    }
    return this.lifecycle({ scope: { ...this.scope! }, operation: 'switch',
      input: validateSwitchAgentFocus({ active_agent_session_id: id, expected_version: this.catalogFocus!.version }) });
  }
  private async lifecycle(request: MobileAgentLifecycleRequest): Promise<boolean> {
    if (!this.canWriteCatalog()) return false;
    const control = new AbortController(); this.catalogTask = control; const visibility = this.visibilityGeneration;
    const reading = this.read; reading?.control.abort(); this.catalogNotice = ''; this.error = ''; this.unavailable(); this.publish();
    let success = false; let dispatched = false;
    try {
      await reading?.done; control.signal.throwIfAborted();
      dispatched = true;
      const value = await this.catalogPort!.send(request, control.signal);
      if (this.disposed) return false;
      if (control.signal.aborted || !this.visible || visibility !== this.visibilityGeneration) throw new MobileAgentLifecycleFailure('unknown');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileAgentLifecycleFailure('unknown');
      const result = value as Record<string, unknown>;
      for (const key of ['platform_type', 'profile', 'server_url', 'user_id'] as const) {
        if (result[key] !== request.scope[key]) throw new MobileAgentLifecycleFailure('unknown');
      }
      const created = request.operation === 'create' ? parseCreatedAgentSession(result.created, request.input) : null;
      const focus = created ? created.focus : parseSwitchedAgentFocus(result.focus, (request as Extract<MobileAgentLifecycleRequest, { operation: 'switch' }>).input);
      this.acceptFocus(request.scope.profile, focus); this.catalogReady = true;
      if (created) {
        // A new session does not belong to an older keyset page. Require a fresh latest page
        // before reusing its continuation instead of splicing a fabricated page boundary.
        this.catalogItems = [{ id: created.id, workflow_id: created.workflow_id, title: request.operation === 'create' ? request.input.title ?? '' : '',
          status: 'active' as const, state_version: 1, current_sequence: 0 }, ...this.catalogItems.filter((item) => item.id !== created.id)].slice(0, 100);
        this.catalogHasMore = false; this.catalogNextCursor = null; this.catalogOlderPage = false; this.catalogPageKnown = false;
      }
      this.catalogNotice = created ? '공유 대화를 생성하고 선택했습니다.' : '공유 대화 선택을 확인했습니다.'; success = true;
    } catch (error) {
      if (!this.disposed) {
        const failure = error instanceof MobileAgentLifecycleFailure ? error : new MobileAgentLifecycleFailure(dispatched ? 'unknown' : 'unavailable');
        if (failure.outcome === 'unknown' || failure.conflict) { this.lifecycleBlocked = true; this.catalogReady = false;
          this.conversation = null; this.hasMore = false; this.unavailable(); }
        if (failure.conflict) this.acceptFocus(request.scope.profile, parseAgentFocus(failure.conflict.current));
        this.catalogNotice = failure.conflict ? '다른 기기에서 선택이 바뀌었습니다. 목록을 직접 다시 조회하고 선택하세요.' : failure.message;
      }
    } finally { if (this.catalogTask === control) this.catalogTask = null; this.publish(); }
    if (success && this.visible && visibility === this.visibilityGeneration && this.catalogFocus?.active_agent_session_id) void this.start(false);
    return success;
  }
  dispose(): void {
    this.disposed = true; this.generation++; this.read?.control.abort(); this.write?.abort(); this.catalogTask?.abort();
    this.catalogPort?.dispose(); this.writer.dispose(); this.disposeSource();
    this.visible = false; this.scope = null; this.observed = null; this.draft = ''; this.conversation = null;
    this.catalogFocus = null; this.catalogItems = []; this.catalogScope = null; this.catalogNextCursor = null;
    this.catalogOlderPage = false; this.catalogPageKnown = false; this.composer.reset();
  }
}
