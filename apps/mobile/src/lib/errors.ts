/**
 * 사용자 문구 — ApiError(상태코드+서버 본문)를 사람이 읽는 한 줄로.
 * "POST /api/auth/login → 401" 같은 와이어 문자열을 그대로 보여주지 않는다.
 */

interface ApiErrorLike {
  status?: number;
  body?: unknown;
  message?: string;
}

function bodyMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const key of ['message', 'detail', 'error']) {
    const v = b[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const inner = bodyMessage(v);
      if (inner) return inner;
    }
  }
  return null;
}

export function friendlyError(e: unknown, fallback: string): string {
  const err = e as ApiErrorLike;
  const server = bodyMessage(err?.body);
  if (server) return server;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status === 401) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (status === 403) return '권한이 없습니다. 관리자에게 문의하세요.';
  if (status === 404) return '서버 주소를 확인하세요 (API 를 찾을 수 없습니다).';
  if (status !== undefined && status >= 500) return `서버 오류(${status}) — 잠시 후 다시 시도하세요.`;
  if (e instanceof Error && e.message && !/^(GET|POST|PUT|DELETE) \//.test(e.message)) {
    return e.message;
  }
  return fallback;
}
