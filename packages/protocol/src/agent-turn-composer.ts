/** UI-neutral state machine for Canonical Agent Session turn writes. */

import {
  parseStoppedAgentTurn,
  parseSubmittedAgentTurn,
  validateStopAgentTurn,
  validateSubmitAgentTurn,
  type AgentSessionMutationConflict,
  type StopAgentTurnInput,
  type StoppedAgentTurn,
  type SubmitAgentTurnInput,
  type SubmittedAgentTurn,
} from './agent-session-mutation';
import { parseAgentSessionSnapshot, type AgentSessionSnapshot } from './agent-session';
import type { AgentAttachmentReference } from './agent-session-attachments';

const CONFLICT_CODES = new Set([
  'STATE_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'TURN_IN_PROGRESS',
  'TURN_NOT_RUNNING',
  'TURN_ID_CONFLICT',
  'TURN_NOT_STARTED',
  'TURN_STOP_UNAVAILABLE',
]);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface AgentTurnScope {
  platform_type: 'vscode' | 'desktop' | 'mobile' | 'cli';
  profile: string;
  server_url: string;
  user_id: string;
}

type ComposeRequestBase = { scope: AgentTurnScope; agent_session_id: string };
export type AgentTurnComposeRequest =
  | (ComposeRequestBase & { operation: 'submit'; input: SubmitAgentTurnInput })
  | (ComposeRequestBase & { operation: 'stop'; input: StopAgentTurnInput });

export interface AgentTurnComposerRequestView {
  readonly operation: 'submit' | 'stop';
  readonly agent_session_id: string;
  readonly expected_state_version: number;
  readonly idempotency_key?: string;
  readonly turn_id?: string;
}

export interface AgentTurnComposerView {
  readonly status: 'idle' | 'sending' | 'accepted' | 'stopping' | 'stop-requested'
    | 'rejected' | 'unknown' | 'unavailable';
  readonly canSubmit: boolean;
  readonly canRetry: boolean;
  readonly canStop: boolean;
  readonly notice: string;
  readonly request?: AgentTurnComposerRequestView;
  readonly submitted?: SubmittedAgentTurn;
  readonly stopped?: StoppedAgentTurn;
}

export type AgentTurnComposeFailureOutcome = 'rejected' | 'unknown' | 'unavailable';

function safeConflict(value: unknown): AgentSessionMutationConflict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== 'string' || !CONFLICT_CODES.has(raw.code)) return undefined;
  if (raw.current_state_version !== undefined
    && (typeof raw.current_state_version !== 'number' || !Number.isSafeInteger(raw.current_state_version)
      || raw.current_state_version < 1)) return undefined;
  if (raw.current_turn_id !== undefined
    && (typeof raw.current_turn_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.current_turn_id))) return undefined;
  return {
    code: raw.code as AgentSessionMutationConflict['code'],
    ...(raw.current_state_version === undefined ? {} : { current_state_version: raw.current_state_version as number }),
    ...(raw.current_turn_id === undefined ? {} : { current_turn_id: raw.current_turn_id as string }),
  };
}

/** A safe adapter boundary. Native/RPC errors must be normalized before entering the composer. */
export class AgentTurnComposeFailure extends Error {
  static readonly messages: Readonly<Record<AgentTurnComposeFailureOutcome, string>> = Object.freeze({
    rejected: '요청이 거부되었습니다. 최신 대화 상태를 확인하세요.',
    unknown: '요청 결과를 확인할 수 없습니다. 상태를 확인한 뒤 명시적으로 다시 시도하세요.',
    unavailable: '현재 연결에서는 요청을 보낼 수 없습니다.',
  });

  readonly conflict?: AgentSessionMutationConflict;

  constructor(readonly outcome: AgentTurnComposeFailureOutcome, conflict?: AgentSessionMutationConflict) {
    if (!['rejected', 'unknown', 'unavailable'].includes(outcome)) {
      throw new TypeError('Invalid Agent Turn compose failure');
    }
    super(AgentTurnComposeFailure.messages[outcome]);
    this.name = 'AgentTurnComposeFailure';
    const normalized = safeConflict(conflict);
    if (normalized) this.conflict = Object.freeze(normalized);
  }
}

type ComposerStatus = AgentTurnComposerView['status'];
type Intent = {
  request: AgentTurnComposeRequest;
  scopeKey: string;
  sessionId: string;
};

function scope(value: AgentTurnScope): AgentTurnScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
      || !['platform_type', 'profile', 'server_url', 'user_id'].includes(key))
    || !['vscode', 'desktop', 'mobile', 'cli'].includes(value.platform_type)
    || typeof value.profile !== 'string' || value.profile.length < 1 || value.profile.length > 1024
    || typeof value.user_id !== 'string'
    || !/^[1-9][0-9]{0,9}$/.test(value.user_id) || Number(value.user_id) > 2147483647) {
    throw new TypeError('Invalid Agent Turn scope');
  }
  let url: URL;
  try { url = new URL(value.server_url); } catch { throw new TypeError('Invalid Agent Turn scope'); }
  if (url.protocol !== 'https:' || value.server_url !== url.origin || url.username || url.password) {
    throw new TypeError('Invalid Agent Turn scope');
  }
  return { platform_type: value.platform_type, profile: value.profile, server_url: value.server_url, user_id: value.user_id };
}

function scopeKey(value: AgentTurnScope): string {
  return JSON.stringify([value.platform_type, value.profile, value.server_url, value.user_id]);
}

function copyScope(value: AgentTurnScope): AgentTurnScope { return { ...value }; }
function copySubmitted(value: SubmittedAgentTurn): SubmittedAgentTurn { return { ...value }; }
function copyStopped(value: StoppedAgentTurn): StoppedAgentTurn { return { ...value }; }
function copySubmitInput(value: SubmitAgentTurnInput): SubmitAgentTurnInput {
  return {
    ...value,
    ...(value.attachments
      ? { attachments: value.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}
function terminal(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.latest_turn === null || snapshot.latest_turn === undefined || TERMINAL.has(snapshot.latest_turn.status);
}

function requestView(request: AgentTurnComposeRequest): AgentTurnComposerRequestView {
  return request.operation === 'submit'
    ? { operation: 'submit', agent_session_id: request.agent_session_id,
      expected_state_version: request.input.expected_state_version, idempotency_key: request.input.idempotency_key }
    : { operation: 'stop', agent_session_id: request.agent_session_id,
      expected_state_version: request.input.expected_state_version, turn_id: request.input.turn_id };
}

function cloneRequest(request: AgentTurnComposeRequest): AgentTurnComposeRequest {
  return request.operation === 'submit'
    ? { operation: 'submit', scope: copyScope(request.scope), agent_session_id: request.agent_session_id,
      input: copySubmitInput(request.input) }
    : { operation: 'stop', scope: copyScope(request.scope), agent_session_id: request.agent_session_id,
      input: { ...request.input } };
}

function immutableRequest(request: AgentTurnComposeRequest): AgentTurnComposeRequest {
  const frozenScope = Object.freeze(copyScope(request.scope));
  if (request.operation === 'stop') {
    return Object.freeze({ operation: 'stop', scope: frozenScope, agent_session_id: request.agent_session_id,
      input: Object.freeze({ ...request.input }) });
  }
  const attachments = request.input.attachments
    ? Object.freeze(request.input.attachments.map((attachment) => Object.freeze({ ...attachment })))
    : undefined;
  return Object.freeze({ operation: 'submit', scope: frozenScope, agent_session_id: request.agent_session_id,
    input: Object.freeze({ ...request.input, ...(attachments ? { attachments } : {}) }) });
}

function immutableView(view: AgentTurnComposerView): AgentTurnComposerView {
  return Object.freeze({
    ...view,
    ...(view.request ? { request: Object.freeze({ ...view.request }) } : {}),
    ...(view.submitted ? { submitted: Object.freeze({ ...view.submitted }) } : {}),
    ...(view.stopped ? { stopped: Object.freeze({ ...view.stopped }) } : {}),
  });
}

const NOTICE: Readonly<Record<ComposerStatus, string>> = Object.freeze({
  idle: '',
  sending: '요청을 보내는 중입니다.',
  accepted: '요청이 접수되었습니다. 최신 대화 상태를 확인하고 있습니다.',
  stopping: '중단 요청을 보내는 중입니다.',
  'stop-requested': '중단이 요청되었습니다. 완료 상태를 확인하고 있습니다.',
  rejected: AgentTurnComposeFailure.messages.rejected,
  unknown: AgentTurnComposeFailure.messages.unknown,
  unavailable: AgentTurnComposeFailure.messages.unavailable,
});

/**
 * Owns one logical write at a time. It never reads, refreshes, retries, or writes automatically.
 * Callers feed only authoritative snapshots through context().
 */
export class AgentTurnComposer {
  private generation = 0;
  private currentScope: AgentTurnScope | null = null;
  private snapshot: AgentSessionSnapshot | null = null;
  private available = false;
  private invalidSnapshot = false;
  private status: ComposerStatus = 'idle';
  private busy = false;
  private intent: Intent | null = null;
  private publicRequest: AgentTurnComposerRequestView | undefined;
  private submitted: SubmittedAgentTurn | undefined;
  private stopped: StoppedAgentTurn | undefined;
  private currentView: AgentTurnComposerView;

  constructor(
    private readonly send: (request: AgentTurnComposeRequest) => Promise<unknown>,
    private readonly render: (view: AgentTurnComposerView) => void,
    private readonly createKey: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    if (typeof send !== 'function' || typeof render !== 'function' || typeof createKey !== 'function') {
      throw new TypeError('Invalid Agent Turn composer dependency');
    }
    this.currentView = immutableView({ status: 'unavailable', canSubmit: false, canRetry: false,
      canStop: false, notice: NOTICE.unavailable });
    this.publish();
  }

  get view(): AgentTurnComposerView { return this.currentView; }

  context(nextScope: AgentTurnScope | null, value: AgentSessionSnapshot | null, available: boolean): void {
    let normalizedScope: AgentTurnScope | null;
    let normalizedSnapshot: AgentSessionSnapshot | null;
    try {
      if (typeof available !== 'boolean') throw new TypeError('Invalid Agent Turn availability');
      normalizedScope = nextScope === null ? null : scope(nextScope);
      if (value !== null && normalizedScope === null) throw new TypeError('Agent Turn snapshot requires a scope');
      normalizedSnapshot = value === null ? null : parseAgentSessionSnapshot(value);
    } catch (error) {
      this.generation++;
      if (this.busy && this.intent) this.status = 'unknown';
      this.busy = false;
      this.available = false;
      this.invalidSnapshot = true;
      this.publish();
      throw error;
    }
    const oldScopeKey = this.currentScope && scopeKey(this.currentScope);
    const nextScopeKey = normalizedScope && scopeKey(normalizedScope);
    const scopeChanged = oldScopeKey !== nextScopeKey;
    const sessionChanged = normalizedSnapshot !== null && this.snapshot !== null
      && normalizedSnapshot.id !== this.snapshot.id;

    if (scopeChanged || sessionChanged) {
      this.invalidate();
      this.clearOperation();
      this.snapshot = null;
    }
    this.currentScope = normalizedScope;
    this.available = available;

    if (normalizedSnapshot !== null) {
      if (!sessionChanged && this.snapshot?.id === normalizedSnapshot.id
        && normalizedSnapshot.state_version < this.snapshot.state_version) {
        this.generation++;
        if (this.busy && this.intent) this.status = 'unknown';
        this.busy = false;
        this.invalidSnapshot = true;
        this.publish();
        return;
      }
      this.snapshot = normalizedSnapshot;
      this.invalidSnapshot = false;
      this.reconcileReceipt();
    } else if (available) {
      // A successful read with no active session is authoritative.
      this.invalidate();
      this.clearOperation();
      this.snapshot = null;
      this.invalidSnapshot = false;
    }
    // An unavailable read with no snapshot is transient. Preserve snapshot and uncertain intent.
    this.publish();
  }

  async submit(input_text: string, attachments?: readonly AgentAttachmentReference[]): Promise<SubmittedAgentTurn | null> {
    this.requireAction(this.canStartSubmit());
    const currentScope = this.currentScope!;
    const snapshot = this.snapshot!;
    const input = validateSubmitAgentTurn(snapshot.id, {
      input_text,
      expected_state_version: snapshot.state_version,
      idempotency_key: this.createKey(),
      ...(attachments === undefined ? {} : { attachments }),
    });
    const request: AgentTurnComposeRequest = {
      operation: 'submit', scope: copyScope(currentScope), agent_session_id: snapshot.id, input,
    };
    this.intent = { request: immutableRequest(request), scopeKey: scopeKey(currentScope), sessionId: snapshot.id };
    this.publicRequest = requestView(request);
    this.submitted = undefined;
    this.stopped = undefined;
    return this.dispatchSubmit(request);
  }

  async retry(): Promise<SubmittedAgentTurn | StoppedAgentTurn | null> {
    this.requireAction(this.canRetry());
    const request = cloneRequest(this.intent!.request);
    return request.operation === 'submit' ? this.dispatchSubmit(request) : this.dispatchStop(request);
  }

  async stop(): Promise<StoppedAgentTurn | null> {
    this.requireAction(this.canStartStop());
    const currentScope = this.currentScope!;
    const snapshot = this.snapshot!;
    const input = validateStopAgentTurn(snapshot.id, {
      turn_id: snapshot.latest_turn!.id,
      expected_state_version: snapshot.state_version,
    });
    const request: AgentTurnComposeRequest = {
      operation: 'stop', scope: copyScope(currentScope), agent_session_id: snapshot.id, input,
    };
    this.intent = { request: immutableRequest(request), scopeKey: scopeKey(currentScope), sessionId: snapshot.id };
    this.publicRequest = requestView(request);
    this.submitted = undefined;
    this.stopped = undefined;
    return this.dispatchStop(request);
  }

  reset(): void {
    this.generation++;
    this.currentScope = null;
    this.snapshot = null;
    this.available = false;
    this.invalidSnapshot = false;
    this.busy = false;
    this.clearOperation();
    this.publish();
  }

  private async dispatchSubmit(request: Extract<AgentTurnComposeRequest, { operation: 'submit' }>): Promise<SubmittedAgentTurn | null> {
    const generation = this.generation;
    this.busy = true;
    this.status = 'sending';
    this.publish();
    try {
      const envelope = await this.send(cloneRequest(request));
      if (generation !== this.generation) return null;
      const mutation = this.envelopeMutation(envelope, request);
      const submitted = parseSubmittedAgentTurn(mutation, request.input.expected_state_version);
      this.busy = false;
      this.intent = null;
      this.submitted = copySubmitted(submitted);
      this.stopped = undefined;
      this.status = 'accepted';
      this.reconcileReceipt();
      this.publish();
      return copySubmitted(submitted);
    } catch (error) {
      return this.failed(error, generation);
    }
  }

  private async dispatchStop(request: Extract<AgentTurnComposeRequest, { operation: 'stop' }>): Promise<StoppedAgentTurn | null> {
    const generation = this.generation;
    this.busy = true;
    this.status = 'stopping';
    this.publish();
    try {
      const envelope = await this.send(cloneRequest(request));
      if (generation !== this.generation) return null;
      const mutation = this.envelopeMutation(envelope, request);
      const stopped = parseStoppedAgentTurn(mutation, request.input.turn_id, request.input.expected_state_version);
      this.busy = false;
      this.intent = null;
      this.submitted = undefined;
      this.stopped = copyStopped(stopped);
      this.status = 'stop-requested';
      this.reconcileReceipt();
      this.publish();
      return copyStopped(stopped);
    } catch (error) {
      return this.failed(error, generation);
    }
  }

  private failed(error: unknown, generation: number): never | null {
    if (generation !== this.generation) return null;
    this.busy = false;
    const failure = error instanceof AgentTurnComposeFailure
      ? new AgentTurnComposeFailure(error.outcome, error.conflict)
      : new AgentTurnComposeFailure('unknown');
    this.status = failure.outcome;
    if (failure.outcome === 'rejected') this.intent = null;
    this.publish();
    throw failure;
  }

  private envelopeMutation(value: unknown, request: AgentTurnComposeRequest): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentTurnComposeFailure('unknown');
    const raw = value as Record<string, unknown>;
    if (raw.platform_type !== request.scope.platform_type || raw.profile !== request.scope.profile
      || raw.server_url !== request.scope.server_url || raw.user_id !== request.scope.user_id
      || raw.agent_session_id !== request.agent_session_id || !('mutation' in raw)) {
      throw new AgentTurnComposeFailure('unknown');
    }
    return raw.mutation;
  }

  private canStartSubmit(): boolean {
    return this.connected() && !this.busy && !this.intent && !this.submitted && !this.stopped && terminal(this.snapshot!);
  }

  private canStartStop(): boolean {
    const latest = this.snapshot?.latest_turn;
    return this.connected() && !this.busy && !this.intent && !this.stopped
      && latest !== null && latest !== undefined && (latest.status === 'accepted' || latest.status === 'running');
  }

  private canRetry(): boolean {
    return this.connected() && !this.busy && this.intent !== null
      && (this.status === 'unknown' || this.status === 'unavailable')
      && this.intent.scopeKey === scopeKey(this.currentScope!) && this.intent.sessionId === this.snapshot!.id;
  }

  private connected(): boolean {
    return this.available && !this.invalidSnapshot && this.currentScope !== null && this.snapshot !== null;
  }

  private requireAction(allowed: boolean): void {
    if (!allowed) throw new AgentTurnComposeFailure('unavailable');
  }

  private reconcileReceipt(): void {
    if (this.submitted && this.snapshot
      && this.snapshot.state_version >= this.submitted.state_version
      && ((this.snapshot.latest_turn?.id === this.submitted.turn_id
        && TERMINAL.has(this.snapshot.latest_turn.status))
        || (this.snapshot.state_version > this.submitted.state_version
          && this.snapshot.latest_turn !== null && this.snapshot.latest_turn !== undefined
          && this.snapshot.latest_turn.id !== this.submitted.turn_id))) {
      this.clearOperation();
      return;
    }
    if (this.stopped && this.snapshot
      && this.snapshot.state_version >= this.stopped.state_version
      && ((this.snapshot.latest_turn?.id === this.stopped.turn_id
        && TERMINAL.has(this.snapshot.latest_turn.status))
        || (this.snapshot.state_version > this.stopped.state_version
          && this.snapshot.latest_turn !== null && this.snapshot.latest_turn !== undefined
          && this.snapshot.latest_turn.id !== this.stopped.turn_id))) {
      this.clearOperation();
    }
  }

  private invalidate(): void {
    this.generation++;
    this.busy = false;
  }

  private clearOperation(): void {
    this.busy = false;
    this.intent = null;
    this.publicRequest = undefined;
    this.submitted = undefined;
    this.stopped = undefined;
    this.status = 'idle';
  }

  private publish(): void {
    const connected = this.connected();
    const visibleStatus: ComposerStatus = connected || this.status !== 'idle' ? this.status : 'unavailable';
    const view: AgentTurnComposerView = {
      status: visibleStatus,
      canSubmit: this.canStartSubmit(),
      canRetry: this.canRetry(),
      canStop: this.canStartStop(),
      notice: NOTICE[visibleStatus],
      ...(this.publicRequest ? { request: { ...this.publicRequest } } : {}),
      ...(this.submitted ? { submitted: copySubmitted(this.submitted) } : {}),
      ...(this.stopped ? { stopped: copyStopped(this.stopped) } : {}),
    };
    this.currentView = immutableView(view);
    try { this.render(this.currentView); } catch { /* rendering cannot change a write outcome */ }
  }
}
