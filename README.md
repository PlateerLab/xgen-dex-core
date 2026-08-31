# XGEN Dex

XGEN 에이전트를 쓰는 세 가지 방법 — **데스크톱 앱**, **터미널**, **VSCode 확장**.
셋은 하나의 코어를 공유한다.

```
packages/protocol   XGEN 서버와 말하는 법. 의존 0.
packages/engine     이 기기에서 실제로 무언가를 하는 것. Electron 은 모른다.
packages/rpc        엔진을 다른 프로세스에 빌려주는 법.

apps/desktop        Electron — 창 · 트레이 · 오버레이 아바타 · 자동 업데이트
apps/cli            터미널 — Ink TUI + 일회성 명령
apps/vscode         편집기 — 웹뷰 + CLI 엔진을 RPC 로
```

구조와 그 이유는 [ARCHITECTURE.md](./ARCHITECTURE.md).

## 왜 한 저장소인가

예전에는 데스크톱과 CLI 가 **다른 저장소**에 있었고, CLI 는 데스크톱의 API 계층을
복사해서 시작했다. 3일 만에 갈라졌다 — `history.ts` 는 28%만 같았고, 첨부 파싱이
빠져 CLI 로 열면 첨부가 없는 것처럼 보였으며, 사내 인증서 옵션이 따라오지 않아
사내망에서 CLI 만 붙지 않았다. 무엇보다 같은 WebSocket 프로토콜을 각자 구현해서
재접속 정책이 서로 달랐다.

버전 붙인 패키지로 나눠도 같은 일이 반복된다 — 서버 API 하나 바뀌면 PR 이 다섯 건이
되고, 하나만 잊으면 그대로 오늘로 돌아간다. 한 저장소면 **PR 하나**고, 코어를 고치면
세 표면의 CI 가 그 자리에서 같이 돈다.

## 개발

```bash
npm install                    # packages/* + apps/cli + apps/vscode
npm --prefix apps/desktop install   # 데스크톱은 따로 (electron + 네이티브 FUSE)

npm run contracts              # 앱이 코어를 우회하지 않는지
npm test                       # 전 워크스페이스
npm --prefix apps/desktop run dev   # 데스크톱 개발 실행
npm --prefix apps/cli run build && node apps/cli/dist/cli.js
```

`apps/desktop` 이 workspace 밖인 이유: electron 과 네이티브 FUSE 바인딩이 루트로
호이스팅되면 electron-builder 가 패키징할 때 조용히 어긋난다. 대신 세 앱 모두
`@dex/*` 를 **경로 별칭으로 소스 번들**한다 — 심링크도 버전 올림도 없다.

## 배포

`v*` 태그를 push 하면 하나의 GitHub Release 에 셋이 함께 올라간다.

- 데스크톱 설치본 — Windows `.exe` · macOS `.dmg` · Linux `.AppImage`/`.deb`
  (+ electron-updater 피드)
- CLI — npm tarball
- VSCode 확장 — `.vsix`

**태그 하나 = 함께 검증된 조합 하나.** 버전이 갈라지면 "내 CLI 는 되는데 확장은 안
된다"가 되고, 그때 어느 조합이 검증된 것인지 아무도 모른다.

자동 업데이트는 GitHub Release 뿐 아니라 **사용자의 XGEN 서버**(다운로드 센터)도 볼 수
있다. 사내망 배포는 GitHub 에 못 나가고, 조직마다 배포 시점을 따로 잡기 때문이다.

## 지금 각 표면이 여는 것

| | 데스크톱 | CLI | 확장 |
|---|:---:|:---:|:---:|
| 채팅 · 에이전트 · 이력 | ● | ● | ● |
| 로컬 도구 (Shell · 파일 · MCP) | ● | ● | ● |
| SSH 서버 | ● | ● | ○ |
| Teams | ● | — | — |
| 음성 · 아바타 · 브라우저 제어 | ● | — | — |

— 는 "인터페이스는 있고 표면만 없다"는 뜻이다. 타입과 클라이언트는
`packages/protocol` 에 그대로 있고, 여는 것은 RPC 에 case 한 줄 + 명령 하나다.
