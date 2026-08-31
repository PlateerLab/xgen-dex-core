// 서버별 인증서 예외와 SSO 완료 응답을 안전하게 검증하는 연결 보안 도우미
import type { LoginResult } from '../core/types';

const PRIVATE_CA_ERROR = 'CERT_AUTHORITY_INVALID';

function certificateErrorName(result: string): string {
  return result.replace(/^net::/, '').replace(/^ERR_/, '');
}

/** 사설 CA 신뢰 실패이며 사용자가 예외를 명시했는지 확인한다. */
export function shouldIgnorePrivateCertificateError(
  enabled: boolean,
  verificationResult: string,
): boolean {
  return enabled && certificateErrorName(verificationResult) === PRIVATE_CA_ERROR;
}

/** 설정된 서버 hostname의 사설 CA 신뢰 실패만 허용한다. */
export function shouldAllowPrivateCertificate(
  serverUrl: string,
  enabled: boolean,
  hostname: string,
  verificationResult: string,
): boolean {
  if (!shouldIgnorePrivateCertificateError(enabled, verificationResult)) return false;
  try {
    return new URL(serverUrl).hostname.toLowerCase() === hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** 설정된 XGEN Node WebSocket에 적용할 TLS 검증 옵션을 만든다. */
export function xgenWebSocketTlsOptions(enabled: boolean): { rejectUnauthorized: boolean } {
  return { rejectUnauthorized: !enabled };
}

/** 서버 origin에 상대 SSO PATH와 고정 완료 콜백을 결합한다. */
export function buildSsoUrl(serverUrl: string, path: string, callbackName: string): string {
  const base = new URL(serverUrl);
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    throw new Error('SSO PATH는 /로 시작하는 상대 경로여야 합니다.');
  }
  const url = new URL(trimmed, base.origin);
  if (url.origin !== base.origin) throw new Error('SSO PATH는 설정된 서버와 같은 origin이어야 합니다.');
  url.searchParams.set('next', `parent.${callbackName}`);
  return url.toString();
}

/** 원격 SSO 페이지가 전달한 gateway 로그인 응답을 최소 필드만 채택한다. */
export function parseSsoLoginResponse(payload: unknown): LoginResult {
  if (!payload || typeof payload !== 'object') throw new Error('SSO 인증 응답이 올바르지 않습니다.');
  const value = payload as Record<string, unknown>;
  if (value.success !== true || typeof value.access_token !== 'string' || !value.access_token) {
    throw new Error(typeof value.message === 'string' ? value.message : 'SSO 인증에 실패했습니다.');
  }
  const optionalString = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key] ? (value[key] as string) : undefined;
  return {
    accessToken: value.access_token,
    refreshToken: optionalString('refresh_token'),
    tokenType: optionalString('token_type') ?? 'bearer',
    userId: optionalString('user_id') ?? '',
    username: optionalString('username') ?? '',
  };
}
