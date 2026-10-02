/**
 * 서버가 준 경로 → 그 서버의 절대 주소. 폰은 앱을 기본 브라우저로 열고, 미리보기 그림을 받는다.
 */

/** 서버가 준 경로를 서버 주소에 붙인다 — 다른 곳을 가리키면 빈 문자열(열지 않는다). */
export function serverLink(serverUrl: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return '';
  try {
    const base = new URL(serverUrl);
    const url = new URL(`${serverUrl.replace(/\/+$/, '')}${path}`);
    return url.origin === base.origin ? url.toString() : '';
  } catch {
    return '';
  }
}

