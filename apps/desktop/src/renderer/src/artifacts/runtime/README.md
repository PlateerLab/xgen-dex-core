# 아티팩트 프레임 런타임 (vendored)

에이전트가 만든 React 아티팩트는 **격리 프레임**에서 돈다 — `sandbox="allow-scripts"`
(allow-same-origin **없이**) 라 오리진이 불투명하고, 프레임 자신에게는 네트워크가
없다. 그래서 실행에 필요한 두 조각을 호스트가 텍스트로 건네준다.

| 파일 | 무엇 |
|---|---|
| `react-runtime.js.txt` | React + ReactDOM(client) IIFE. `globalThis.__ARTIFACT_REACT__` 를 세운다 |
| `babel.min.js.txt` | `@babel/standalone` — 프레임 안에서 JSX/TS 를 변환한다 (7.28.4) |

## 어디서 왔나 — 그리고 왜 여기 또 있나

정본은 xgen-frontend 의 `apps/web/public/lib/artifact-runtime/` 이다. 두 저장소가
갈라져 있어 공유 패키지로 둘 수 없으므로 **복사본**이며, 웹 쪽이 갱신되면 여기도
같이 옮겨야 한다 (그 방법은 정본 README 에 있다).

같은 바이트여야 하는 이유: 같은 아티팩트가 웹에서도 앱에서도 열린다. 런타임이
갈라지면 "웹에서는 되는데 앱에서는 안 되는" 아티팩트가 생기고, 그 원인은 아티팩트
소스 어디에도 없다.

## 확장자가 `.txt` 인 이유

브라우저가 스크립트로 불러오는 파일이 아니라, 우리가 **텍스트로 읽어 프레임에
넘기는 payload** 다. `.js` 로 두면 소스 트리를 훑는 도구들이 3MB 짜리 남의 번들을
우리 코드로 착각해 읽는다.

데스크톱에서는 vite 의 `?raw` 로 **동적 import** 한다 — 아티팩트 화면을 처음 열 때만
받아 오는 별도 청크가 되어, 앱 시작에는 이 3MB 가 실리지 않는다.
