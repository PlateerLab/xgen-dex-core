/**
 * HttpClient — the base transport for all XGEN API calls.
 *
 * Responsibilities:
 * - Resolve URLs against the gateway base URL (everything lives under `/api`).
 * - Attach `Authorization: Bearer <accessToken>` when a token is set.
 * - JSON request/response helpers + a raw streaming fetch for SSE.
 * - Surface a typed `ApiError` and an auth-failure hook so the app can prompt
 *   re-login on 401 (mirrors the frontend's `handleAuthFailure`).
 *
 * Framework-agnostic: takes a `fetch` implementation so it runs in the Electron
 * renderer, the main process (electron `net`/undici), Node tests, or a browser.
 */

import {
  ResumableUploader,
  UploadFailedError,
  UploadUnsupportedError,
  blobSource,
  bytesSource,
  type ResumableSource,
  type ResumeStore,
  type UploadPart,
  type UploadProgress,
} from './resumable-upload';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /** Called on any 401 so the host can clear the token and prompt re-login. */
  onAuthFailure?: () => void;
  /** Default per-request timeout (ms) for non-streaming calls. */
  timeoutMs?: number;
  /** Remembers chunked-upload ids so an upload cut off by a restart continues where it stopped. */
  uploadStore?: ResumeStore;
  /**
   * React Native: turn a `{ uri }` file reference into a ranged-read source. Without it a
   * `{ uri }` file is sent as one direct request (RN FormData streams it from disk).
   */
  uriSource?: (ref: { uri: string }, filename: string, type: string) =>
    ResumableSource | null | Promise<ResumableSource | null>;
}

/** One file of an upload: bytes, a Blob/File, a React Native file reference, or a ranged-read source. */
export type UploadFileData = Uint8Array | Blob | { uri: string } | ResumableSource;

/** One multipart part, in order: a text field or a file. */
export type UploadFormPart =
  | { name: string; value: string }
  | { name: string; file: UploadFileData; filename: string; type?: string };

export interface UploadOptions {
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Timeout of the single-request fallback (old gateways). Chunked uploads have no overall deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** Extra headers for the service request (sent along by the gateway). */
  headers?: Record<string, string>;
  /** Keep the staged chunks after success (the same file is sent again right after). */
  keep?: boolean;
}

function isResumableSource(x: unknown): x is ResumableSource {
  const s = x as ResumableSource;
  return !!s && typeof s.read === 'function' && typeof s.size === 'number';
}

function isUriRef(x: unknown): x is { uri: string } {
  return !!x && typeof (x as { uri?: unknown }).uri === 'string' && !isResumableSource(x);
}

function isBlob(x: unknown): x is Blob {
  return typeof Blob !== 'undefined' && x instanceof Blob;
}

export class HttpClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly onAuthFailure?: () => void;
  private readonly timeoutMs: number;
  private readonly uploadStore?: ResumeStore;
  private readonly uriSource?: HttpClientOptions['uriSource'];
  private uploaderFor: { base: string; uploader: ResumableUploader } | null = null;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    // Call fetch without a receiver: a browser's fetch throws "Illegal invocation" when `this` is not the window
    // (here it would be this client). Same for a host that passes `window.fetch` itself.
    const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.fetchImpl = fetchFn && ((input, init) => fetchFn(input, init));
    this.onAuthFailure = opts.onAuthFailure;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.uploadStore = opts.uploadStore;
    this.uriSource = opts.uriSource;
    if (!this.fetchImpl) {
      throw new Error('HttpClient: no fetch implementation available');
    }
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.accessToken) h['Authorization'] = `Bearer ${this.accessToken}`;
    return h;
  }

  /** GET/POST/… returning parsed JSON. Throws ApiError on non-2xx. */
  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { auth?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers({
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401 && opts?.auth !== false) this.onAuthFailure?.();
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string, opts?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('GET', path, undefined, opts);
  }

  /**
   * Multipart upload — every file upload goes through here.
   *
   * Files are sent in verified chunks through the gateway's resumable upload (up to 1 GiB, survives
   * dropped connections), then the gateway sends the original multipart request to the service and
   * returns its response unchanged. A gateway without `/api/uploads` gets the old single request.
   * `form` is a FormData, or ordered parts (which also take ranged-read sources and RN `{ uri }`).
   */
  async upload<T>(path: string, form: FormData | UploadFormPart[], opts: UploadOptions = {}): Promise<T> {
    const method = opts.method ?? 'POST';
    const res = await this.sendUpload(method, path, form, opts);
    return this.readJson<T>(res, method, path);
  }

  /** Like `upload` but returns the raw Response (SSE, binary or status-specific handling). */
  async sendUpload(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    form: FormData | UploadFormPart[],
    opts: UploadOptions = {},
  ): Promise<Response> {
    const headers = { Accept: 'application/json', ...opts.headers };
    if (!ResumableUploader.knownUnsupported(this.baseUrl)) {
      const parts = await this.chunkedParts(form);
      if (parts) {
        try {
          return await this.uploader().send({ method, path }, { parts },
            { headers, signal: opts.signal, onProgress: opts.onProgress, keep: opts.keep });
        } catch (e) {
          if (!(e instanceof UploadUnsupportedError)) throw this.uploadFailure(e, method, path);
        }
      }
    }
    return this.directRequest(method, path, await this.toFormData(form), headers, opts);
  }

  /**
   * Send a request body that carries file content (bytes, or JSON with base64 inside) the same
   * chunked way — the gateway sends it to the service as the raw body with `contentType`.
   */
  async uploadBody<T>(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: Uint8Array,
    contentType: string,
    opts: UploadOptions = {},
  ): Promise<T> {
    const headers = { Accept: 'application/json', ...opts.headers };
    if (!ResumableUploader.knownUnsupported(this.baseUrl)) {
      try {
        const res = await this.uploader().send({ method, path },
          { raw: bytesSource(body, 'body', contentType), contentType },
          { headers, signal: opts.signal, onProgress: opts.onProgress, keep: opts.keep });
        return await this.readJson<T>(res, method, path);
      } catch (e) {
        if (!(e instanceof UploadUnsupportedError)) throw this.uploadFailure(e, method, path);
      }
    }
    const res = await this.directRequest(method, path, body as unknown as BodyInit,
      { ...headers, 'Content-Type': contentType }, opts);
    return this.readJson<T>(res, method, path);
  }

  private uploader(): ResumableUploader {
    if (!this.uploaderFor || this.uploaderFor.base !== this.baseUrl) {
      this.uploaderFor = {
        base: this.baseUrl,
        uploader: new ResumableUploader({
          baseUrl: this.baseUrl,
          fetch: this.fetchImpl,
          store: this.uploadStore,
          headers: () => this.headers(),
        }),
      };
    }
    return this.uploaderFor.uploader;
  }

  /** Parts for the chunked path, or null when a file can only go as a direct request (RN `{uri}` without a host source). */
  private async chunkedParts(form: FormData | UploadFormPart[]): Promise<UploadPart[] | null> {
    if (!Array.isArray(form)) {
      // React Native's FormData cannot be enumerated — and its files are `{uri}` refs anyway.
      if (typeof (form as { forEach?: unknown }).forEach !== 'function') return null;
      const parts: UploadPart[] = [];
      let ok = true;
      form.forEach((value, name) => {
        if (typeof value === 'string') parts.push({ name, value });
        else if (isBlob(value)) parts.push({ name, source: blobSource(value), filename: (value as File).name });
        else ok = false;
      });
      return ok ? parts : null;
    }
    const parts: UploadPart[] = [];
    for (const p of form) {
      if ('value' in p) { parts.push({ name: p.name, value: p.value }); continue; }
      const type = p.type || (isBlob(p.file) || isResumableSource(p.file) ? p.file.type : '') || 'application/octet-stream';
      let source: ResumableSource | null;
      if (isResumableSource(p.file)) source = p.file;
      else if (p.file instanceof Uint8Array) source = bytesSource(p.file, p.filename, type);
      else if (isBlob(p.file)) source = blobSource(p.file, p.filename);
      else source = this.uriSource ? await this.uriSource(p.file, p.filename, type) : null;
      if (!source) return null;
      parts.push({ name: p.name, source, filename: p.filename, contentType: type });
    }
    return parts;
  }

  /** The same parts as one FormData (single-request fallback). */
  private async toFormData(form: FormData | UploadFormPart[]): Promise<FormData> {
    if (!Array.isArray(form)) return form;
    const out = new FormData();
    for (const p of form) {
      if ('value' in p) { out.append(p.name, p.value); continue; }
      const type = p.type || (isBlob(p.file) || isResumableSource(p.file) ? p.file.type : '') || 'application/octet-stream';
      if (isUriRef(p.file)) {
        // RN FormData streams `{ uri, name, type }` from disk.
        out.append(p.name, { uri: p.file.uri, name: p.filename, type } as unknown as Blob);
      } else if (isBlob(p.file)) {
        out.append(p.name, p.file, p.filename);
      } else {
        const bytes = p.file instanceof Uint8Array ? p.file : await p.file.read(0, p.file.size);
        // The bytes may be a view over a larger (IPC) buffer — copy exactly this file's bytes.
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        out.append(p.name, new Blob([buf], { type }), p.filename);
      }
    }
    return out;
  }

  private async directRequest(
    method: string,
    path: string,
    body: BodyInit | FormData,
    headers: Record<string, string>,
    opts: UploadOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000);
    try {
      // multipart: fetch sets Content-Type with the boundary itself.
      return await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers(headers),
        body: body as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  private uploadFailure(e: unknown, method: string, path: string): unknown {
    if (!(e instanceof UploadFailedError)) return e;
    if (e.status === 401) this.onAuthFailure?.();
    return new ApiError(e.status ?? 0, `${method} ${path} → ${e.status ?? 'upload failed'}`,
      e.body ?? { detail: { code: e.code, message: e.message } });
  }

  private async readJson<T>(res: Response, method: string, path: string): Promise<T> {
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`, parsed);
    }
    return parsed as T;
  }

  post<T>(path: string, body?: unknown, opts?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('POST', path, body, opts);
  }

  /**
   * POST a JSON body and read the raw BINARY response (e.g. TTS audio bytes).
   * Returns the bytes plus the response `Content-Type` so the caller can wrap a
   * correctly-typed Blob (audio/wav|mpeg|ogg). Throws ApiError on non-2xx.
   */
  async postBinary(
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', Accept: 'audio/*' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `POST ${path} → ${res.status}`, text);
    }
    const ab = await res.arrayBuffer();
    return { bytes: new Uint8Array(ab), contentType: res.headers.get('content-type') ?? '' };
  }

  /**
   * GET a raw BINARY response (Teams 첨부 다운로드 등). `postBinary` 의 GET 짝.
   *
   * 파일명은 응답 헤더가 아니라 **호출자가 이미 아는 값**을 쓴다 —
   * Content-Disposition 의 RFC 5987 인코딩을 여기서 되풀이 파싱할 이유가 없고,
   * 서버도 우리가 쿼리로 넘긴 이름을 그대로 되돌려줄 뿐이다.
   */
  async getBinary(
    path: string,
    opts?: { timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'GET',
        headers: this.headers({ Accept: '*/*', ...(opts?.headers ?? {}) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `GET ${path} → ${res.status}`, text);
    }
    const ab = await res.arrayBuffer();
    return { bytes: new Uint8Array(ab), contentType: res.headers.get('content-type') ?? '' };
  }

  /**
   * 원시 요청 — 상태·헤더·본문을 그대로 돌려준다(JSON 으로 풀지 않는다).
   *
   * 앱 프레임의 fetch 를 대신 부르는 자리다: 그 응답이 JSON 일지 텍스트일지
   * 바이너리일지는 앱의 스크립트가 정한다. 우리가 미리 해석하면 틀린다.
   */
  async raw(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: string | null; timeoutMs?: number },
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string | null; bodyB64?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers({ Accept: '*/*', ...(opts?.headers ?? {}) }),
        body: opts?.body ?? undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) this.onAuthFailure?.();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const type = res.headers.get('content-type') ?? '';
    const textual = !type || /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg)/i.test(type);
    if (textual) {
      return { status: res.status, statusText: res.statusText, headers, body: await res.text() };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status, statusText: res.statusText, headers, body: null,
      bodyB64: Buffer.from(bytes).toString('base64'),
    };
  }

  put<T>(path: string, body?: unknown, opts?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('PUT', path, body, opts);
  }

  /** 바이트 본문을 그대로 PUT 한다(그림 한 장 같은 것). JSON 응답을 돌려준다. */
  putBytes<T>(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.uploadBody<T>('PUT', path, bytes, contentType, { timeoutMs: opts?.timeoutMs ?? 60_000 });
  }

  patch<T>(
    path: string,
    body?: unknown,
    opts?: { auth?: boolean; timeoutMs?: number },
  ): Promise<T> {
    return this.json<T>('PATCH', path, body, opts);
  }

  /** `delete` is a reserved word in some call sites — keep the short alias. */
  del<T>(path: string, opts?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('DELETE', path, undefined, opts);
  }

  /**
   * Open a raw streaming POST (for SSE). Returns the Response so the caller can
   * read `response.body` as a stream. Does NOT enforce the JSON timeout — SSE
   * connections are long-lived (the gateway allows 1h for `/stream` paths).
   */
  async stream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `stream ${path} → ${res.status}`, text);
    }
    return res;
  }
}

/** Strip trailing slashes so `${base}/api/...` never produces `//api`. */
export function normalizeBaseUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}
