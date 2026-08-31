# XGEN Dex

XGEN 에이전트를 쓰는 세 가지 방법.

| | 무엇 | 받는 것 |
|---|---|---|
| **앱** | 데스크톱 앱. 대화 · 오버레이 아바타 · 브라우저 제어 · 워크스페이스 동기화 | Windows `.exe` · macOS `.dmg` · Linux `.AppImage` / `.deb` |
| **CLI** | 터미널. 대화형 UI 와 일회성 명령, 스크립트에서 쓰는 JSON 출력 | npm — [`xgen-dex-cli`](https://www.npmjs.com/package/xgen-dex-cli) |
| **VSCode 확장** | 편집기 안에서 대화. 사이드바 + 명령 팔레트 | `.vsix` |

셋 다 같은 XGEN 서버에 붙고, 같은 계정·같은 에이전트를 봅니다. 로컬 도구(셸 · 파일 ·
MCP 서버)도 같은 것을 씁니다.

모든 파일은 [**Releases**](https://github.com/PlateerLab/xgen-dex-core/releases/latest)
에서 받습니다. 같은 태그의 셋은 함께 검증된 조합입니다.

---

## 앱 설치

### Windows

`XGen-Dex-Setup-<버전>.exe` 를 실행합니다.

서명되지 않은 빌드라 SmartScreen 이 막을 수 있습니다 — **추가 정보 → 실행** 을 누르면
됩니다.

### macOS

`XGen-Dex-<버전>.dmg` 를 열고 **XGen-Dex.app** 을 **응용 프로그램** 으로 끕니다.

첫 실행은 아이콘을 **우클릭 → 열기** 로 해야 합니다(그냥 더블클릭하면 "확인되지 않은
개발자" 로 막힙니다). 그래도 *"손상되었기 때문에 열 수 없습니다"* 가 뜨면 터미널에서:

```bash
xattr -dr com.apple.quarantine "/Applications/XGen-Dex.app"
```

### Linux

```bash
# deb (Ubuntu / Debian) — 권장. 앱 목록과 자동 업데이트가 함께 붙습니다.
sudo dpkg -i XGen-Dex-<버전>.deb
sudo apt-get -f install          # 의존성이 빠졌다는 말이 나오면

# AppImage — 설치 없이 실행
chmod +x XGen-Dex-<버전>.AppImage
./XGen-Dex-<버전>.AppImage
```

### 처음 실행하면

**서버 주소**(예: `https://xgen.example.com`)와 **계정**을 입력합니다. 기본 서버는
들어 있지 않습니다 — 각자의 XGEN 배포를 가리키세요.

사설 인증서를 쓰는 사내 서버라면 설정 → **일반 → 서버** 에서 *사설 인증서 허용* 을
켭니다. SSO 를 쓴다면 같은 자리에서 켜고 경로를 지정합니다.

---

## CLI 설치

Node.js 20 이상이 필요합니다.

```bash
npm i -g xgen-dex-cli
```

`dex` 와 `xgen-dex` 두 이름으로 설치됩니다.

npm 레지스트리에 나갈 수 없는 사내망이라면 Releases 의 `xgen-dex-cli-<버전>.tgz` 를
받아 설치합니다:

```bash
npm i -g ./xgen-dex-cli-<버전>.tgz
```

### 쓰기

```bash
dex                                              # 대화형 터미널 UI
dex profile set corp --server https://xgen.example.com
dex login --email me@corp.com
dex agents list
dex chat --agent <workflow-id>
```

에이전트에게 이 컴퓨터의 셸과 파일을 열어 주려면 로컬 도구를 켭니다. 기본은 꺼져
있습니다.

```bash
dex tools enable --cwd ~/work --allow ~/work
dex tools list                                   # 무엇이 노출되는지
```

새 버전이 나왔는지 확인하고 올립니다.

```bash
dex update            # 있으면 설치, 없으면 최신이라고 알려 줍니다
dex update --check    # 확인만
```

스크립트에서 쓸 때는 `--json`(단일 결과) 또는 `--jsonl`(채팅 이벤트 스트림)을 붙입니다.
전체 명령은 `dex --help`.

### 로그인 정보는 어디에 저장되나

OS 키체인이 있으면 거기, 없으면 사용자 데이터 폴더의 소유자 전용(0600) 파일입니다.
헤드리스 서버나 컨테이너처럼 키링이 없는 곳에서도 그대로 동작합니다. 지금 어느 쪽인지는
`dex status` 가 알려 줍니다.

키링이 매번 암호를 물어 성가시면 `DEX_NO_KEYCHAIN=1` 로 파일 저장을 강제할 수 있습니다.

---

## VSCode 확장 설치

**CLI 를 먼저 설치하세요.** 확장은 대화를 직접 하지 않고 CLI 엔진을 자식 프로세스로
띄워 씁니다.

1. VS Code → 확장 → `…` → **VSIX에서 설치**
2. `xgen-dex-vscode-<버전>.vsix` 선택

또는 터미널에서:

```bash
code --install-extension xgen-dex-vscode-<버전>.vsix
```

VS Code 1.95 이상이 필요합니다.

### 쓰기

명령 팔레트(`Ctrl/Cmd+Shift+P`)에서 **XGEN Dex** 로 시작하는 명령을 씁니다 —
`서버 프로필 설정` → `로그인` → `Agent와 대화` 순서입니다.

`dex` 가 `PATH` 에 없거나 다른 위치에 있으면 설정에서 지정합니다:

| 설정 | 뜻 |
|---|---|
| `xgenDex.cliPath` | `dex` 실행 파일 경로. 비우면 `PATH` 에서 찾습니다 |
| `xgenDex.profile` | 쓸 서버 프로필. 비우면 CLI 의 현재 프로필 |

---

## 업데이트

앱은 스스로 확인합니다 — 설정 → **일반 → 업데이트**. Windows 와 Linux 는 앱 안에서
설치까지 하고, macOS 는 서명 문제로 새 `.dmg` 를 받아 열어 주기까지 합니다(끌어다
놓는 것은 직접).

기본은 이 저장소의 Releases 를 보지만, 사내망처럼 GitHub 에 나갈 수 없는 곳에서는
같은 화면에서 **XGEN** 으로 바꿔 자기 서버의 다운로드 센터를 보게 할 수 있습니다.

CLI 는 `dex update` 로 확인하고 올립니다 — 최신이면 그렇다고만 말합니다. 전역 npm
설치가 아니면 자동으로 올리지 않고 무엇을 하면 되는지 알려 줍니다.

확장은 자동 업데이트가 없으니 새 `.vsix` 로 다시 설치하세요.

---

## 개발

```
packages/protocol   XGEN 서버와 말하는 법. 의존 0.
packages/engine     이 기기에서 실제로 하는 일 — 로컬 도구 · MCP · 서버 브리지.
packages/rpc        엔진을 다른 프로세스에 빌려주는 JSON-RPC.

apps/desktop        Electron
apps/cli            Ink 터미널 UI + 명령
apps/vscode         웹뷰 + CLI 엔진 (RPC)
```

구조와 그 규칙은 [ARCHITECTURE.md](./ARCHITECTURE.md).

### 준비

Node.js 20 이상.

```bash
npm install                        # packages/* + apps/cli + apps/vscode
npm --prefix apps/desktop install  # 데스크톱은 따로 (electron + 네이티브 FUSE)
```

리눅스에서 데스크톱을 빌드하려면 FUSE 헤더가 필요합니다(워크스페이스 가상 드라이브):

```bash
sudo apt-get install libfuse-dev fuse3 pkg-config
```

`apps/desktop` 이 npm workspace 밖인 이유는 electron 과 네이티브 바인딩이 루트로
호이스팅되면 electron-builder 가 패키징할 때 어긋나기 때문입니다. 대신 세 앱 모두
`@dex/*` 를 **경로 별칭으로 소스 번들** 합니다 — 심링크도 버전 올림도 없습니다.

### 실행

```bash
npm --prefix apps/desktop run dev        # 데스크톱 (핫 리로드)
npm --prefix apps/cli run build && node apps/cli/dist/cli.js
npm --prefix apps/vscode run watch       # 확장 — F5 로 디버그 창
```

### 검사

```bash
npm run contracts   # 앱이 코어를 우회하지 않는지
npm test            # 전 워크스페이스
npm --prefix apps/desktop test
```

`npm run contracts` 는 이 저장소가 지키는 규칙을 기계가 확인합니다 — 앱이 `/api/` 를
직접 부르지 않는지, WebSocket 을 직접 열지 않는지, 패키지가 electron 을 알지 않는지,
도메인 타입을 다시 선언하지 않는지, 확장 번들에 엔진이 섞이지 않았는지, 자동 업데이트가
이 저장소를 보는지. CI 가 PR 마다 돌립니다.

### 패키징

```bash
npm --prefix apps/desktop run dist:linux   # 또는 dist:win / dist:mac
cd apps/cli && npm pack
cd apps/vscode && npx @vscode/vsce package --no-dependencies
```

### 릴리스

모든 `package.json` 의 버전을 같은 값으로 올리고 태그를 밀면, CI 가 세 산출물을 만들어
하나의 GitHub Release 에 올리고 CLI 를 npm 에 배포합니다.

```bash
git tag -a v1.2.0 -m "..." && git push origin v1.2.0
```

버전을 하나로 두는 이유는 태그 하나가 **함께 검증된 조합** 하나이기 때문입니다.
