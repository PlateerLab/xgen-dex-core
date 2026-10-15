import type { AgentFocus } from './agent-session';

/** Creation and focus writes may commit before their acknowledgement reaches the caller. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CreateAgentSessionInput {
  workflow_id: string;
  expected_version: number;
  title?: string;
  origin_id?: string;
}

export interface SwitchAgentFocusInput {
  active_agent_session_id: string | null;
  expected_version: number;
  origin_id?: string;
}

export interface CreatedAgentSession {
  id: string;
  workflow_id: string;
  focus: AgentFocus;
}

export interface AgentSessionLifecycleProofSource {
  accessToken(): Promise<string | null>;
  signProof(method: 'POST' | 'PUT', htu: string, accessToken: string): Promise<string>;
}

export interface AgentSessionLifecycleConflict {
  code: 'FOCUS_VERSION_CONFLICT';
  current: AgentFocus;
}

/** The server explicitly rejected the write, so callers may safely act on the status. */
export class AgentSessionLifecycleHttpError extends Error {
  constructor(readonly status: number, readonly conflict?: AgentSessionLifecycleConflict) {
    super(`Canonical Agent Session lifecycle write rejected: ${status}`);
    this.name = 'AgentSessionLifecycleHttpError';
  }
}

/** The write may have committed. Read canonical focus before issuing another logical write. */
export class AgentSessionLifecycleOutcomeUnknown extends Error {
  constructor() {
    super('Canonical Agent Session lifecycle write outcome is unknown');
    this.name = 'AgentSessionLifecycleOutcomeUnknown';
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

function isCodePointString(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum * 2
    || !isWellFormed(value)) return false;
  const length = [...value].length;
  return length >= minimum && length <= maximum;
}

function isExpectedVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function isFocusVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidInput(): never {
  throw new TypeError('Invalid canonical Agent Session lifecycle input');
}

/** Validate synchronously and return a primitive-only copy suitable for serialization. */
export function validateCreateAgentSession(input: unknown): CreateAgentSessionInput {
  const raw = record(input);
  if (!raw || !exactFields(raw, ['workflow_id', 'expected_version', 'title', 'origin_id'])
    || !isCodePointString(raw.workflow_id, 1, 256)
    || !isExpectedVersion(raw.expected_version)
    || (raw.title !== undefined && !isCodePointString(raw.title, 0, 256))
    || (raw.origin_id !== undefined && !isCodePointString(raw.origin_id, 1, 128))) invalidInput();
  return {
    workflow_id: raw.workflow_id,
    expected_version: raw.expected_version,
    title: raw.title === undefined ? '' : raw.title,
    ...(raw.origin_id === undefined ? {} : { origin_id: raw.origin_id }),
  };
}

/** Validate synchronously and return a primitive-only copy suitable for serialization. */
export function validateSwitchAgentFocus(input: unknown): SwitchAgentFocusInput {
  const raw = record(input);
  if (!raw || !exactFields(raw, ['active_agent_session_id', 'expected_version', 'origin_id'])
    || (raw.active_agent_session_id !== null
      && (typeof raw.active_agent_session_id !== 'string' || !UUID.test(raw.active_agent_session_id)))
    || !isExpectedVersion(raw.expected_version)
    || (raw.origin_id !== undefined && !isCodePointString(raw.origin_id, 1, 128))) invalidInput();
  return {
    active_agent_session_id: raw.active_agent_session_id as string | null,
    expected_version: raw.expected_version,
    ...(raw.origin_id === undefined ? {} : { origin_id: raw.origin_id }),
  };
}

function unknown(): never {
  throw new AgentSessionLifecycleOutcomeUnknown();
}

function parseFocus(value: unknown): AgentFocus | null {
  const raw = record(value);
  if (!raw || (raw.active_agent_session_id !== null
    && (typeof raw.active_agent_session_id !== 'string' || !UUID.test(raw.active_agent_session_id)))
    || !isFocusVersion(raw.version)
    || (raw.event_id !== null && (typeof raw.event_id !== 'string' || !UUID.test(raw.event_id)))) return null;
  if (raw.version === 0) {
    if (raw.active_agent_session_id !== null || raw.event_id !== null) return null;
  } else if (raw.event_id === null) return null;
  return {
    active_agent_session_id: raw.active_agent_session_id as string | null,
    version: raw.version,
    event_id: raw.event_id as string | null,
  };
}

/** Parse a creation acknowledgement and bind it to the exact workflow and focus CAS. */
export function parseCreatedAgentSession(
  value: unknown, input: CreateAgentSessionInput,
): CreatedAgentSession {
  let normalized: CreateAgentSessionInput;
  try { normalized = validateCreateAgentSession(input); } catch { unknown(); }
  const raw = record(value);
  const focus = raw && parseFocus(raw.focus);
  if (!raw || typeof raw.id !== 'string' || !UUID.test(raw.id)
    || raw.workflow_id !== normalized.workflow_id || !focus
    || focus.active_agent_session_id !== raw.id
    || focus.version !== normalized.expected_version + 1
    || focus.event_id === null) unknown();
  return { id: raw.id, workflow_id: normalized.workflow_id, focus };
}

/** Parse a focus acknowledgement and permit the server's same-target no-op CAS result. */
export function parseSwitchedAgentFocus(
  value: unknown, input: SwitchAgentFocusInput,
): AgentFocus {
  let normalized: SwitchAgentFocusInput;
  try { normalized = validateSwitchAgentFocus(input); } catch { unknown(); }
  const focus = parseFocus(value);
  if (!focus || focus.active_agent_session_id !== normalized.active_agent_session_id
    || (focus.version !== normalized.expected_version
      && focus.version !== normalized.expected_version + 1)) unknown();
  return focus;
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* cleanup cannot change the write outcome */ }
}

function abortOutcome(signal: AbortSignal | undefined, cancel: () => void): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let reject!: (error: AgentSessionLifecycleOutcomeUnknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  let fired = false;
  const onAbort = () => {
    if (fired) return;
    fired = true;
    cancel();
    reject(new AgentSessionLifecycleOutcomeUnknown());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { promise, dispose: () => signal?.removeEventListener('abort', onAbort) };
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { unknown(); }
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
      const value = await Promise.race([Promise.resolve().then(() => response.json()), aborted.promise]);
      let encoded: Uint8Array;
      try { encoded = new TextEncoder().encode(JSON.stringify(value)); } catch { unknown(); }
      if (encoded.byteLength > MAX_RESPONSE_BYTES) unknown();
      return value;
    } catch (error) {
      void cancelBody(response);
      if (error instanceof AgentSessionLifecycleOutcomeUnknown) throw error;
      unknown();
    } finally {
      aborted.dispose();
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { void cancelBody(response); unknown(); }
  const cancelReader = () => {
    try { void Promise.resolve(reader.cancel()).catch(() => undefined); } catch { /* best effort */ }
  };
  const aborted = abortOutcome(signal, cancelReader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted.promise]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) unknown();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return decodeJson(bytes);
  } catch (error) {
    cancelReader();
    if (error instanceof AgentSessionLifecycleOutcomeUnknown) throw error;
    unknown();
  } finally {
    aborted.dispose();
    try { reader.releaseLock(); } catch { /* hostile readers cannot change the static outcome */ }
  }
}

function conflictMetadata(value: unknown): AgentSessionLifecycleConflict | undefined {
  const envelope = record(value);
  const detail = envelope && record(envelope.detail);
  const current = detail && parseFocus(detail.current);
  if (!detail || detail.code !== 'FOCUS_VERSION_CONFLICT' || !current) return undefined;
  return { code: 'FOCUS_VERSION_CONFLICT', current };
}

async function rejected(response: Response, signal?: AbortSignal): Promise<never> {
  if (response.status === 409) {
    let conflict: AgentSessionLifecycleConflict | undefined;
    try { conflict = conflictMetadata(await readBoundedJson(response, signal)); } catch { /* status is authoritative */ }
    throw new AgentSessionLifecycleHttpError(409, conflict);
  }
  void cancelBody(response);
  throw new AgentSessionLifecycleHttpError(response.status);
}

function redirectedResponse(response: Response, expectedUrl: string): boolean {
  try {
    return response.redirected || Boolean(response.url && response.url !== expectedUrl)
      || (response.status >= 300 && response.status < 400);
  } catch { return true; }
}

/** No-retry lifecycle writer. Every explicit call acquires a fresh token and DPoP proof. */
export class AgentSessionLifecycleClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(origin: string, private readonly proof: AgentSessionLifecycleProofSource, fetchImpl?: typeof fetch) {
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

  private async write(
    method: 'POST' | 'PUT', path: string, body: string, signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const token = await this.proof.accessToken();
    signal?.throwIfAborted();
    if (!token || !TOKEN.test(token)) throw new TypeError('Active Platform Session credential unavailable');
    const htu = `${this.origin}${path}`;
    const dpop = await this.proof.signProof(method, htu, token);
    signal?.throwIfAborted();
    if (!TOKEN.test(dpop)) throw new TypeError('Valid device proof unavailable');
    let request: Promise<Response>;
    try {
      request = this.fetchImpl(htu, {
        method,
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
    } catch { throw new AgentSessionLifecycleOutcomeUnknown(); }
    if (!signal) {
      try { return await request; } catch { throw new AgentSessionLifecycleOutcomeUnknown(); }
    }
    const aborted = abortOutcome(signal, () => {
      void request.then((response) => cancelBody(response), () => undefined);
    });
    try { return await Promise.race([request, aborted.promise]); }
    catch { throw new AgentSessionLifecycleOutcomeUnknown(); }
    finally { aborted.dispose(); }
  }

  async createSession(
    input: CreateAgentSessionInput, signal?: AbortSignal,
  ): Promise<CreatedAgentSession> {
    const normalized = validateCreateAgentSession(input);
    const body = JSON.stringify(normalized);
    const path = '/api/agentflow/agent-sessions';
    const response = await this.write('POST', path, body, signal);
    const htu = `${this.origin}${path}`;
    if (redirectedResponse(response, htu)) {
      void cancelBody(response);
      throw new AgentSessionLifecycleOutcomeUnknown();
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      return rejected(response, signal);
    }
    if (response.status !== 201) {
      void cancelBody(response);
      throw new AgentSessionLifecycleOutcomeUnknown();
    }
    return parseCreatedAgentSession(await readBoundedJson(response, signal), normalized);
  }

  async switchFocus(
    input: SwitchAgentFocusInput, signal?: AbortSignal,
  ): Promise<AgentFocus> {
    const normalized = validateSwitchAgentFocus(input);
    const body = JSON.stringify(normalized);
    const path = '/api/agentflow/me/agent-state';
    const response = await this.write('PUT', path, body, signal);
    const htu = `${this.origin}${path}`;
    if (redirectedResponse(response, htu)) {
      void cancelBody(response);
      throw new AgentSessionLifecycleOutcomeUnknown();
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      return rejected(response, signal);
    }
    if (response.status !== 200) {
      void cancelBody(response);
      throw new AgentSessionLifecycleOutcomeUnknown();
    }
    return parseSwitchedAgentFocus(await readBoundedJson(response, signal), normalized);
  }
}
