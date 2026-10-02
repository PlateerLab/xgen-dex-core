import { DexError } from '@dex/engine';
import { parseAgentFocus, type AgentFocus, type OwnedAgentSession } from '@dex/protocol/agent-session';
import { parseAgentSessionCatalogPage } from '@dex/protocol/agent-session-catalog';
import {
  AgentSessionLifecycleOutcomeUnknown,
  parseCreatedAgentSession,
  parseSwitchedAgentFocus,
  validateCreateAgentSession,
  validateSwitchAgentFocus,
} from '@dex/protocol/agent-session-lifecycle';
import {
  AgentTurnComposeFailure,
  AgentTurnComposer,
  type AgentTurnComposeRequest,
  type AgentTurnComposerView,
  type AgentTurnScope,
} from '@dex/protocol/agent-turn-composer';
import { CanonicalTuiController } from './canonical-controller';
import type {
  CanonicalTuiChatSource,
  CanonicalTuiChatView,
} from './canonical-chat-types';
import type { CanonicalTuiAccount, CanonicalTuiView } from './canonical-types';

type Listener = (view: CanonicalTuiChatView) => void;
type OperationKind = 'catalog' | 'lifecycle' | 'turn';

interface ActiveOperation {
  kind: OperationKind;
  control: AbortController;
  done: Promise<void>;
  binding?: string;
}

interface CatalogState {
  focus: AgentFocus | null;
  items: OwnedAgentSession[];
  nextCursor: string | null;
  hasMore: boolean;
  olderPage: boolean;
  busy: boolean;
  notice: string;
}

const emptyCatalog = (): CatalogState => ({
  focus: null, items: [], nextCursor: null, hasMore: false,
  olderPage: false, busy: false, notice: '',
});

const safe = {
  catalog: 'Agent 세션 목록을 확인하지 못했습니다. 현재 페이지를 유지합니다.',
  catalogOlder: '이전 Agent 세션 페이지를 확인하지 못했습니다. 현재 페이지를 유지합니다.',
  catalogLatest: '최신 Agent 세션 목록과 현재 포커스를 확인했습니다.',
  catalogOlderOk: '이전 Agent 세션 페이지를 확인했습니다.',
  binding: '현재 계정의 네이티브 세션 범위를 확인할 수 없습니다.',
  lifecycleUnknown: '작업 완료 여부를 확인할 수 없습니다. 최신 목록을 다시 확인하기 전에는 쓰기 작업을 할 수 없습니다.',
  lifecycleRejected: 'Agent 세션 작업이 거부되었습니다. 최신 목록을 확인하세요.',
  lifecycleUnavailable: '현재 연결에서는 Agent 세션 작업을 할 수 없습니다.',
  focusChanged: '현재 대화가 바뀌었습니다. 최신 목록과 대화를 다시 확인하세요.',
  created: '새 Agent 세션을 만들고 현재 대화로 선택했습니다.',
  selected: '현재 Agent 세션 포커스를 변경했습니다.',
  invalidInput: 'Agent 세션 입력 형식을 확인하세요.',
  invalidSelection: '새로 확인한 내 활성 Agent 세션만 선택할 수 있습니다.',
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validBinding(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192;
}

function sameFocus(a: AgentFocus | null, b: AgentFocus | null): boolean {
  return a?.active_agent_session_id === b?.active_agent_session_id
    && a?.version === b?.version && a?.event_id === b?.event_id;
}

function copyFocus(value: AgentFocus | null): AgentFocus | null {
  return value === null ? null : { ...value };
}

function copyItems(values: readonly OwnedAgentSession[]): OwnedAgentSession[] {
  return values.map((value) => ({ ...value }));
}

function blockingTurn(view: AgentTurnComposerView): boolean {
  return ['sending', 'accepted', 'stopping', 'stop-requested', 'unknown'].includes(view.status)
    || (view.status === 'unavailable' && view.request !== undefined);
}

function cloneTurn(view: AgentTurnComposerView): AgentTurnComposerView {
  return {
    ...view,
    ...(view.request ? { request: { ...view.request } } : {}),
    ...(view.submitted ? { submitted: { ...view.submitted } } : {}),
    ...(view.stopped ? { stopped: { ...view.stopped } } : {}),
  };
}

function cloneBase(view: CanonicalTuiView): CanonicalTuiView {
  return {
    ...view,
    conversation: view.conversation === null ? null : {
      snapshot: view.conversation.snapshot === null ? null : {
        ...view.conversation.snapshot,
        ...(view.conversation.snapshot.latest_turn
          ? { latest_turn: { ...view.conversation.snapshot.latest_turn } }
          : {}),
      },
      messages: view.conversation.messages.map((message) => ({ ...message })),
      omittedMessages: view.conversation.omittedMessages,
    },
  };
}

/** Owns the CLI read, catalog, lifecycle and turn-write state without exposing native bindings. */
export class CanonicalTuiChatModel {
  private readonly controller: CanonicalTuiController;
  private readonly composer: AgentTurnComposer;
  private readonly removeController: () => void;
  private readonly listeners = new Set<Listener>();
  private base: CanonicalTuiView;
  private turn!: AgentTurnComposerView;
  private catalog = emptyCatalog();
  private draft = '';
  private binding: string | null = null;
  private conversationIdentity: string | null = null;
  private identityKnown = false;
  private authoritativeRead = false;
  private lifecycleBlocked = false;
  private operation: ActiveOperation | null = null;
  private turnDraft: string | null = null;
  private disposed = false;
  private ready = false;

  constructor(
    private readonly account: CanonicalTuiAccount,
    private readonly source: CanonicalTuiChatSource,
    createKey?: () => string,
  ) {
    this.controller = new CanonicalTuiController(source, account.userId);
    this.base = this.controller.state;
    this.composer = new AgentTurnComposer(
      (request) => this.sendTurn(request),
      (view) => {
        this.turn = view;
        if (this.ready) this.publish();
      },
      createKey,
    );
    this.turn = this.composer.view;
    this.removeController = this.controller.subscribe((view) => this.controllerView(view));
    this.ready = true;
    this.syncComposer();
    this.publish();
  }

  get state(): CanonicalTuiChatView {
    return this.snapshot();
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) {
      this.notify(listener);
      return () => {};
    }
    this.listeners.add(listener);
    this.notify(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read(): Promise<boolean> {
    if (this.disposed || this.operation) return false;
    return this.controller.read();
  }

  watch(): Promise<boolean> {
    if (this.disposed || this.operation) return Promise.resolve(false);
    return this.controller.watch();
  }

  async stop(): Promise<void> {
    this.operation?.control.abort();
    const operation = this.operation?.done;
    await this.controller.stop();
    if (operation) await operation;
    await this.settle();
    this.authoritativeRead = false;
    this.syncComposer();
    this.publish();
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.operation?.control.abort();
      this.authoritativeRead = false;
      this.binding = null;
      this.identityKnown = false;
      this.conversationIdentity = null;
      this.lifecycleBlocked = false;
      this.draft = '';
      this.turnDraft = null;
      this.catalog = emptyCatalog();
      this.composer.reset();
      this.base = {
        status: 'stopped', busy: false, watching: false, conversation: null,
        hasMore: false, notice: '실시간 연결이 중지되었습니다.', error: '',
      };
      this.publish();
      this.listeners.clear();
      this.removeController();
    }
    const operation = this.operation?.done;
    await this.controller.dispose();
    if (operation) await operation;
    await this.settle();
  }

  setDraft(value: string): void {
    if (typeof value !== 'string' || !this.state.canEdit) return;
    this.draft = value;
    this.publish();
  }

  async loadCatalog(older = false): Promise<boolean> {
    if (this.disposed || this.operation) return false;
    const previous = this.catalog;
    const beforeId = older ? previous.nextCursor ?? undefined : undefined;
    if (older && (!previous.focus || !previous.hasMore || !beforeId)) return false;
    const result = await this.exclusive('catalog', true, async (signal) => {
      const raw = await this.source.catalog(signal, beforeId);
      if (signal.aborted || this.disposed) throw new Error('catalog cancelled');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !validBinding(raw.binding)
        || this.source.binding() !== raw.binding) throw new Error('invalid catalog binding');
      const focus = parseAgentFocus(raw.focus);
      const sessions = parseAgentSessionCatalogPage(raw.sessions, beforeId,
        older ? previous.items : []);
      const bindingChanged = this.binding !== null && this.binding !== raw.binding;
      const focusChanged = this.catalog.focus !== null && !sameFocus(this.catalog.focus, focus);
      const conversationChanged = this.identityKnown
        && this.conversationIdentity !== focus.active_agent_session_id;
      if (bindingChanged || focusChanged || conversationChanged) {
        this.resetPrivate(raw.binding);
      } else {
        this.binding = raw.binding;
      }
      if (older && (bindingChanged || focusChanged || conversationChanged)) {
        this.catalog = {
          ...emptyCatalog(), focus: copyFocus(focus),
          notice: safe.focusChanged,
        };
        this.lifecycleBlocked = true;
        return false;
      }
      this.catalog = {
        focus: copyFocus(focus), items: copyItems(sessions.items),
        nextCursor: sessions.next_cursor, hasMore: sessions.has_more,
        olderPage: older, busy: false,
        notice: older ? safe.catalogOlderOk : safe.catalogLatest,
      };
      if (!older) this.lifecycleBlocked = false;
      return true;
    }, () => {
      this.catalog = { ...previous, busy: false,
        notice: older ? safe.catalogOlder : safe.catalog };
    });
    if (result) await this.recoverConversation();
    return result;
  }

  async create(workflowId: string, title: string): Promise<boolean> {
    const writable = this.writableCatalog();
    if (!writable) return false;
    let input;
    try {
      input = validateCreateAgentSession({
        workflow_id: workflowId, title, expected_version: writable.focus.version,
      });
    } catch {
      this.catalog = { ...this.catalog, notice: safe.invalidInput };
      this.publish();
      return false;
    }
    return this.lifecycle('create', writable.binding, input);
  }

  async select(sessionId: string | null): Promise<boolean> {
    const writable = this.writableCatalog();
    if (!writable) return false;
    if (sessionId !== null
      && !writable.items.some((item) => item.id === sessionId && item.status === 'active')) {
      this.catalog = { ...this.catalog, notice: safe.invalidSelection };
      this.publish();
      return false;
    }
    let input;
    try {
      input = validateSwitchAgentFocus({
        active_agent_session_id: sessionId, expected_version: writable.focus.version,
      });
    } catch {
      this.catalog = { ...this.catalog, notice: safe.invalidInput };
      this.publish();
      return false;
    }
    return this.lifecycle('select', writable.binding, input);
  }

  async submit(): Promise<boolean> {
    if (this.disposed || this.operation || !this.turn.canSubmit || !this.draft) return false;
    const logicalDraft = this.draft;
    const context = this.writeContext();
    if (!context) return false;
    this.turnDraft = logicalDraft;
    const result = await this.exclusive('turn', false, async () => {
      try {
        const accepted = await this.composer.submit(logicalDraft);
        if (!accepted) return false;
        if (this.sameWriteContext(context) && this.draft === logicalDraft) this.draft = '';
        this.turnDraft = null;
        return true;
      } catch {
        if (!['unknown', 'unavailable'].includes(this.composer.view.status)) this.turnDraft = null;
        return false;
      }
    });
    if (result) await this.recoverConversation();
    return result;
  }

  async retry(): Promise<boolean> {
    if (this.disposed || this.operation || !this.turn.canRetry) return false;
    const context = this.writeContext();
    if (!context) return false;
    const logicalDraft = this.turnDraft;
    const result = await this.exclusive('turn', false, async () => {
      try {
        const accepted = await this.composer.retry();
        if (!accepted) return false;
        if (logicalDraft !== null && this.sameWriteContext(context) && this.draft === logicalDraft) {
          this.draft = '';
        }
        this.turnDraft = null;
        return true;
      } catch {
        return false;
      }
    });
    if (result) await this.recoverConversation();
    return result;
  }

  async stopTurn(): Promise<boolean> {
    if (this.disposed || this.operation || !this.turn.canStop) return false;
    const result = await this.exclusive('turn', false, async () => {
      try { return Boolean(await this.composer.stop()); }
      catch { return false; }
    });
    if (result) await this.recoverConversation();
    return result;
  }

  private async lifecycle(
    kind: 'create' | 'select',
    binding: string,
    input: ReturnType<typeof validateCreateAgentSession> | ReturnType<typeof validateSwitchAgentFocus>,
  ): Promise<boolean> {
    const previousFocus = this.catalog.focus;
    const result = await this.exclusive('lifecycle', true, async (signal) => {
      try {
        let focus: AgentFocus;
        if (kind === 'create') {
          const response = await this.source.create(
            binding, input as ReturnType<typeof validateCreateAgentSession>, signal,
          );
          if (signal.aborted || this.disposed) throw new AgentSessionLifecycleOutcomeUnknown();
          const created = parseCreatedAgentSession(response,
            input as ReturnType<typeof validateCreateAgentSession>);
          focus = created.focus;
        } else {
          const response = await this.source.select(
            binding, input as ReturnType<typeof validateSwitchAgentFocus>, signal,
          );
          if (signal.aborted || this.disposed) throw new AgentSessionLifecycleOutcomeUnknown();
          focus = parseSwitchedAgentFocus(response,
            input as ReturnType<typeof validateSwitchAgentFocus>);
        }
        if (this.source.binding() !== binding) throw new AgentSessionLifecycleOutcomeUnknown();
        const changed = !sameFocus(previousFocus, focus);
        if (changed) this.resetPrivate(binding);
        this.binding = binding;
        this.catalog = {
          ...emptyCatalog(), focus: copyFocus(focus),
          notice: kind === 'create' ? safe.created : safe.selected,
        };
        this.lifecycleBlocked = false;
        return true;
      } catch (error) {
        if (this.disposed) return false;
        this.lifecycleFailure(error, binding, previousFocus);
        return false;
      }
    });
    if (result && this.catalog.focus?.active_agent_session_id) await this.recoverConversation();
    return result;
  }

  private lifecycleFailure(error: unknown, binding: string, previousFocus: AgentFocus | null): void {
    const details = error instanceof DexError ? record(error.details) : null;
    const outcome = details?.outcome;
    const conflict = record(details?.conflict);
    if (outcome === 'rejected' && conflict?.code === 'FOCUS_VERSION_CONFLICT') {
      try {
        const focus = parseAgentFocus(conflict.current);
        if (!sameFocus(previousFocus, focus)) this.resetPrivate(binding);
        this.binding = binding;
        this.catalog = { ...emptyCatalog(), focus: copyFocus(focus), notice: safe.focusChanged };
        this.lifecycleBlocked = true;
        return;
      } catch { /* malformed conflict has an unknown write outcome */ }
    }
    if (outcome === 'rejected') {
      this.catalog = { ...this.catalog, busy: false, notice: safe.lifecycleRejected };
      return;
    }
    const unknown = outcome === 'unknown' || error instanceof AgentSessionLifecycleOutcomeUnknown
      || !(error instanceof DexError);
    this.lifecycleBlocked = unknown;
    this.catalog = { ...this.catalog, busy: false,
      notice: unknown ? safe.lifecycleUnknown : safe.lifecycleUnavailable };
  }

  private writableCatalog(): { binding: string; focus: AgentFocus; items: OwnedAgentSession[] } | null {
    if (this.disposed || this.operation || !this.authoritativeRead || !validBinding(this.binding)
      || !this.catalog.focus || this.lifecycleBlocked || blockingTurn(this.turn)) return null;
    return { binding: this.binding, focus: this.catalog.focus, items: this.catalog.items };
  }

  private async sendTurn(request: AgentTurnComposeRequest): Promise<unknown> {
    const operation = this.operation;
    const binding = operation?.binding;
    if (!operation || operation.kind !== 'turn' || !validBinding(binding)) {
      throw new AgentTurnComposeFailure('unavailable');
    }
    await this.controller.stop();
    await this.settle();
    if (operation.control.signal.aborted || this.source.binding() !== binding) {
      throw new AgentTurnComposeFailure('unavailable');
    }
    try {
      const response = await this.source.send(binding, request, operation.control.signal);
      if (operation.control.signal.aborted || this.disposed) {
        throw new AgentTurnComposeFailure('unknown');
      }
      return response;
    } catch (error) {
      if (error instanceof AgentTurnComposeFailure) {
        throw new AgentTurnComposeFailure(error.outcome, error.conflict);
      }
      throw new AgentTurnComposeFailure('unknown');
    }
  }

  private async exclusive(
    kind: OperationKind,
    drainBefore: boolean,
    work: (signal: AbortSignal) => Promise<boolean>,
    failed?: () => void,
  ): Promise<boolean> {
    if (this.disposed || this.operation) return false;
    const control = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation: ActiveOperation = { kind, control, done };
    if (kind === 'turn') operation.binding = this.binding ?? undefined;
    this.operation = operation;
    if (kind === 'catalog') this.catalog = { ...this.catalog, busy: true, notice: '' };
    // A turn must enter the composer before the controller stop makes its context
    // unavailable. That lets the composer retain the exact private request on an
    // uncertain outcome while the model still publishes the operation as busy.
    if (kind !== 'turn') this.syncComposer();
    this.publish();
    let result = false;
    try {
      if (drainBefore) {
        await this.controller.stop();
        await this.settle();
        if (control.signal.aborted) return false;
      }
      result = await work(control.signal);
      return result;
    } catch {
      if (!this.disposed) failed?.();
      return false;
    } finally {
      await this.settle();
      if (this.operation === operation) this.operation = null;
      if (kind === 'catalog') this.catalog = { ...this.catalog, busy: false };
      this.syncComposer();
      this.publish();
      finish();
    }
  }

  private controllerView(view: CanonicalTuiView): void {
    if (this.disposed) return;
    this.base = cloneBase(view);
    this.authoritativeRead = view.status === 'connected' && view.conversation !== null;
    if (this.authoritativeRead) {
      const nextBinding = this.source.binding();
      if (!validBinding(nextBinding)) {
        this.authoritativeRead = false;
        this.base = {
          status: 'stopped', busy: false, watching: false, conversation: null,
          hasMore: false, notice: '', error: safe.binding,
        };
      } else {
        if (this.binding !== null && this.binding !== nextBinding) this.resetPrivate(nextBinding);
        this.binding = nextBinding;
        const sessionId = view.conversation?.snapshot?.id ?? null;
        const changedIdentity = this.identityKnown && this.conversationIdentity !== sessionId;
        const contradictsCatalog = this.catalog.focus !== null
          && this.catalog.focus.active_agent_session_id !== sessionId;
        if (changedIdentity || contradictsCatalog) {
          this.resetPrivate(nextBinding);
          this.catalog = { ...emptyCatalog(), notice: safe.focusChanged };
        }
        // resetPrivate fences the previous context. This already-validated
        // controller snapshot establishes the replacement context immediately.
        this.authoritativeRead = true;
        this.identityKnown = true;
        this.conversationIdentity = sessionId;
      }
    }
    this.syncComposer();
    this.publish();
  }

  private resetPrivate(nextBinding: string | null): void {
    const lifecycleBlocked = this.lifecycleBlocked;
    this.binding = nextBinding;
    this.identityKnown = false;
    this.conversationIdentity = null;
    this.authoritativeRead = false;
    this.lifecycleBlocked = lifecycleBlocked;
    this.draft = '';
    this.turnDraft = null;
    this.catalog = emptyCatalog();
    this.composer.reset();
  }

  private syncComposer(): void {
    const scope = this.binding === null ? null : this.scope();
    const snapshot = this.authoritativeRead ? this.base.conversation?.snapshot ?? null : null;
    const available = this.authoritativeRead && !this.lifecycleBlocked && this.operation === null;
    try { this.composer.context(scope, snapshot, available); }
    catch { this.composer.reset(); }
    this.turn = this.composer.view;
  }

  private scope(): AgentTurnScope {
    return {
      platform_type: 'cli', profile: this.account.profile,
      server_url: this.account.origin, user_id: this.account.userId,
    };
  }

  private writeContext(): { binding: string; session: string; focus: number | null } | null {
    const snapshot = this.base.conversation?.snapshot;
    if (!validBinding(this.binding) || !this.authoritativeRead || !snapshot) return null;
    return { binding: this.binding, session: snapshot.id, focus: this.catalog.focus?.version ?? null };
  }

  private sameWriteContext(value: { binding: string; session: string; focus: number | null }): boolean {
    return this.binding === value.binding && this.identityKnown
      && this.conversationIdentity === value.session
      && (this.catalog.focus?.version ?? null) === value.focus;
  }

  private async recoverConversation(): Promise<void> {
    if (this.disposed || this.operation) return;
    await this.controller.read();
  }

  private async settle(): Promise<void> {
    try { await this.source.settle(); } catch { /* drain failure never exposes native details */ }
  }

  private snapshot(): CanonicalTuiChatView {
    const base = cloneBase(this.base);
    const writing = this.operation?.kind === 'lifecycle' || this.operation?.kind === 'turn';
    const canWrite = this.authoritativeRead && validBinding(this.binding) && this.catalog.focus !== null
      && !this.lifecycleBlocked && !this.operation && !blockingTurn(this.turn);
    const canEdit = this.authoritativeRead && this.base.conversation?.snapshot !== null
      && !this.lifecycleBlocked && !this.operation && this.turn.canSubmit;
    return {
      ...base,
      draft: this.draft,
      writing,
      canEdit,
      turn: cloneTurn(this.turn),
      catalog: {
        focus: copyFocus(this.catalog.focus), items: copyItems(this.catalog.items),
        nextCursor: this.catalog.nextCursor, hasMore: this.catalog.hasMore,
        olderPage: this.catalog.olderPage, busy: this.catalog.busy,
        writeBlocked: this.lifecycleBlocked, canWrite,
        canLoadOlder: !this.operation && this.catalog.focus !== null
          && this.catalog.hasMore && this.catalog.nextCursor !== null,
        notice: this.catalog.notice,
      },
    };
  }

  private publish(): void {
    if (!this.ready) return;
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: Listener): void {
    try { listener(this.snapshot()); } catch { /* rendering cannot change native ownership */ }
  }
}
