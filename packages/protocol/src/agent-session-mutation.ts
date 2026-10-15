/** Canonical Agent Session writes. These requests may commit before their acknowledgement is lost. */

import {
  AGENT_ATTACHMENT_MAX_COUNT,
  validateAgentAttachmentId,
  type AgentAttachmentReference,
} from './agent-session-attachments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const STABLE_ASCII = /^[\x21-\x7e]{1,128}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SUBMITTED_STATUSES = ['accepted', 'running', 'completed', 'failed', 'cancelled'] as const;
const CONFLICT_CODES = [
  'STATE_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'TURN_IN_PROGRESS',
  'TURN_NOT_RUNNING',
  'TURN_ID_CONFLICT',
  'TURN_NOT_STARTED',
  'TURN_STOP_UNAVAILABLE',
] as const;

type SubmittedStatus = typeof SUBMITTED_STATUSES[number];
export type AgentSessionMutationConflictCode = typeof CONFLICT_CODES[number];

export interface AgentSessionMutationProofSource {
  accessToken(): Promise<string | null>;
  signProof(method: 'POST', htu: string, accessToken: string): Promise<string>;
}

export interface SubmitAgentTurnInput {
  input_text: string;
  expected_state_version: number;
  idempotency_key: string;
  origin_id?: string;
  attachments?: readonly AgentAttachmentReference[];
}

export interface StopAgentTurnInput {
  turn_id: string;
  expected_state_version: number;
}

export interface SubmittedAgentTurn {
  turn_id: string;
  status: SubmittedStatus;
  accepted_sequence: number;
  state_version: number;
  replayed: boolean;
}

export interface StoppedAgentTurn {
  turn_id: string;
  state_version: number;
  requested: boolean;
}

export interface AgentSessionMutationConflict {
  code: AgentSessionMutationConflictCode;
  current_state_version?: number;
  current_turn_id?: string;
}

/** The server explicitly rejected the write, so callers may safely decide from the status. */
export class AgentSessionMutationHttpError extends Error {
  constructor(readonly status: number, readonly conflict?: AgentSessionMutationConflict) {
    super(`Canonical Agent Session mutation rejected: ${status}`);
    this.name = 'AgentSessionMutationHttpError';
  }
}

/** The write may have committed. Reconcile before deciding whether to issue another logical write. */
export class AgentSessionMutationOutcomeUnknown extends Error {
  constructor() {
    super('Canonical Agent Session mutation outcome is unknown');
    this.name = 'AgentSessionMutationOutcomeUnknown';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key));
}

function isSafeVersion(value: unknown, allowMaximum = true): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    && (allowMaximum || value < Number.MAX_SAFE_INTEGER);
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isOriginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && isWellFormed(value)
    && [...value].length >= 1 && [...value].length <= 128;
}

function invalidInput(): never {
  throw new TypeError('Invalid canonical Agent Session mutation input');
}

function validateAttachmentReferences(value: unknown): readonly AgentAttachmentReference[] {
  try { return parseAttachmentReferences(value); } catch { invalidInput(); }
}

function parseAttachmentReferences(value: unknown): readonly AgentAttachmentReference[] {
  if (!Array.isArray(value) || value.length > AGENT_ATTACHMENT_MAX_COUNT) invalidInput();
  const seen = new Set<string>();
  const result: AgentAttachmentReference[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) invalidInput();
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) invalidInput();
    const keys = Reflect.ownKeys(item);
    if (keys.length !== 2 || !keys.every((key) => key === 'attachment_id' || key === 'sha256')) invalidInput();
    const idDescriptor = Object.getOwnPropertyDescriptor(item, 'attachment_id');
    const digestDescriptor = Object.getOwnPropertyDescriptor(item, 'sha256');
    if (!idDescriptor || !('value' in idDescriptor) || !digestDescriptor || !('value' in digestDescriptor)) invalidInput();
    let attachmentId: string;
    try { attachmentId = validateAgentAttachmentId(idDescriptor.value); } catch { invalidInput(); }
    const sha256 = digestDescriptor.value;
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(sha256) || seen.has(attachmentId)) invalidInput();
    seen.add(attachmentId);
    result.push(Object.freeze({ attachment_id: attachmentId, sha256 }));
  }
  return Object.freeze(result);
}

/** Validate synchronously and return a primitive-only copy suitable for serialization. */
export function validateSubmitAgentTurn(sessionId: string, input: unknown): SubmitAgentTurnInput {
  const raw = record(input);
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || !raw
    || !exactFields(raw, ['input_text', 'expected_state_version', 'idempotency_key', 'origin_id', 'attachments'])
    || typeof raw.input_text !== 'string' || raw.input_text.length === 0
    || raw.input_text.length > 262144
    || !isWellFormed(raw.input_text) || new TextEncoder().encode(raw.input_text).length > 262144
    || !isSafeVersion(raw.expected_state_version, false)
    || typeof raw.idempotency_key !== 'string' || !STABLE_ASCII.test(raw.idempotency_key)
    || (raw.origin_id !== undefined && !isOriginId(raw.origin_id))) invalidInput();
  let attachmentsValue: unknown;
  if (Object.prototype.hasOwnProperty.call(raw, 'attachments')) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'attachments');
    if (!descriptor || !('value' in descriptor)) invalidInput();
    attachmentsValue = descriptor.value;
  }
  const attachments = attachmentsValue === undefined ? undefined : validateAttachmentReferences(attachmentsValue);
  return {
    input_text: raw.input_text,
    expected_state_version: raw.expected_state_version,
    idempotency_key: raw.idempotency_key,
    ...(raw.origin_id === undefined ? {} : { origin_id: raw.origin_id }),
    ...(!attachments?.length ? {} : { attachments }),
  };
}

/** Validate synchronously and return a primitive-only copy suitable for serialization. */
export function validateStopAgentTurn(sessionId: string, input: unknown): StopAgentTurnInput {
  const raw = record(input);
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || !raw
    || !exactFields(raw, ['turn_id', 'expected_state_version'])
    || typeof raw.turn_id !== 'string' || !UUID.test(raw.turn_id)
    || !isSafeVersion(raw.expected_state_version)) invalidInput();
  return { turn_id: raw.turn_id, expected_state_version: raw.expected_state_version };
}

function unknown(): never {
  throw new AgentSessionMutationOutcomeUnknown();
}

function isSubmittedStatus(value: unknown): value is SubmittedStatus {
  return typeof value === 'string' && SUBMITTED_STATUSES.includes(value as SubmittedStatus);
}

/** Parse a 202 acknowledgement and discard all server metadata outside the canonical result. */
export function parseSubmittedAgentTurn(value: unknown, expectedVersion: number): SubmittedAgentTurn {
  const raw = record(value);
  if (!isSafeVersion(expectedVersion, false) || !raw || typeof raw.turn_id !== 'string'
    || !UUID.test(raw.turn_id) || !isSubmittedStatus(raw.status)
    || typeof raw.accepted_sequence !== 'number' || !Number.isSafeInteger(raw.accepted_sequence)
    || raw.accepted_sequence < 1 || raw.state_version !== expectedVersion + 1
    || typeof raw.replayed !== 'boolean'
    || (!raw.replayed && raw.status !== 'accepted')) unknown();
  return {
    turn_id: raw.turn_id,
    status: raw.status,
    accepted_sequence: raw.accepted_sequence,
    state_version: raw.state_version,
    replayed: raw.replayed,
  };
}

/** Parse a 202 stop acknowledgement and bind it to the exact requested turn and CAS version. */
export function parseStoppedAgentTurn(
  value: unknown, requestedTurnId: string, expectedVersion: number,
): StoppedAgentTurn {
  const raw = record(value);
  if (typeof requestedTurnId !== 'string' || !UUID.test(requestedTurnId) || !isSafeVersion(expectedVersion) || !raw
    || raw.turn_id !== requestedTurnId || raw.state_version !== expectedVersion
    || raw.requested !== true) unknown();
  return { turn_id: requestedTurnId, state_version: expectedVersion, requested: true };
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* the status remains authoritative */ }
}

function abortOutcome(signal: AbortSignal | undefined, cancel: () => void): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let reject!: (error: AgentSessionMutationOutcomeUnknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  let fired = false;
  const onAbort = () => {
    if (fired) return;
    fired = true;
    cancel();
    reject(new AgentSessionMutationOutcomeUnknown());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { promise, dispose: () => signal?.removeEventListener('abort', onAbort) };
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  let length: string | null;
  try {
    length = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-length')
      : null;
  } catch {
    void cancelBody(response);
    unknown();
  }
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void cancelBody(response);
    unknown();
  }
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch { void cancelBody(response); unknown(); }
  if (!body || typeof body.getReader !== 'function') {
    const aborted = abortOutcome(signal, () => { void cancelBody(response); });
    try {
      return await Promise.race([Promise.resolve().then(() => response.json()), aborted.promise]);
    } catch (error) {
      void cancelBody(response);
      if (error instanceof AgentSessionMutationOutcomeUnknown) throw error;
      unknown();
    } finally {
      aborted.dispose();
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { void cancelBody(response); unknown(); }
  const cancelReader = () => {
    try { void Promise.resolve(reader.cancel()).catch(() => undefined); } catch { /* cleanup is best effort */ }
  };
  const aborted = abortOutcome(signal, cancelReader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted.promise]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        unknown();
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    cancelReader();
    if (error instanceof AgentSessionMutationOutcomeUnknown) throw error;
    unknown();
  } finally {
    aborted.dispose();
    try { reader.releaseLock(); } catch { /* a hostile reader cannot change the static outcome */ }
  }
}

function conflictMetadata(value: unknown): AgentSessionMutationConflict | undefined {
  const envelope = record(value);
  const raw = envelope && record(envelope.detail);
  if (!raw || typeof raw.code !== 'string'
    || !CONFLICT_CODES.includes(raw.code as AgentSessionMutationConflictCode)) return undefined;
  if (raw.current_state_version !== undefined && !isSafeVersion(raw.current_state_version)) return undefined;
  if (raw.current_turn_id !== undefined && raw.current_turn_id !== null
    && (typeof raw.current_turn_id !== 'string' || !UUID.test(raw.current_turn_id))) return undefined;
  return {
    code: raw.code as AgentSessionMutationConflictCode,
    ...(raw.current_state_version === undefined ? {} : { current_state_version: raw.current_state_version as number }),
    ...(typeof raw.current_turn_id === 'string' ? { current_turn_id: raw.current_turn_id } : {}),
  };
}

async function rejected(response: Response, signal?: AbortSignal): Promise<never> {
  if (response.status === 409) {
    let conflict: AgentSessionMutationConflict | undefined;
    try { conflict = conflictMetadata(await readBoundedJson(response, signal)); } catch { /* status is authoritative */ }
    throw new AgentSessionMutationHttpError(409, conflict);
  }
  void cancelBody(response);
  throw new AgentSessionMutationHttpError(response.status);
}

function redirectedResponse(response: Response, expectedUrl: string): boolean {
  try {
    return response.redirected || Boolean(response.url && response.url !== expectedUrl)
      || (response.status >= 300 && response.status < 400);
  } catch {
    return true;
  }
}

/** A no-retry writer. Each explicit invocation acquires a fresh token and DPoP proof. */
export class AgentSessionMutationClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(origin: string, private readonly proof: AgentSessionMutationProofSource, fetchImpl?: typeof fetch) {
    let url: URL;
    try {
      if (typeof origin !== 'string') throw new TypeError();
      url = new URL(origin);
    } catch { throw new TypeError('Canonical Agent Session API requires an exact HTTPS origin'); }
    if (url.protocol !== 'https:' || origin !== url.origin || url.username || url.password) {
      throw new TypeError('Canonical Agent Session API requires an exact HTTPS origin');
    }
    this.origin = origin;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new TypeError('Fetch is required');
  }

  private async post(path: string, body: string, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    const token = await this.proof.accessToken();
    signal?.throwIfAborted();
    if (!token || !TOKEN.test(token)) throw new TypeError('Active Platform Session credential unavailable');
    const htu = `${this.origin}${path}`;
    const dpop = await this.proof.signProof('POST', htu, token);
    signal?.throwIfAborted();
    if (!TOKEN.test(dpop)) throw new TypeError('Valid device proof unavailable');
    let request: Promise<Response>;
    try {
      request = this.fetchImpl(htu, {
        method: 'POST',
        headers: {
          Authorization: `DPoP ${token}`,
          DPoP: dpop,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
    } catch {
      throw new AgentSessionMutationOutcomeUnknown();
    }
    if (!signal) {
      try { return await request; } catch { throw new AgentSessionMutationOutcomeUnknown(); }
    }
    const aborted = abortOutcome(signal, () => {
      void request.then((response) => cancelBody(response), () => undefined);
    });
    try {
      return await Promise.race([request, aborted.promise]);
    } catch {
      throw new AgentSessionMutationOutcomeUnknown();
    } finally {
      aborted.dispose();
    }
  }

  async submitTurn(
    sessionId: string, input: SubmitAgentTurnInput, signal?: AbortSignal,
  ): Promise<SubmittedAgentTurn> {
    const normalized = validateSubmitAgentTurn(sessionId, input);
    const body = JSON.stringify(normalized);
    const path = `/api/agentflow/agent-sessions/${sessionId}/turns`;
    const response = await this.post(path, body, signal);
    const htu = `${this.origin}${path}`;
    if (redirectedResponse(response, htu)) {
      void cancelBody(response);
      throw new AgentSessionMutationOutcomeUnknown();
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return rejected(response, signal);
    if (response.status !== 202) {
      void cancelBody(response);
      throw new AgentSessionMutationOutcomeUnknown();
    }
    return parseSubmittedAgentTurn(await readBoundedJson(response, signal), normalized.expected_state_version);
  }

  async stopTurn(
    sessionId: string, input: StopAgentTurnInput, signal?: AbortSignal,
  ): Promise<StoppedAgentTurn> {
    const normalized = validateStopAgentTurn(sessionId, input);
    const body = JSON.stringify(normalized);
    const path = `/api/agentflow/agent-sessions/${sessionId}/stop`;
    const response = await this.post(path, body, signal);
    const htu = `${this.origin}${path}`;
    if (redirectedResponse(response, htu)) {
      void cancelBody(response);
      throw new AgentSessionMutationOutcomeUnknown();
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return rejected(response, signal);
    if (response.status !== 202) {
      void cancelBody(response);
      throw new AgentSessionMutationOutcomeUnknown();
    }
    return parseStoppedAgentTurn(await readBoundedJson(response, signal), normalized.turn_id, normalized.expected_state_version);
  }
}
