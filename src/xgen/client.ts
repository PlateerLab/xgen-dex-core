export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  onAuthFailure?: () => void;
  timeoutMs?: number;
}

export class HttpClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly onAuthFailure?: () => void;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.onAuthFailure = options.onAuthFailure;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!this.fetchImpl) throw new Error('현재 Node.js 런타임에서 fetch를 사용할 수 없습니다.');
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  getToken(): string {
    return this.accessToken ?? '';
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { auth?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      if (response.status === 401 && options?.auth !== false) this.onAuthFailure?.();
      throw new ApiError(response.status, `${method} ${path} → ${response.status}`, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string, options?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body?: unknown, options?: { auth?: boolean; timeoutMs?: number }): Promise<T> {
    return this.json<T>('POST', path, body, options);
  }

  async stream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      if (response.status === 401) this.onAuthFailure?.();
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status, `stream ${path} → ${response.status}`, text);
    }
    return response;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return this.accessToken ? { ...extra, Authorization: `Bearer ${this.accessToken}` } : { ...extra };
  }
}

export function normalizeBaseUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}
