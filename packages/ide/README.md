# @dex/ide

채팅 안의 IDE 보기. 에이전트가 이미 가진 것(스토리지·샌드박스·git)을 편집기처럼 보여 준다.

| 자리 | 무엇 |
| --- | --- |
| 왼쪽 | 활동 막대와 사이드바: 탐색기(스토리지 그대로)·찾기·소스 제어. 보기는 더할 수 있다(`extraViews`) |
| 가운데 | 편집기 탭(Monaco, 최대 3묶음 나누기)·비교 화면·그림 미리보기, 아래 터미널 |
| 오른쪽 | 에이전트 채팅(호스트가 넘긴다) |

편집기와 같은 쓰임새를 목표로 한다: 미리보기 탭, 끌어서 옮기기, 빠른 열기(`Ctrl+P`), 명령(`Ctrl+Shift+P`),
저장 충돌 비교, 파일에서 찾기·바꾸기, 스테이지·커밋·푸시·브랜치·스태시, 연결이 끊겨도 이어지는 터미널.

## 쓰는 법

```tsx
import { IdeStore, IdeView, type IdeHost } from '@dex/ide'; // 밖에서는 'xgen-dex-ide'
import '@dex/ide/ide.css';

const store = new IdeStore(host); // 에이전트마다 하나. 채팅 탭을 닫을 때 store.dispose()

<IdeView store={store} chat={<Chat />} theme="dark" />;
```

`IdeStore` 는 화면과 떨어져 산다 — 탭을 바꿔 IDE 가 다시 그려져도 고친 버퍼·되돌리기 기록·터미널
연결이 남는다. 호스트는 `IdeHost` 를 구현한다:

- `listFiles` · `subscribeChanges` — 스토리지 목록과 변경 알림(탐색기)
- `readFile` · `saveFile(path, bytes, baseSha)` · `stat` · `readRaw` · `fs` — 샌드박스 파일(저장은 연 판의 sha 가 조건, 어긋나면 `IdeError('changed')`)
- `search` · `replace` · `git` — 샌드박스 안에서 찾기·바꾸기·git
- `terminals` · `closeTerminal` · `openTerminal(id, size, handlers)` — 터미널 소켓(같은 id 로 다시 붙으면 이어진다)
- `loadMonaco` — Monaco 와 그 worker 는 호스트의 번들러가 맡는다
- `storage` · `notify` · `openExternal` · `download` · `copyText` — 선택

색은 `.xide-root` 의 `--xide-*` 변수로 바꾼다. xterm 은 처음 터미널을 열 때 불러온다(서버 렌더 안전).
