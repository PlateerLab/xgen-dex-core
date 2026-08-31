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
}

export class HttpClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly onAuthFailure?: () => void;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.onAuthFailure = opts.onAuthFailure;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
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

  /** Multipart upload (아바타 에셋 등). Content-Type 은 fetch 가 boundary 와
   *  함께 자동 설정하므로 지정하지 않는다. 대용량(모델 zip) 대비 긴 타임아웃. */
  async upload<T>(path: string, form: FormData, opts?: { timeoutMs?: number }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'POST',
        headers: this.headers({ Accept: 'application/json' }),
        body: form as unknown as BodyInit,
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
      if (res.status === 401) this.onAuthFailure?.();
      throw new ApiError(res.status, `POST ${path} → ${res.status}`, parsed);
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
    opts?: { timeoutMs?: number },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'GET',
        headers: this.headers({ Accept: '*/*' }),
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

  put<T>(path: string, body?: unknown, opts?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('PUT', path, body, opts);
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
