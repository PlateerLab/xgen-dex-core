// 브라우저와 Node 양쪽에서 쓰는 SSO 입력/응답 검증. Node 내장 모듈을 import하지 않는다.
import type { LoginResult } from '@dex/protocol/types';

/** 서버 origin에 상대 SSO PATH와 고정 완료 콜백을 결합한다. */
export function buildSsoUrl(serverUrl: string, path: string, callbackName: string): string {
  const base = new URL(serverUrl);
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    throw new Error('SSO PATH는 /로 시작하는 상대 경로여야 합니다.');
  }
  const url = new URL(trimmed, base.origin);
  if (url.origin !== base.origin) {
    throw new Error('SSO PATH는 설정된 서버와 같은 origin이어야 합니다.');
  }
  url.searchParams.set('next', `parent.${callbackName}`);
  return url.toString();
}

/** 원격 SSO 페이지가 전달한 gateway 로그인 응답을 최소 필드만 채택한다. */
export function parseSsoLoginResponse(payload: unknown): LoginResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('SSO 인증 응답이 올바르지 않습니다.');
  }
  const value = payload as Record<string, unknown>;
  if (value.success !== true || typeof value.access_token !== 'string' || !value.access_token) {
    throw new Error(
      typeof value.message === 'string' ? value.message : 'SSO 인증에 실패했습니다.',
    );
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
