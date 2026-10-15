/**
 * 앱 공개 링크의 절대 주소 — 서버가 준 **경로**에 설정의 서버 주소를 붙인다.
 *
 * 렌더러는 서버 주소를 모르고(그건 main 의 설정이다), 서버는 자기가 어떤 호스트로
 * 보이는지 모른다. 둘을 아는 자리가 main 이라 여기서 붙인다.
 *
 * 렌더러가 넘긴 값은 **경로만** 받는다. 절대 주소나 `//host` 같은 것이 오면 서버가 아닌
 * 곳을 기본 브라우저로 열게 되므로, 붙인 결과가 서버와 같은 오리진일 때만 돌려준다.
 */
export function publicAppUrl(serverBase: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const base = String(serverBase ?? '').replace(/\/+$/, '');
  let origin: string;
  let url: URL;
  try {
    origin = new URL(base).origin;
    url = new URL(`${base}${path}`);
  } catch {
    return null;
  }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
  return url.toString();
}
