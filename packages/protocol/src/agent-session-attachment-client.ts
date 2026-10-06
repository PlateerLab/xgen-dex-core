/** DPoP-only staged attachment transport for a trusted native Agent Session scope. */
import {
  parseAgentAttachmentReceipt,
  parseAgentAttachmentScope,
  validateAgentAttachmentId,
  validateReserveAgentAttachment,
  type AgentAttachmentReceipt,
  type AgentAttachmentScope,
  type ReserveAgentAttachment,
} from './agent-session-attachments';

const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const RESERVED_FIELDS = ['attachment_id', 'status', 'expires_at'] as const;
const RESERVED_STATUSES = ['reserved', 'uploading', 'ready'] as const;

export interface AgentSessionAttachmentProofSource {
  accessToken(): Promise<string | null>;
  signProof(method: 'GET' | 'POST' | 'PUT', htu: string, accessToken: string): Promise<string>;
}

export interface ReservedAgentAttachment {
  readonly attachment_id: string;
  readonly status: typeof RESERVED_STATUSES[number];
  readonly expires_at: string;
}

/** The server authoritatively rejected a request. Response bodies remain private. */
export class AgentSessionAttachmentHttpError extends Error {
  constructor(readonly status: number) {
    super(`Canonical Agent Session attachment request rejected: ${status}`);
    this.name = 'AgentSessionAttachmentHttpError';
  }
}

/** A dispatched write may have committed. Inspect state before issuing another logical write. */
export class AgentSessionAttachmentOutcomeUnknown extends Error {
  constructor(readonly status?: number) {
    super(status === undefined
      ? 'Canonical Agent Session attachment write outcome is unknown'
      : `Canonical Agent Session attachment write outcome is unknown: ${status}`);
    this.name = 'AgentSessionAttachmentOutcomeUnknown';
  }
}

export {
  AgentSessionAttachmentHttpError as AgentAttachmentHttpError,
  AgentSessionAttachmentOutcomeUnknown as AgentAttachmentOutcomeUnknown,
};

export class AgentSessionAttachmentTransportError extends Error {
  constructor() {
    super('Canonical Agent Session attachment transport unavailable');
    this.name = 'AgentSessionAttachmentTransportError';
  }
}

export class AgentSessionAttachmentProtocolError extends Error {
  constructor() {
    super('Invalid canonical Agent Session attachment response');
    this.name = 'AgentSessionAttachmentProtocolError';
  }
}

function protocolError(): never { throw new AgentSessionAttachmentProtocolError(); }

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) protocolError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) protocolError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || !keys.every((key) => typeof key === 'string' && fields.includes(key))) protocolError();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) protocolError();
    result[field] = descriptor.value;
  }
  return result;
}

function parseReservation(value: unknown): Readonly<ReservedAgentAttachment> {
  const raw = exactRecord(value, RESERVED_FIELDS);
  const attachmentId = validateAgentAttachmentId(raw.attachment_id);
  if (typeof raw.status !== 'string'
    || !RESERVED_STATUSES.includes(raw.status as ReservedAgentAttachment['status'])
    || typeof raw.expires_at !== 'string'
    || !/^\d{4}-\d\d-\d\dT/.test(raw.expires_at)
    || !Number.isFinite(Date.parse(raw.expires_at))) protocolError();
  return Object.freeze({
    attachment_id: attachmentId,
    status: raw.status as ReservedAgentAttachment['status'],
    expires_at: raw.expires_at,
  });
}

function responseRedirected(response: Response, expectedUrl: string): boolean {
  try {
    return response.redirected || Boolean(response.url && response.url !== expectedUrl)
      || (response.status >= 300 && response.status < 400);
  } catch { return true; }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best-effort disposal only */ }
}

function abortRace<T>(signal: AbortSignal | undefined, onAbort: () => void): {
  promise: Promise<T>;
  dispose: () => void;
} {
  let reject!: (error: DOMException) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
  let fired = false;
  const listener = () => {
    if (fired) return;
    fired = true;
    onAbort();
    reject(abortError());
  };
  signal?.addEventListener('abort', listener, { once: true });
  if (signal?.aborted) listener();
  return { promise, dispose: () => signal?.removeEventListener('abort', listener) };
}

async function beforeDispatch<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  const aborted = abortRace<T>(signal, () => undefined);
  try { return await Promise.race([operation, aborted.promise]); } finally { aborted.dispose(); }
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  let length: string | null;
  try { length = response.headers.get('content-length'); } catch { protocolError(); }
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void cancelBody(response);
    protocolError();
  }
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch { protocolError(); }
  if (!body || typeof body.getReader !== 'function') {
    if (typeof response.text !== 'function') protocolError();
    const aborted = abortRace<string>(signal, () => { void cancelBody(response); });
    let text: string;
    try { text = await Promise.race([Promise.resolve().then(() => response.text()), aborted.promise]); }
    catch (error) {
      void cancelBody(response);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      protocolError();
    } finally { aborted.dispose(); }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) protocolError();
    try { return JSON.parse(text) as unknown; } catch { protocolError(); }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { protocolError(); }
  const cancelReader = () => {
    try { void Promise.resolve(reader.cancel()).catch(() => undefined); } catch { /* cleanup only */ }
  };
  const aborted = abortRace<ReadableStreamReadResult<Uint8Array>>(signal, cancelReader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted.promise]);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) protocolError();
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) protocolError();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    cancelReader();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof AgentSessionAttachmentProtocolError) throw error;
    protocolError();
  } finally {
    aborted.dispose();
    try { reader.releaseLock(); } catch { /* cleanup only */ }
  }
}

function sameReceipt(
  receipt: AgentAttachmentReceipt,
  attachmentId: string,
  metadata: Readonly<ReserveAgentAttachment>,
): boolean {
  return receipt.attachment_id === attachmentId
    && receipt.filename === metadata.filename
    && receipt.size_bytes === metadata.size_bytes
    && receipt.media_type === metadata.media_type
    && receipt.sha256 === metadata.sha256;
}

async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
  try {
    const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
    if (!subtle) throw new TypeError();
    const digest = await beforeDispatch(subtle.digest('SHA-256', bytes), signal);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new TypeError('Attachment content checksum unavailable');
  }
}

/** No retries or legacy fallback. Every call acquires a fresh active credential and proof. */
export class AgentSessionAttachmentClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(origin: string, private readonly proof: AgentSessionAttachmentProofSource, fetchImpl?: typeof fetch) {
    let url: URL;
    try {
      if (typeof origin !== 'string') throw new TypeError();
      url = new URL(origin);
    } catch { throw new TypeError('Canonical Agent Session attachment API requires an exact HTTPS origin'); }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
      throw new TypeError('Canonical Agent Session attachment API requires an exact HTTPS origin');
    }
    try {
      parseAgentAttachmentScope({
        origin, user_id: '1', session_id: '00000000-0000-4000-8000-000000000000', workflow_id: 'origin-check',
      });
    } catch { throw new TypeError('Canonical Agent Session attachment API requires an exact HTTPS origin'); }
    this.origin = origin;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new TypeError('Fetch is required');
  }

  private scope(value: unknown): AgentAttachmentScope {
    const scope = parseAgentAttachmentScope(value);
    if (scope.origin !== this.origin) throw new TypeError('Attachment scope does not match the configured origin');
    return scope;
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT', path: string, body: BodyInit | undefined,
    contentType: string | undefined, signal: AbortSignal | undefined, write: boolean,
  ): Promise<Response> {
    if (signal?.aborted) throw abortError();
    let token: string | null;
    try { token = await beforeDispatch(this.proof.accessToken(), signal); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new TypeError('Active Platform Session credential unavailable');
    }
    if (!token || !TOKEN.test(token)) throw new TypeError('Active Platform Session credential unavailable');
    const htu = `${this.origin}${path}`;
    let dpop: string;
    try { dpop = await beforeDispatch(this.proof.signProof(method, htu, token), signal); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new TypeError('Valid device proof unavailable');
    }
    if (!TOKEN.test(dpop)) throw new TypeError('Valid device proof unavailable');
    const headers: Record<string, string> = {
      Authorization: `DPoP ${token}`, DPoP: dpop, Accept: 'application/json',
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(body instanceof Uint8Array ? { 'Content-Length': String(body.byteLength) } : {}),
    };
    let pending: Promise<Response>;
    try {
      pending = this.fetchImpl(htu, {
        method, headers, ...(body === undefined ? {} : { body }), credentials: 'omit',
        redirect: 'error', cache: 'no-store', signal,
      });
    } catch {
      if (write) throw new AgentSessionAttachmentOutcomeUnknown();
      throw new AgentSessionAttachmentTransportError();
    }
    const aborted = abortRace<Response>(signal, () => {
      void pending.then((response) => cancelBody(response), () => undefined);
    });
    try { return await Promise.race([pending, aborted.promise]); }
    catch (error) {
      if (write) throw new AgentSessionAttachmentOutcomeUnknown();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new AgentSessionAttachmentTransportError();
    } finally { aborted.dispose(); }
  }

  private checkResponse(response: Response, expectedUrl: string, expectedStatus: number, write: boolean): void {
    if (responseRedirected(response, expectedUrl)) {
      void cancelBody(response);
      if (write) throw new AgentSessionAttachmentOutcomeUnknown(response.status);
      throw new AgentSessionAttachmentTransportError();
    }
    if (response.status === expectedStatus) return;
    void cancelBody(response);
    if (write && (response.status === 408 || response.status >= 500 || response.status < 400)) {
      throw new AgentSessionAttachmentOutcomeUnknown(response.status);
    }
    throw new AgentSessionAttachmentHttpError(response.status);
  }

  async reserveAttachment(
    scopeValue: AgentAttachmentScope, metadataValue: ReserveAgentAttachment, signal?: AbortSignal,
  ): Promise<Readonly<ReservedAgentAttachment>> {
    const scope = this.scope(scopeValue);
    const metadata = validateReserveAgentAttachment(scope, metadataValue);
    const body = JSON.stringify(metadata);
    const path = `/api/agentflow/agent-sessions/${scope.session_id}/attachments`;
    const response = await this.request('POST', path, body, 'application/json', signal, true);
    this.checkResponse(response, `${this.origin}${path}`, 201, true);
    try { return parseReservation(await readBoundedJson(response, signal)); }
    catch { throw new AgentSessionAttachmentOutcomeUnknown(response.status); }
  }

  async uploadAttachment(
    scopeValue: AgentAttachmentScope, attachmentIdValue: string, metadataValue: ReserveAgentAttachment,
    bytesValue: Uint8Array, signal?: AbortSignal,
  ): Promise<AgentAttachmentReceipt> {
    const scope = this.scope(scopeValue);
    const attachmentId = validateAgentAttachmentId(attachmentIdValue);
    const metadata = validateReserveAgentAttachment(scope, metadataValue);
    if (!(bytesValue instanceof Uint8Array)) {
      throw new TypeError('Attachment content must be a Uint8Array');
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(bytesValue); }
    catch { throw new TypeError('Attachment content must be a readable Uint8Array'); }
    if (bytes.byteLength !== metadata.size_bytes) {
      throw new TypeError('Attachment content size does not match reserved metadata');
    }
    if (await sha256Bytes(bytes, signal) !== metadata.sha256) {
      throw new TypeError('Attachment content checksum does not match reserved metadata');
    }
    const path = `/api/agentflow/agent-sessions/${scope.session_id}/attachments/${attachmentId}/content`;
    const response = await this.request('PUT', path, bytes, 'application/octet-stream', signal, true);
    this.checkResponse(response, `${this.origin}${path}`, 200, true);
    try {
      const receipt = parseAgentAttachmentReceipt(await readBoundedJson(response, signal), scope);
      if (!sameReceipt(receipt, attachmentId, metadata)) protocolError();
      return receipt;
    } catch { throw new AgentSessionAttachmentOutcomeUnknown(response.status); }
  }

  async readReceipt(
    scopeValue: AgentAttachmentScope, attachmentIdValue: string, signal?: AbortSignal,
  ): Promise<AgentAttachmentReceipt> {
    const scope = this.scope(scopeValue);
    const attachmentId = validateAgentAttachmentId(attachmentIdValue);
    const path = `/api/agentflow/agent-sessions/${scope.session_id}/attachments/${attachmentId}`;
    const response = await this.request('GET', path, undefined, undefined, signal, false);
    this.checkResponse(response, `${this.origin}${path}`, 200, false);
    try {
      const receipt = parseAgentAttachmentReceipt(await readBoundedJson(response, signal), scope);
      if (receipt.attachment_id !== attachmentId) protocolError();
      return receipt;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof AgentSessionAttachmentProtocolError) throw error;
      protocolError();
    }
  }

  async cancelAttachment(
    scopeValue: AgentAttachmentScope, attachmentIdValue: string, signal?: AbortSignal,
  ): Promise<void> {
    const scope = this.scope(scopeValue);
    const attachmentId = validateAgentAttachmentId(attachmentIdValue);
    const path = `/api/agentflow/agent-sessions/${scope.session_id}/attachments/${attachmentId}/cancel`;
    const response = await this.request('POST', path, undefined, undefined, signal, true);
    this.checkResponse(response, `${this.origin}${path}`, 204, true);
    void cancelBody(response);
  }
}
