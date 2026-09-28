# Dex CLI

XGEN Dex의 headless CLI이자 VS Code 확장이 사용할 로컬 엔진입니다. 인증·Agent·채팅·대화 기록에
필요한 transport를 자체 포함하며 Electron이나 React 앱 없이 독립적으로 개발·빌드·실행됩니다.

현재 구현된 범위:

- `dex` 또는 `dex ui`로 실행하는 대화형 터미널 UI
- 최초 서버 설정, 로그인, profile 전환을 포함한 온보딩
- Agent 사이드바, History, 스트리밍 채팅과 도구 활동 표시
- 명령 팔레트와 채팅 취소
- 여러 XGEN 서버 profile 관리
- OS keychain을 사용한 access/refresh token 저장
- 비밀번호 로그인, 세션 복원, 토큰 회전, 로그아웃
- Agent 목록과 검색
- SSE 채팅 스트리밍과 취소
- 대화 목록과 turn 조회
- 로컬 Shell·파일·검색·열기 도구와 XGEN MCP WebSocket bridge
- VS Code 같은 클라이언트를 위한 NDJSON JSON-RPC stdio server

## 개발

Node.js 20 이상이 필요합니다.

```bash
npm install
npm run verify
npm link
```

`npm link` 이후 `dex`와 `xgen-dex` 명령을 사용할 수 있습니다. link 없이 실행하려면
`node dist/cli.js`를 사용합니다.

## 시작하기

```bash
dex profile set corp --server https://xgen.example.com
dex login --email me@corp.com
dex status
dex agents list
```

대화형 터미널에서는 인자 없이 실행하면 TUI가 열립니다.

```bash
dex
# 또는
dex ui
```

주요 키:

- `Tab`: Agent 목록과 메시지 입력 사이 이동
- `Enter`: Agent 선택 또는 메시지 전송
- `Esc`: 실행 중인 채팅 취소
- `Ctrl+K`: 명령 팔레트
- `Ctrl+H`: 대화 기록
- `Ctrl+N`: 새 대화
- `Ctrl+P`: profile 전환
- `Ctrl+Q`: 종료

stdin/stdout이 TTY가 아니거나 `TERM=dumb`, CI 환경이면 자동으로 TUI를 열지 않습니다. 이때
기존 명령, `--json`, `--jsonl`, stdio RPC 출력에는 ANSI 제어 문자가 섞이지 않습니다. 자세한
화면 흐름은 [docs/TUI.md](docs/TUI.md)를 참고하세요.

비밀번호는 명령행 인자로 받지 않습니다. TTY에서는 숨김 prompt를 표시하고 자동화에서는
stdin으로 받습니다.

```bash
printf '%s' "$XGEN_PASSWORD" | dex login --email me@corp.com --password-stdin
```

채팅 메시지도 프로세스 목록이나 shell history에 노출되지 않도록 stdin으로 보낼 수 있습니다.

```bash
echo '이 프로젝트를 설명해줘' | dex chat --agent wf_abc
echo '이 프로젝트를 설명해줘' | dex chat --agent wf_abc --jsonl
```

## 이 PC의 파일과 터미널

**대화를 시작한 폴더가 그 대화의 작업 공간입니다.** 에이전트는 그 폴더 안에서만 파일을
읽고 쓰고 명령을 실행합니다. 켜고 끄는 설정은 없습니다 — 폴더가 곧 범위입니다.

```bash
cd ~/work/my-repo && dex chat --agent wf_abc     # my-repo 가 작업 공간
dex chat --agent wf_abc --folder ~/work/a,~/work/b   # 폴더를 직접 고른다
dex chat --agent wf_abc --no-folder              # 이 PC의 파일·터미널 없이
dex tools list
dex tools status
```

홈이나 드라이브 루트에서 시작하면 폴더를 연결하지 않습니다(홈 전체를 여는 것은 고른
일이 아니므로). TUI 도 연 폴더를 같은 규칙으로 연결합니다.

도구는 `Shell`, `ShellJob`, `ReadFile`, `WriteFile`, `ListDir`, `Search`, `Open`,
`Clipboard`, `Notify`입니다. 상대 경로와 셸의 기본 작업 폴더는 첫 번째 연결 폴더이고,
셸 작업 폴더는 연결 폴더 밖으로 나갈 수 없습니다. 백그라운드 작업(`ShellJob`)은 시작한
대화에만 보입니다.

macOS와 Linux(bubblewrap 이 사용자 네임스페이스를 만들 수 있을 때)에서는 명령과 자식
프로세스가 연결 폴더에만 쓸 수 있도록 가둡니다. 홈·임시 파일은 명령별 임시 폴더를 쓰고
명령이 끝나면 지웁니다. 홈에 설치한 개발 도구(nvm·pyenv·cargo·uv 등)는 읽기 전용으로
보이고, Git 커밋은 사용자 이름으로 됩니다. 가둘 수 없는 OS(Windows, 네임스페이스를 막은
Linux)에서는 사용자 권한으로 돌되 작업 폴더를 연결 폴더 안으로 고정합니다.

대화 없이 도구를 직접 확인하려면 `--folder`(기본은 현재 폴더)를 붙여 호출합니다.

```bash
dex tools run ListDir --args '{"path":"."}'
dex tools run Shell --args '{"command":"npm test","timeout_ms":120000}'
```

되돌리기 어려운 명령(`rm -rf` 등)은 실행 전에 묻습니다. 물을 사람이 없는 파이프·스크립트
실행에서는 거부되니, 꼭 필요할 때만 `dex tools configure --allow-dangerous`로 미리
승인하세요.

대화를 이어가려면 같은 interaction ID를 전달합니다.

```bash
echo '계속 설명해줘' | dex chat \
  --agent wf_abc \
  --interaction 18a4be66-18bd-4e3b-b1d8-6b402bc79242
```

## VS Code engine mode

```bash
dex serve --stdio
```

이 모드에서 stdout은 protocol frame 전용입니다. 로그는 stderr로만 출력됩니다. 각 frame은
한 줄의 JSON-RPC 2.0 객체입니다.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":2,"method":"agents/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"chat/start","params":{"workflowId":"wf_abc","input":"hello"}}
```

채팅은 `chat/start` 결과로 `streamId`를 돌려준 뒤 `chat/event`, `chat/complete`,
`chat/error` notification으로 진행됩니다. 자세한 계약은 [docs/PROTOCOL.md](docs/PROTOCOL.md)를
참고하세요.

## VS Code 확장

`vscode-extension/`에 `dex serve --stdio`만을 엔진으로 사용하는 VS Code 확장이 포함되어
있습니다. 단일 Workspace Webview에서 Agent 선택·변경, 스트리밍 채팅, 취소, 대화 기록,
회사/환경 profile 및 로그인 설정 UI를 제공합니다.

```bash
npm run verify
npm run vscode:install
npm run vscode:verify
code vscode-extension
```

열린 VS Code 창에서 `F5`를 눌러 Extension Development Host를 실행할 수 있습니다. 자세한 구조와
보안 경계는 [docs/VSCODE.md](docs/VSCODE.md)를 참고하세요.

추가 기능을 개발할 때 필요한 Connector 참고 파일과 이관 순서는
[docs/CONNECTOR_FEATURE_MAP.md](docs/CONNECTOR_FEATURE_MAP.md)에 정리되어 있습니다.

## 데이터와 보안

- 일반 설정: 플랫폼별 사용자 config 디렉터리의 `xgen-dex-cli/config.json`
- 테스트/격리 override: `DEX_CLI_HOME`
- 토큰: `keytar`를 통한 Keychain, Credential Manager 또는 Secret Service
- 설정 파일 권한: `0600`
- profile의 서버 origin이 바뀌면 이전 origin의 저장 토큰은 삭제
- 비밀번호와 토큰은 stdout이나 config 파일에 기록하지 않음
- 로컬 도구는 기본 OFF이며 허용 경로·명령 차단·timeout을 config에 저장

Linux에서는 Secret Service와 실행 중인 keyring이 필요합니다. 사용할 수 없으면 CLI는 평문
파일로 조용히 fallback하지 않고 `credential_store_unavailable` 오류를 반환합니다.

## 소스 경계

`src/xgen/`은 CLI가 사용하는 최소 XGEN transport만 포함합니다. 로그인과 토큰 회전, Agent 목록,
SSE 채팅, 대화 기록 API가 여기에 있으며 Electron 앱이나 인접 저장소를 참조하지 않습니다.
따라서 `dex-cli` 디렉터리만 복제해 `npm install`, `npm run verify`를 실행할 수 있습니다. VS Code
확장까지 빌드할 때는 이어서 `npm run vscode:install`, `npm run vscode:verify`를 실행합니다.
# dex-cli
