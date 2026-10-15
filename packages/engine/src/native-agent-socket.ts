import * as tls from 'node:tls';
import { PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { DexError } from './errors';
import { NativeDeviceOperationBusy } from './native-device-key-store';

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUE_FRAMES = 8;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_CERTIFICATES = 2048;
const MAX_CERTIFICATE_BYTES = 128 * 1024;
const MAX_CERTIFICATES_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A malformed URL, credential, frame, or peer protocol response. */
export class NativeSocketInvalid extends DexError {
  constructor() {
    super('protocol_mismatch', '네이티브 이벤트 소켓 프로토콜을 확인할 수 없습니다.');
    this.name = 'NativeSocketInvalid';
  }
}

/** Only one native event socket may hold an origin at a time. */
export class NativeSocketBusy extends NativeDeviceOperationBusy {
  constructor() {
    super();
    this.name = 'NativeSocketBusy';
  }
}

/** The supplied cursor no longer identifies a resumable event stream. */
export class NativeSocketCursorConflict extends Error {
  constructor() {
    super('Native event socket cursor conflict');
    this.name = 'NativeSocketCursorConflict';
  }
}

/** The network or remote event socket is temporarily unavailable. */
export class NativeSocketUnavailable extends NativePlatformTransportError {
  constructor() {
    super();
    this.name = 'NativeSocketUnavailable';
  }
}

/** Native event socket credentials are absent, expired, or revoked. */
export class NativeSocketAuthentication extends PlatformCredentialUnavailable {
  constructor() {
    super('Native event socket authentication unavailable');
    this.name = 'NativeSocketAuthentication';
  }
}

export interface NativeAgentSocket {
  readonly closed: boolean;
  next(): Promise<unknown>;
  close(): Promise<void>;
}

export interface NativeAgentSocketTransport {
  assertAvailable(): void;
  open(sessionId: string, afterSequence: number, token: string, proof: string,
    signal: AbortSignal): Promise<NativeAgentSocket>;
}

export interface NativeAgentSocketTransportOptions {
  certificates?: () => readonly string[];
}

interface Frame {
  value: unknown;
  bytes: number;
}

interface PendingNext {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

// Module scope is deliberate: separately constructed hosts must not open two credential-bearing
// native sockets to the same origin. A claim is released only by the owning socket's close path.
const claimedOrigins = new Map<string, object>();

function invalid(): NativeSocketInvalid {
  return new NativeSocketInvalid();
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.origin !== value) throw invalid();
    return url.origin;
  } catch (error) {
    if (error instanceof NativeSocketInvalid) throw error;
    throw invalid();
  }
}

function credential(value: string): void {
  if (typeof value !== 'string' || value.length > 8192 || !JWT.test(value)) throw invalid();
}

function proofMatches(proof: string, htu: string): void {
  credential(proof);
  try {
    const encoded = proof.split('.')[1];
    const decoded = Buffer.from(encoded, 'base64url');
    if (!decoded.length || decoded.length > 8192
      || decoded.toString('base64url') !== encoded) throw invalid();
    const claims = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)
      || (claims as Record<string, unknown>).htm !== 'GET'
      || (claims as Record<string, unknown>).htu !== htu) throw invalid();
  } catch (error) {
    if (error instanceof NativeSocketInvalid) throw error;
    throw invalid();
  }
}

function tlsOptions(provider: NativeAgentSocketTransportOptions['certificates']): Pick<ClientOptions, 'ca'> {
  if (!provider) return {};
  try {
    const supplied = provider();
    if (!Array.isArray(supplied) || supplied.length > MAX_CERTIFICATES) throw invalid();
    let suppliedBytes = 0;
    for (const certificate of supplied) {
      if (typeof certificate !== 'string') throw invalid();
      const bytes = Buffer.byteLength(certificate);
      suppliedBytes += bytes;
      if (bytes === 0 || bytes > MAX_CERTIFICATE_BYTES || suppliedBytes > MAX_CERTIFICATES_BYTES) throw invalid();
    }
    // getCACertificates('default') preserves Node's configured default set, including
    // NODE_EXTRA_CA_CERTS on runtimes that expose it. The fallback supports Node 20.
    const configured = (tls as typeof tls & {
      getCACertificates?: (type?: 'default') => string[];
    }).getCACertificates;
    const defaults = typeof configured === 'function'
      ? configured('default')
      : tls.rootCertificates;
    return { ca: [...defaults, ...supplied] };
  } catch (error) {
    if (error instanceof NativeSocketInvalid) throw error;
    throw new NativeSocketUnavailable();
  }
}

function statusFailure(status: number | undefined): Error {
  if (status === 401 || status === 403) return new NativeSocketAuthentication();
  if (status === 409) return new NativeSocketCursorConflict();
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return new NativeSocketUnavailable();
  }
  return new NativeSocketInvalid();
}

function closeFailure(code: number): Error {
  if (code === 4401 || code === 4403) return new NativeSocketAuthentication();
  if (code === 4409) return new NativeSocketCursorConflict();
  if ([1002, 1003, 1007, 1009].includes(code)) return new NativeSocketInvalid();
  return new NativeSocketUnavailable();
}

function websocketErrorFailure(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && (code.startsWith('WS_ERR_')
    || code === 'ERR_ENCODING_INVALID_ENCODED_DATA')) return new NativeSocketInvalid();
  return new NativeSocketUnavailable();
}

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

class NodeNativeAgentSocket implements NativeAgentSocket {
  private readonly owner = Object.freeze({});
  private readonly frames: Frame[] = [];
  private queuedBytes = 0;
  private pendingNext: PendingNext | null = null;
  private terminalFailure: unknown = null;
  private closing = false;
  private actuallyClosed = false;
  private opened = false;
  private openResolve!: () => void;
  private openReject!: (error: unknown) => void;
  private openSettled = false;
  private readonly openedPromise: Promise<void>;
  private closeResolve!: () => void;
  private readonly closedPromise: Promise<void>;
  private socket: WebSocket | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private readonly onAbort: () => void;

  constructor(
    private readonly origin: string,
    address: string,
    headers: Record<string, string>,
    options: Pick<ClientOptions, 'ca'>,
    private readonly signal: AbortSignal,
  ) {
    this.openedPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
    this.closedPromise = new Promise<void>((resolve) => { this.closeResolve = resolve; });
    this.onAbort = () => this.fail(abortError());
    claimedOrigins.set(origin, this.owner);

    try {
      const socket = new WebSocket(address, {
        ...options,
        headers,
        followRedirects: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        rejectUnauthorized: true,
        skipUTF8Validation: false,
      });
      this.socket = socket;
      delete headers.Authorization;
      delete headers.DPoP;
      socket.on('open', this.handleOpen);
      socket.on('message', this.handleMessage);
      socket.on('unexpected-response', this.handleUnexpectedResponse);
      socket.on('error', this.handleError);
      socket.on('close', this.handleClose);
      signal.addEventListener('abort', this.onAbort, { once: true });
      if (signal.aborted) this.onAbort();
    } catch {
      delete headers.Authorization;
      delete headers.DPoP;
      claimedOrigins.delete(origin);
      this.openSettled = true;
      this.openReject(new NativeSocketUnavailable());
      this.actuallyClosed = true;
      this.closeResolve();
    }
  }

  get closed(): boolean {
    return this.actuallyClosed;
  }

  async ready(): Promise<NativeAgentSocket> {
    try {
      await this.openedPromise;
      return this;
    } catch (error) {
      // A failed open still owns its origin until ws reports the underlying close.
      await this.closedPromise;
      throw error;
    }
  }

  next(): Promise<unknown> {
    if (this.pendingNext) return Promise.reject(new NativeSocketBusy());
    if (this.frames.length) {
      const frame = this.frames.shift()!;
      this.queuedBytes -= frame.bytes;
      return Promise.resolve(frame.value);
    }
    if (this.terminalFailure !== null) return Promise.reject(this.terminalFailure);
    if (!this.opened || this.closing || this.actuallyClosed) return Promise.reject(new NativeSocketUnavailable());
    return new Promise<unknown>((resolve, reject) => { this.pendingNext = { resolve, reject }; });
  }

  close(): Promise<void> {
    if (!this.closing && !this.actuallyClosed) {
      this.closing = true;
      this.terminalFailure ??= new NativeSocketUnavailable();
      this.frames.length = 0;
      this.queuedBytes = 0;
      this.rejectPending();
      if (!this.openSettled) this.settleOpen(this.terminalFailure);
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(1000);
        this.closeTimer = setTimeout(() => {
          if (this.socket === socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, CLOSE_TIMEOUT_MS);
        this.closeTimer.unref();
      }
      else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    return this.closedPromise;
  }

  private settleOpen(error?: unknown): void {
    if (this.openSettled) return;
    this.openSettled = true;
    if (error === undefined) this.openResolve();
    else this.openReject(error);
  }

  private rejectPending(): void {
    const pending = this.pendingNext;
    this.pendingNext = null;
    pending?.reject(this.terminalFailure ?? new NativeSocketUnavailable());
  }

  private fail(error: unknown): void {
    if (this.terminalFailure === null) this.terminalFailure = error;
    this.closing = true;
    this.frames.length = 0;
    this.queuedBytes = 0;
    this.rejectPending();
    this.settleOpen(this.terminalFailure);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private readonly handleOpen = (): void => {
    const socket = this.socket;
    if (!socket || this.closing || socket.protocol || socket.extensions) {
      this.fail(this.terminalFailure ?? new NativeSocketInvalid());
      return;
    }
    this.opened = true;
    this.settleOpen();
  };

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    if (this.closing || this.terminalFailure !== null) return;
    const bytes = rawBytes(data);
    if (isBinary || bytes.byteLength > MAX_FRAME_BYTES) {
      this.fail(new NativeSocketInvalid());
      return;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { this.fail(new NativeSocketInvalid()); return; }
    const pending = this.pendingNext;
    if (pending) {
      this.pendingNext = null;
      pending.resolve(value);
      return;
    }
    if (this.frames.length >= MAX_QUEUE_FRAMES || this.queuedBytes + bytes.byteLength > MAX_QUEUE_BYTES) {
      this.fail(new NativeSocketInvalid());
      return;
    }
    this.frames.push({ value, bytes: bytes.byteLength });
    this.queuedBytes += bytes.byteLength;
  };

  private readonly handleUnexpectedResponse = (
    _request: import('node:http').ClientRequest,
    response: import('node:http').IncomingMessage,
  ): void => {
    const failure = statusFailure(response.statusCode);
    response.destroy();
    this.fail(failure);
  };

  private readonly handleError = (error: Error): void => {
    if (this.terminalFailure === null) this.terminalFailure = websocketErrorFailure(error);
    this.closing = true;
    this.frames.length = 0;
    this.queuedBytes = 0;
    this.rejectPending();
    this.settleOpen(this.terminalFailure);
  };

  private readonly handleClose = (code: number): void => {
    if (this.actuallyClosed) return;
    if (this.terminalFailure === null) this.terminalFailure = closeFailure(code);
    this.closing = true;
    this.frames.length = 0;
    this.queuedBytes = 0;
    this.rejectPending();
    this.settleOpen(this.terminalFailure);
    this.actuallyClosed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.signal.removeEventListener('abort', this.onAbort);
    if (claimedOrigins.get(this.origin) === this.owner) claimedOrigins.delete(this.origin);
    const socket = this.socket;
    if (socket) {
      socket.off('open', this.handleOpen);
      socket.off('message', this.handleMessage);
      socket.off('unexpected-response', this.handleUnexpectedResponse);
      socket.off('error', this.handleError);
      socket.off('close', this.handleClose);
      // Preserve a no-op error sink for a late stream error after close cleanup.
      socket.on('error', () => {});
      this.socket = null;
    }
    this.closeResolve();
  };
}

/** Creates a receive-only native WebSocket transport pinned to one canonical HTTPS origin. */
export function createNativeAgentSocketTransport(
  originValue: string,
  options: NativeAgentSocketTransportOptions = {},
): NativeAgentSocketTransport {
  const origin = canonicalOrigin(originValue);
  return {
    assertAvailable(): void {
      if (typeof WebSocket !== 'function') throw new NativeSocketUnavailable();
    },
    async open(sessionId, afterSequence, token, proof, signal): Promise<NativeAgentSocket> {
      if (!UUID.test(sessionId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw invalid();
      credential(token);
      const htu = `${origin}/api/agentflow/agent-sessions/${sessionId}/events`;
      proofMatches(proof, htu);
      if (!(signal instanceof AbortSignal)) throw invalid();
      if (signal.aborted) throw abortError();
      if (claimedOrigins.has(origin)) throw new NativeSocketBusy();
      const wss = new URL(htu);
      wss.protocol = 'wss:';
      wss.search = `after_seq=${afterSequence}`;
      const expected = `${origin.replace(/^https:/, 'wss:')}/api/agentflow/agent-sessions/${sessionId}/events?after_seq=${afterSequence}`;
      if (wss.toString() !== expected) throw invalid();
      const socket = new NodeNativeAgentSocket(origin, expected,
        { Authorization: `DPoP ${token}`, DPoP: proof }, tlsOptions(options.certificates), signal);
      return socket.ready();
    },
  };
}
