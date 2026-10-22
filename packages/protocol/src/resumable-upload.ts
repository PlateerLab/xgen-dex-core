/**
 * Resumable chunked upload — the client side of backend-gateway `/api/uploads`.
 *
 * Every client→XGEN file upload goes through this: the file is sent in chunks (the
 * gateway decides the size, default 8 MiB), each verified by SHA-256, so uploads of
 * up to 1 GiB pass any edge proxy body limit and survive dropped connections and
 * page reloads. When all chunks are in, the gateway rebuilds **the original request**
 * (same endpoint, same multipart fields/files or raw body, same headers) and streams
 * it to the service. The service's response comes back unchanged — JSON, SSE, 409,
 * 428 … — so callers keep their existing response handling.
 *
 * ```ts
 * const up = new ResumableUploader({ baseUrl, headers: () => ({ Authorization }) });
 * const res = await up.send({ method: 'POST', path: '/api/filestore/items/upload?folder_id=3',
 *   parts: [{ name: 'file', source: blobSource(file) }] });
 * ```
 *
 * Pure TypeScript, no dependencies: the host supplies `fetch` (browser, Electron,
 * Node, React Native) and an `ResumableSource` per file (Blob, file handle, RN uri).
 *
 * Protocol (gateway):
 *   POST   /api/uploads                        {filename,size,content_type} → {upload_id, chunk_size, total_chunks}
 *   GET    /api/uploads/{id}                    → {received: number[] …}
 *   PUT    /api/uploads/{id}/chunks/{index}     raw body + X-Chunk-Sha256
 *   DELETE /api/uploads/{id}
 *   POST   /api/uploads/dispatch               → the service's own response (or 202 X-Upload-Dispatch: running)
 *   GET    /api/uploads/dispatch/{id}?wait=s    → the stored response once done
 */

import { sha256HexOfBytes } from './sha256';

/**
 * The largest file a client sends — the gateway's `UPLOAD_MAX_FILE_BYTES` and the services'
 * `XGEN_UPLOAD_MAX_BYTES` (xgen-sdk) default. Every client-side attachment limit uses this one value.
 */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

export type UploadFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Where the bytes of one file come from. `read` returns exactly `length` bytes (less only at EOF). */
export interface ResumableSource {
  name: string;
  size: number;
  type: string;
  /** Changes when the file changes — part of the resume fingerprint. */
  lastModified?: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Object identity for in-memory session reuse (e.g. the Blob itself). */
  identity?: object;
  /**
   * Stable, opaque identity for persisted session reuse. Disk sources use filesystem identity so
   * a different file with the same display metadata cannot inherit already-uploaded chunks.
   */
  resumeIdentity?: string;
}

/** A Blob/File as an upload source. */
export function blobSource(blob: Blob, name?: string): ResumableSource {
  const file = blob as Blob & { name?: string; lastModified?: number };
  return {
    name: name ?? file.name ?? 'blob',
    size: blob.size,
    type: blob.type || 'application/octet-stream',
    lastModified: file.lastModified,
    identity: blob,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer()),
  };
}

/** Bytes already in memory (e.g. a JSON body) as an upload source. */
export function bytesSource(bytes: Uint8Array, name = 'body', type = 'application/octet-stream'): ResumableSource {
  return {
    name,
    size: bytes.length,
    type,
    read: async (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.length)),
  };
}

export type UploadPart =
  | { name: string; value: string }
  | { name: string; source: ResumableSource; filename?: string; contentType?: string };

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Persists upload ids across reloads/restarts (localStorage, a file, …). Optional. */
export interface ResumeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ResumableUploaderOptions {
  /** Origin the API lives under (`''` for same-origin browser use). Paths below start with `/api`. */
  baseUrl: string;
  fetch?: UploadFetch;
  /** Auth and other headers sent on every protocol request (Authorization, cookies are the host's). */
  headers?: () => Record<string, string>;
  /** Parallel chunk requests per file. */
  concurrency?: number;
  store?: ResumeStore;
  /** Max attempts per chunk / protocol call on transient failures. */
  retries?: number;
  /** Test hook: how to wait between retries. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long one request may wait for its response **headers** before it is abandoned and retried
   * (a stalled connection must not hang a 1 GiB upload forever). Bodies (SSE) are never cut.
   * Defaults: JSON calls 60 s, a chunk 10 min (slow links), the dispatch 5 min (the gateway answers
   * 202 after its own wait, `UPLOAD_DISPATCH_WAIT_SECS` 120 s).
   */
  timeouts?: { call?: number; chunk?: number; dispatch?: number };
}

export interface ResumableSendOptions {
  /** Extra headers for the final request only (X-Approval-Line, Accept, …). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** Keep the staged chunks after a 2xx (the same file is sent again, e.g. pre-scan → upload). */
  keep?: boolean;
  /** Absolute/relative URL to POST the dispatch to instead of `${baseUrl}/api/uploads/dispatch`
   *  (e.g. a same-origin route that adds SSE heartbeats). */
  dispatchUrl?: string;
}

export interface ResumableSendTarget {
  method?: 'POST' | 'PUT' | 'PATCH';
  /** `/api/...` with optional `?query`. */
  path: string;
}

/** The gateway does not offer `/api/uploads` (old gateway or feature disabled) — send the request directly. */
export class UploadUnsupportedError extends Error {
  constructor(message = 'resumable uploads are not available') {
    super(message);
    this.name = 'UploadUnsupportedError';
  }
}

/** A protocol step failed for good (not the service's own answer — that comes back as a Response). */
export class UploadFailedError extends Error {
  constructor(message: string, public status?: number, public code?: string, public body?: unknown) {
    super(message);
    this.name = 'UploadFailedError';
  }
}

interface Session {
  upload_id: string;
  chunk_size: number;
  total_chunks: number;
  size: number;
}

const UNSUPPORTED_TTL_MS = 5 * 60 * 1000;
const unsupportedUntil = new Map<string, number>();
/** Uploaded-and-complete sessions per source object — a retry after 409/428 re-dispatches without re-sending. */
const completed = new WeakMap<object, { base: string; session: Session }>();

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function errorCode(body: unknown): string | undefined {
  const b = body as { error?: { code?: string }; detail?: { code?: string } } | undefined;
  return b?.error?.code ?? b?.detail?.code;
}

/** The gateway's user-facing message (`detail.message`), if any. */
function errorMessage(body: unknown): string | undefined {
  const m = (body as { detail?: { message?: unknown } } | undefined)?.detail?.message;
  return typeof m === 'string' && m ? m : undefined;
}

export class ResumableUploader {
  private readonly base: string;
  private readonly fetchImpl: UploadFetch;
  private readonly headers: () => Record<string, string>;
  private readonly concurrency: number;
  private readonly store?: ResumeStore;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeouts: { call: number; chunk: number; dispatch: number };

  constructor(opts: ResumableUploaderOptions) {
    this.base = (opts.baseUrl || '').replace(/\/+$/, '');
    // Call fetch without a receiver. As a method (`this.fetchImpl(...)`) its `this` would be this object, and a
    // browser's fetch refuses that ("Failed to execute 'fetch' on 'Window': Illegal invocation"), which the
    // retry loop then reports as a network error after six tries: every web upload failed that way.
    const fetchFn = opts.fetch ?? (globalThis.fetch as UploadFetch);
    this.fetchImpl = fetchFn && ((input, init) => fetchFn(input, init));
    this.headers = opts.headers ?? (() => ({}));
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.store = opts.store;
    this.retries = Math.max(1, opts.retries ?? 6);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeouts = {
      call: opts.timeouts?.call ?? 60_000,
      chunk: opts.timeouts?.chunk ?? 600_000,
      dispatch: opts.timeouts?.dispatch ?? 300_000,
    };
    if (!this.fetchImpl) throw new Error('ResumableUploader: no fetch implementation available');
  }

  /** True when a recent attempt showed the gateway has no `/api/uploads` — skip straight to the direct request. */
  static knownUnsupported(baseUrl: string): boolean {
    const until = unsupportedUntil.get((baseUrl || '').replace(/\/+$/, ''));
    return until !== undefined && until > Date.now();
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  /**
   * One fetch that gives up if the response headers do not arrive within `timeoutMs` (the body is
   * not timed — streamed answers keep going). The caller's `signal` still aborts it.
   */
  private async fetchWithin(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (timedOut && !signal?.aborted) throw new Error(`request timed out after ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** fetch with retries for transient failures (network, timeout, 5xx, 429). Non-transient responses are returned. */
  private async call(path: string, init: RequestInit, signal?: AbortSignal, timeoutMs = this.timeouts.call): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        const res = await this.fetchWithin(this.url(path), init, timeoutMs, signal);
        const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
        // 502/503 from a gateway without the feature mean "unsupported", not "retry".
        if (transient && !(await this.isUnsupportedResponse(res.clone()))) {
          if (attempt < this.retries - 1) {
            await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
            continue;
          }
        }
        return res;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || signal?.aborted) throw abortError();
        lastErr = e;
        if (attempt < this.retries - 1) await this.sleep(this.backoff(attempt, null));
      }
    }
    throw new UploadFailedError(`network error: ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30_000);
    return Math.min(1000 * 2 ** attempt, 15_000);
  }

  private async isUnsupportedResponse(res: Response): Promise<boolean> {
    if (res.status === 404 || res.status === 405 || res.status === 501) return true;
    if (res.status !== 502 && res.status !== 503) return false;
    const text = await res.text().catch(() => '');
    // Old gateway: `/api/uploads` hits the proxy catch-all → 502 "Unknown service".
    // New gateway with the feature off: 503 UPLOAD_UNAVAILABLE.
    return /Unknown service|UPLOAD_UNAVAILABLE/.test(text);
  }

  private json(extra?: Record<string, string>): Record<string, string> {
    return { ...this.headers(), 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  }

  private fingerprint(src: ResumableSource): string {
    // v2 intentionally does not read v1 pipe-delimited keys. JSON preserves field boundaries even
    // when names, MIME types, URLs, or opaque identities contain separators.
    return `xgen.resumable:v2:${JSON.stringify([
      this.base,
      src.name,
      src.size,
      src.lastModified ?? null,
      src.type,
      src.resumeIdentity ?? null,
    ])}`;
  }

  private async status(id: string, signal?: AbortSignal): Promise<{ session: Session; received: Set<number> } | null> {
    const res = await this.call(`/api/uploads/${id}`, { method: 'GET', headers: this.json() }, signal);
    if (!res.ok) return null;
    const j = (await res.json()) as Session & { received: number[] };
    return {
      session: { upload_id: j.upload_id, chunk_size: j.chunk_size, total_chunks: j.total_chunks, size: j.size },
      received: new Set(j.received ?? []),
    };
  }

  private async create(src: ResumableSource, signal?: AbortSignal): Promise<Session> {
    const res = await this.call('/api/uploads', {
      method: 'POST',
      headers: this.json(),
      body: JSON.stringify({ filename: src.name, size: src.size, content_type: src.type || 'application/octet-stream' }),
    }, signal);
    if (res.status === 201 || res.ok) return (await res.json()) as Session;
    if (await this.isUnsupportedResponse(res.clone())) {
      unsupportedUntil.set(this.base, Date.now() + UNSUPPORTED_TTL_MS);
      throw new UploadUnsupportedError();
    }
    const body = await res.json().catch(() => undefined);
    throw new UploadFailedError(errorMessage(body) ?? `upload session failed (${res.status})`, res.status, errorCode(body), body);
  }

  /** Upload one file (or finish a previous partial upload of it). Returns the complete session. */
  async upload(src: ResumableSource, opts: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {}): Promise<Session> {
    return this.uploadOnce(src, opts, false);
  }

  private async uploadOnce(
    src: ResumableSource,
    opts: { signal?: AbortSignal; onProgress?: (loaded: number) => void },
    restarted: boolean,
  ): Promise<Session> {
    const { signal } = opts;
    if (src.identity) {
      const done = completed.get(src.identity);
      if (done && done.base === this.base) {
        const st = await this.status(done.session.upload_id, signal);
        if (st && st.received.size === st.session.total_chunks) {
          opts.onProgress?.(src.size);
          return st.session;
        }
        completed.delete(src.identity);
      }
    }

    let session: Session | null = null;
    let received = new Set<number>();
    const key = this.fingerprint(src);
    const saved = this.store?.get(key);
    if (saved) {
      const st = await this.status(saved, signal).catch(() => null);
      if (st && st.session.size === src.size) {
        session = st.session;
        received = st.received;
      } else {
        this.store?.delete(key);
      }
    }
    if (!session) {
      session = await this.create(src, signal);
      this.store?.set(key, session.upload_id);
    }

    const cs = session.chunk_size;
    const chunkLen = (i: number) => Math.min(cs, src.size - i * cs);
    let loaded = 0;
    for (const i of received) loaded += chunkLen(i);
    opts.onProgress?.(loaded);

    const todo: number[] = [];
    for (let i = 0; i < session.total_chunks; i++) if (!received.has(i)) todo.push(i);
    let next = 0;
    let failure: unknown = null;
    const current = session;

    const worker = async () => {
      while (failure === null && next < todo.length) {
        const index = todo[next++];
        try {
          await this.putChunk(current, src, index, signal);
          loaded += chunkLen(index);
          opts.onProgress?.(loaded);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, todo.length)) }, worker));
    if (failure) {
      const f = failure as UploadFailedError;
      if (f?.code === 'UPLOAD_NOT_FOUND' || f?.code === 'CHUNK_CONFLICT') {
        // Session expired or the file changed under us — start a fresh session once.
        this.store?.delete(key);
        if (!restarted) return this.uploadOnce(src, opts, true);
      }
      throw failure;
    }
    if (src.identity) completed.set(src.identity, { base: this.base, session: current });
    return current;
  }

  private async putChunk(session: Session, src: ResumableSource, index: number, signal?: AbortSignal): Promise<void> {
    const offset = index * session.chunk_size;
    const length = Math.min(session.chunk_size, src.size - offset);
    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (signal?.aborted) throw abortError();
      const bytes = await src.read(offset, length);
      if (bytes.length !== length) {
        throw new UploadFailedError(`file changed while uploading (chunk ${index})`, undefined, 'CHUNK_CONFLICT');
      }
      const sha = await sha256HexOfBytes(bytes);
      const res = await this.call(`/api/uploads/${session.upload_id}/chunks/${index}`, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha },
        body: bytes as unknown as BodyInit,
      }, signal, this.timeouts.chunk);
      if (res.ok) return;
      const body = await res.json().catch(() => undefined);
      const code = errorCode(body);
      // A corrupted transfer: read and send again.
      if (code === 'CHUNK_HASH_MISMATCH' || code === 'CHUNK_SIZE_MISMATCH') continue;
      throw new UploadFailedError(errorMessage(body) ?? `chunk ${index} rejected (${res.status} ${code ?? ''})`, res.status, code, body);
    }
    throw new UploadFailedError(`chunk ${index} kept failing`);
  }

  /** Abandon a session (best effort — expired sessions are cleaned up by the gateway anyway). */
  async cancel(uploadId: string): Promise<void> {
    await this.fetchImpl(this.url(`/api/uploads/${uploadId}`), { method: 'DELETE', headers: this.json() }).catch(() => undefined);
  }

  /**
   * Upload every file part, then have the gateway send the original request.
   * Returns the service's response. Throws `UploadUnsupportedError` when the
   * gateway has no `/api/uploads` (send the request the old way).
   */
  async send(target: ResumableSendTarget, body: { parts: UploadPart[] } | { raw: ResumableSource; contentType?: string },
             opts: ResumableSendOptions = {}): Promise<Response> {
    if (ResumableUploader.knownUnsupported(this.base)) throw new UploadUnsupportedError();
    const sources: ResumableSource[] = 'raw' in body
      ? [body.raw]
      : body.parts.filter((p): p is Extract<UploadPart, { source: ResumableSource }> => 'source' in p).map((p) => p.source);
    const total = sources.reduce((n, s) => n + s.size, 0);
    const loadedBy = new Map<ResumableSource, number>();
    const report = () => opts.onProgress?.({ loaded: Array.from(loadedBy.values()).reduce((a, b) => a + b, 0), total });

    for (let round = 0; round < 2; round++) {
      const ids = new Map<ResumableSource, string>();
      for (const src of sources) {
        const s = await this.upload(src, {
          signal: opts.signal,
          onProgress: (n) => { loadedBy.set(src, n); report(); },
        });
        ids.set(src, s.upload_id);
      }
      const [path, query] = splitPath(target.path);
      const req = 'raw' in body
        ? { mode: 'raw', upload_id: ids.get(body.raw), content_type: body.contentType ?? body.raw.type }
        : {
            mode: 'multipart',
            parts: body.parts.map((p) => 'source' in p
              ? { name: p.name, upload_id: ids.get(p.source), filename: p.filename ?? p.source.name,
                  content_type: p.contentType ?? p.source.type }
              : { name: p.name, value: p.value }),
          };
      const res = await this.dispatch({ method: target.method ?? 'POST', path, query, keep: !!opts.keep, ...req }, opts);
      // A cross-origin page cannot read the marker unless the gateway exposes it — then the body tells.
      const marker = res.headers.get('x-upload-dispatch');
      if ((marker === 'error' || (marker === null && !res.ok)) && round === 0) {
        const code = errorCode(await res.clone().json().catch(() => undefined));
        if (code === 'UPLOAD_NOT_FOUND' || code === 'UPLOAD_INCOMPLETE' || code === 'DISPATCH_INTERRUPTED') {
          // Staged chunks expired (or the gateway restarted mid-dispatch): upload again and resend once.
          for (const s of sources) if (s.identity) completed.delete(s.identity);
          continue;
        }
      }
      if (res.ok && !opts.keep) {
        for (const s of sources) {
          this.store?.delete(this.fingerprint(s));
          if (s.identity) completed.delete(s.identity);
        }
      }
      return res;
    }
    throw new UploadFailedError('dispatch failed');
  }

  /** Ask the gateway to send the request; follow a long-running dispatch to its result. */
  private async dispatch(req: Record<string, unknown>, opts: ResumableSendOptions): Promise<Response> {
    const dispatchId = randomId();
    const payload = JSON.stringify({ dispatch_id: dispatchId, ...req });
    // The original request's headers go along (the gateway forwards them); body headers are ours.
    const extra: Record<string, string> = {};
    let accept = 'application/json';
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const lower = k.toLowerCase();
      if (lower === 'content-type' || lower === 'content-length') continue;
      if (lower === 'accept') { accept = v; continue; }
      extra[k] = v;
    }
    const headers = { ...this.headers(), ...extra, 'Content-Type': 'application/json', Accept: accept };
    const target = opts.dispatchUrl ?? this.url('/api/uploads/dispatch');

    let res: Response | null = null;
    for (let attempt = 0; attempt < this.retries && !res; attempt++) {
      if (opts.signal?.aborted) throw abortError();
      try {
        res = await this.fetchWithin(target, { method: 'POST', headers, body: payload }, this.timeouts.dispatch, opts.signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || opts.signal?.aborted) throw abortError();
        // The request may or may not have reached the gateway — the dispatch id makes the retry safe.
        await this.sleep(this.backoff(attempt, null));
      }
    }
    if (!res) throw new UploadFailedError('dispatch request failed');

    while (res.status === 202 && (await isRunning(res))) {
      if (opts.signal?.aborted) throw abortError();
      await this.sleep(500);
      res = await this.call(`/api/uploads/dispatch/${dispatchId}?wait=30`, { method: 'GET', headers: { ...this.headers(), ...extra, Accept: accept } }, opts.signal, this.timeouts.dispatch);
    }
    return res;
  }
}

/** The gateway's "still running" answer — by its marker header, or (header hidden by CORS) by its body. */
async function isRunning(res: Response): Promise<boolean> {
  const marker = res.headers.get('x-upload-dispatch');
  if (marker !== null) return marker === 'running';
  const body = (await res.clone().json().catch(() => undefined)) as { state?: unknown; dispatch_id?: unknown } | undefined;
  return body?.state === 'running' && typeof body.dispatch_id === 'string';
}

function splitPath(pathWithQuery: string): [string, string | undefined] {
  const i = pathWithQuery.indexOf('?');
  return i < 0 ? [pathWithQuery, undefined] : [pathWithQuery.slice(0, i), pathWithQuery.slice(i + 1) || undefined];
}

/** Turn a browser FormData into upload parts (strings stay fields, Blobs/Files become uploaded files). */
export function partsFromFormData(form: FormData): UploadPart[] {
  const parts: UploadPart[] = [];
  form.forEach((value, name) => {
    if (typeof value === 'string') parts.push({ name, value });
    else parts.push({ name, source: blobSource(value as Blob), filename: (value as File).name });
  });
  return parts;
}
