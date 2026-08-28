# Dex CLI

XGEN Dex의 headless CLI이자 VS Code 확장이 사용할 로컬 엔진입니다. 기존
`xgen-connector/src/core` transport를 재사용하며 Electron이나 React 없이 실행됩니다.

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

## 로컬 도구

로컬 도구는 기본적으로 꺼져 있습니다. 작업 폴더와 허용 경로를 명시해 켜면 `dex chat`, TUI,
`dex serve --stdio`가 로그인 사용자의 XGEN 도구 bridge에 카탈로그를 광고합니다.

```bash
dex tools enable --cwd . --allow . --block sudo
dex tools list
dex tools status
```

지원 도구는 `Shell`, `ReadFile`, `WriteFile`, `ListDir`, `Search`, `Open`입니다. 로컬 실행만 먼저
검증하려면 다음과 같이 호출할 수 있습니다.

```bash
dex tools run ListDir --args '{"path":"."}'
dex tools run Shell --args '{"command":"npm test","timeoutMs":120000}'
```

CLI 채팅이나 VS Code 엔진이 실행 중이면 bridge도 함께 유지됩니다. 다른 XGEN 클라이언트에서
Agent를 사용하면서 로컬 도구 host만 계속 실행하려면 아래 명령을 사용합니다.

```bash
dex tools serve --profile corp
```

구조화된 파일 도구와 `Open`의 파일 경로는 `--allow` 범위로 제한됩니다. `Shell`은 로그인한 OS
사용자 권한으로 실행되므로 opt-in 기능이며, `--block`의 명령과 파괴적 명령 패턴은 거부됩니다.
파괴적 명령이 꼭 필요할 때만 `dex tools configure --allow-dangerous`를 명시적으로 실행하세요.

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

## 현재 소스 경계

첫 수직 기능을 빠르게 검증하기 위해 빌드 시 인접한
`../xgen-connector/src/core/index.ts`를 번들합니다. 다음 리팩터링에서는 이 디렉터리를
독립 `@xgen/core` workspace package로 이동하고 Electron connector와 CLI가 동일한 package
dependency를 사용하게 할 예정입니다.
# dex-cli
