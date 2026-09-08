/**
 * vite 의 `?raw` — 파일을 **문자열로** 가져온다.
 *
 * 이 저장소는 `vite/client` 타입을 깔지 않으므로(브라우저 전역이 통째로 딸려
 * 온다) 실제로 쓰는 두 종류만 여기서 선언한다.
 *
 * 어디에 쓰나: 아티팩트 실행 런타임(React·Babel)과 격리 프레임 문서. 셋 다
 * **코드가 아니라 payload** 다 — 우리가 읽어서 프레임에 건네주는 텍스트라
 * 번들러가 모듈로 해석하면 안 된다.
 */
declare module '*.txt?raw' {
  const content: string;
  export default content;
}

declare module '*.html?raw' {
  const content: string;
  export default content;
}
