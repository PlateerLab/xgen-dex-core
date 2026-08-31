/**
 * 서버 주소 확정 — 사용자가 스킴 없이 `dev-xgen.example.com` 만 적어도
 * **https → http 순서로 실제로 두드려** 최종 주소를 정한다.
 *
 * 판정 규칙:
 *   · 어떤 HTTP 응답이든 오면(상태코드 무관, 401/404 포함) 그 스킴이 맞다 —
 *     게이트웨이인지 검사하는 자리가 아니라 **스킴을 정하는** 자리다.
 *   · https 에서 TLS **검증** 실패(자가서명 등)는 "https 서버가 있다"는 뜻이므로
 *     https 로 확정한다 — 사설 인증서 예외는 저장 뒤 앱의 인증서 예외 절차가
 *     처리한다 (connection-security).
 *   · 연결 자체가 안 되면(거부·DNS·시간초과) 다음 후보로 넘어간다.
 *
 * 로그인 실패 문구도 여기 둔다 — 렌더러에 IPC 래핑 원문("Error invoking remote
 * method …")이 그대로 보이던 것을, 사람이 읽을 문장으로 바꾼다.
 */
import { ApiError } from '../core/client';

/** 입력 → 시도할 후보 목록. 스킴이 있으면 그것만, 없으면 https 먼저. */
export function candidatesFor(input: string): string[] {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  const bare = raw.replace(/^\/+/, '');
  if (!bare) return [];
  return [`https://${bare}`, `http://${bare}`];
}

/** fetch 실패에서 오류 코드를 꺼낸다 (undici 는 cause 에 싣는다). */
function errorCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  return String(e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? '');
}

/** TLS **검증** 실패인가 — 서버는 있는데 인증서를 못 믿는 경우. */
export function isTlsVerifyError(err: unknown): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|DEPTH_ZERO|EXPIRED/i.test(errorCode(err));
}

export type ProbeFetch = (url: string) => Promise<void>;

export type ProbeResult = { url: string } | { error: string };

/** 후보를 차례로 두드려 최종 서버 주소를 정한다. */
export async function resolveServerUrl(input: string, probe: ProbeFetch): Promise<ProbeResult> {
  const candidates = candidatesFor(input);
  if (candidates.length === 0) return { error: '서버 주소를 입력하세요.' };
  try {
    // 형식 검증은 한 번만 — 뒤 후보는 스킴만 다르다.
    new URL(candidates[0]);
  } catch {
    return { error: '주소 형식이 올바르지 않습니다.' };
  }
  for (const url of candidates) {
    try {
      await probe(url);
      return { url };
    } catch (e) {
      if (url.startsWith('https://') && isTlsVerifyError(e)) return { url };
      // 연결 불가 — 다음 후보(https → http)로.
    }
  }
  const host = candidates[0].replace(/^https?:\/\//, '');
  return { error: `서버에 연결할 수 없습니다: ${host}` };
}

/**
 * 로그인 실패 → 사용자 문장.
 *
 * 401/403 은 자격 증명 문제다 — 상태코드·경로를 그대로 보여주면 사용자는
 * 자기 잘못인지 서버 장애인지 구분하지 못한다 (실기: "ApiError: POST
 * /api/auth/login → 401" 이 그대로 노출).
 */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      // 서버가 사유를 실어 줬으면 그것을 우선한다 (계정 잠금 등).
      const body = err.body as { message?: unknown; detail?: unknown } | undefined;
      const detail =
        typeof body?.message === 'string' && body.message
          ? body.message
          : typeof body?.detail === 'string' && body.detail
            ? body.detail
            : '';
      return detail || '이메일 또는 비밀번호가 올바르지 않습니다.';
    }
    if (err.status >= 500)
      return `서버 오류로 로그인하지 못했습니다 (HTTP ${err.status}). 잠시 후 다시 시도하세요.`;
    return `로그인에 실패했습니다 (HTTP ${err.status}).`;
  }
  const name = (err as Error)?.name ?? '';
  if (name === 'TypeError' || name === 'AbortError') {
    return '서버에 연결할 수 없습니다. 네트워크 상태와 서버 주소를 확인하세요.';
  }
  // XgenClient.login 은 서버 거절 사유를 일반 Error 문장으로 던진다 — 그대로 보여준다.
  const msg = (err as Error)?.message ?? '';
  return msg || '로그인에 실패했습니다.';
}
