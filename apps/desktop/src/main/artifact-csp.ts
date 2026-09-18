/**
 * 아티팩트 앱 응답의 CSP 에서 `frame-ancestors` 만 걷어낸다.
 *
 * 웹에서는 아티팩트와 그것을 감싸는 화면이 같은 오리진이라 서버가 보내는
 * `frame-ancestors 'self'` 가 맞는 규칙이다. 앱에서는 부모가 렌더러(file://·개발
 * 서버)라 오리진이 다르므로, 그대로 두면 브라우저가 프레임을 **통째로 거부한다**
 * — 새 창으로는 열리는데 [아티팩트] 탭만 빈 화면인 그 모양이다(실증 2026-09-18).
 *
 * **나머지 지시자는 한 글자도 건드리지 않는다.** 공개 링크로 열린 앱에 서버가
 * 씌우는 `sandbox` 는 그대로 살아 있어야 한다 — 무엇을 격리할지 정하는 쪽은
 * 언제나 서버이고, 앱은 자기가 부모라서 생기는 한 줄만 치운다.
 */

/** 지시자 하나만 뺀 CSP 값. 남는 것이 없으면 빈 문자열. */
export function stripFrameAncestors(csp: string): string {
  return csp
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\b/i.test(part))
    .join('; ');
}

/**
 * webRequest 의 응답 헤더 묶음(`Record<string, string[]>`)에 같은 일을 한다.
 * 헤더 이름의 대소문자는 서버마다 다르므로 소문자로 견준다.
 */
export function stripFrameAncestorsFromHeaders(
  headers: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-security-policy') {
      out[name] = values;
      continue;
    }
    const kept = values.map(stripFrameAncestors).filter((csp) => csp.length > 0);
    if (kept.length > 0) out[name] = kept;
  }
  return out;
}
