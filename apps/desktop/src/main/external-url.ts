/**
 * 바깥(기본 브라우저·OS)으로 넘겨도 되는 주소인가 — http(s)·mailto 만.
 *
 * `shell.openExternal` 은 받은 주소를 OS 에 그대로 넘긴다. file:// · smb:// · 등록된 앱
 * 프로토콜도 열린다(윈도에서 file:///…exe 는 실행된다). 창 안의 웹 콘텐츠(아티팩트 — 에이전트가
 * 쓴 코드, 브라우저 탭, 설명 속 링크)가 window.open 으로 여는 주소는 **남이 고른 것**이라,
 * 그 길로는 웹 주소만 내보낸다.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(String(url)).protocol)
  } catch {
    return false
  }
}
