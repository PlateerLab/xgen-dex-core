/**
 * 아티팩트 실행 프레임의 문서와 그 CSP — main 이 `xgenartifact://frame/` 로 낸다.
 *
 * 문서는 `artifact-frame.html` 그대로다(빌드 시 문자열로 박힌다). CSP 는 여기서
 * **헤더로** 붙는다 — 웹에서 미들웨어가 `/artifact-frame.html` 경로에 붙이는 것과
 * 같은 값이고, 프레임 안의 `<meta>` 는 그 헤더가 사라져도 남는 이중 잠금이다.
 *
 * `connect-src 'none'` 이 핵심이다: 이 문서에는 네트워크가 없다. 아티팩트가 데이터를
 * 얻는 길은 호스트에게 alias 로 부탁하는 것뿐이고, 그 alias 가 무엇인지는 서버가
 * 검증해 내려준 선언에만 있다.
 */
import html from './artifact-frame.html?raw';

export const ARTIFACT_FRAME_HTML = html;

export const ARTIFACT_FRAME_CSP = [
  "default-src 'none'",
  // 인라인 + eval — 프레임은 외부 스크립트를 부를 수 없다(불투명 오리진에서
  // 'self' 는 아무 것도 가리키지 않는다). 런타임과 아티팩트 코드는 호스트가
  // 건네준 문자열이라 여기서 실행된다.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  // 네트워크 없음 — 이 한 줄이 "프레임은 아무 데도 못 간다" 를 만든다.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');
