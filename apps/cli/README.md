# Dex CLI

## CLI 기기 등록

HTTPS 서버 프로필을 설정한 뒤 `dex device register --email <email>`로 등록하고, `dex device approvers --email <email>`로 승인 가능한 브라우저를 조회한다. `dex device request-approval --email <email> --approver <browser-device-id>`의 비교 코드를 선택한 브라우저의 내 페이지에서 대조해 승인한다. `dex device status --email <email>`로 결과를 확인한다. 각 명령은 비밀번호를 숨겨 입력하며 자동화에서는 `--password-stdin`을 쓴다.

기기 키는 OS 키체인으로 보호하는 소프트웨어 키이며 키체인 장애 시 등록을 차단한다. 파일 저장이나 하드웨어 키 고정을 제공하지 않는다. 이 명령은 기기 등록·승인만 처리하며 기존 `dex login`·채팅과 native ACTIVE 세션 연결은 별도 단계다. 저장·복구 경계와 실제 Compose 검증 방법은 저장소의 `docs/cross-platform-session-integration.md`를 참고한다.

## CLI Platform Session

승인된 기기와 ACTIVE 발급을 지원하는 HTTPS 서버에서 `dex session login --email <email>`을 사용한다. 로그인 결과의 계정 ID로 `dex session status|refresh|focus --user-id <id>`를 실행한다. `status`는 로컬 보관 상태이며 `focus`는 기기 DPoP로 Canonical 포커스를 한 번 읽는다. 세션 토큰은 OS 키체인에만 보관하고 회전·통신 실패를 자동 재시도하지 않는다.

`dex session logout --user-id <id>`는 현재 비밀번호와 기기 DPoP로 서버 세션을 폐기한 뒤 로컬 자격증명을 지운다. 중단된 작업은 내 페이지에서 서버 세션을 폐기한 뒤 `dex session forget-local --user-id <id>`로 정리한다. `forget-local` 자체는 서버 세션을 폐기하지 않는다. 현재 Compose는 enrollment 모드이므로 세션 로그인은 503으로 닫혀 있으며, 기존 `dex login`·TUI·채팅은 유지한다.

### 현재 대화 구독

```sh
dex session watch-focus --user-id <id> --profile corp --jsonl
# 기본 2초, 선택 가능한 폴링 간격 200~60000ms
dex session watch-focus --user-id <id> --profile corp --interval-ms 1000
```

snapshot 이후 계정 이벤트 cursor로 현재 대화 변경을 따라간다. 연결 단절·408·429·5xx에는 1~30초 backoff로 읽기만 재시도하며 이벤트 누락·409에는 snapshot으로 복구한다. 인증 만료·폐기·키체인 장애는 구독을 중단한다. access를 자동 갱신하지 않으므로 필요하면 다른 터미널에서 `dex session refresh`를 실행한 뒤 구독을 다시 시작한다. 같은 sid의 정상 갱신 중에는 cursor를 유지한다. 다른 프로세스의 키체인 작업과 겹치면 최대 3회 대기 후 중단하며 남은 잠금을 임의로 제거하지 않는다.

`--jsonl`은 줄마다 `reset`, `focus`, `reconnecting`, `stopped`를 출력한다. 소비자는 `reset`·`stopped`에서 이전 대화 표시를 비우고, 재연결 중에는 새 상태를 확정하지 않는다. 토큰·서명·키는 출력하지 않는다. Ctrl+C는 진행 중 요청과 대기를 취소하고 정상 종료한다. 실행 중 프로필 파일 변경을 자동으로 따르지 않으므로 계정·서버 변경 시 해당 옵션으로 다시 실행한다. 엔진 API의 `select(source, userId)`는 같은 계정 재선택을 포함해 즉시 reset을 내보내고 이전 응답을 폐기한다. 이 명령은 Canonical focus 조회용이며 기존 TUI 채팅이나 WebSocket을 전환하지 않는다.

### 공유 대화 조회·폴링·실시간 연결

```sh
dex session conversation --user-id <id> --profile corp --json
dex session watch-conversation --user-id <id> --profile corp --jsonl --interval-ms 2000
dex session watch-live --user-id <id> --profile corp --jsonl --interval-ms 2000
```

선택된 Canonical 대화의 snapshot·실행 이벤트·완결 메시지를 조회한다. 단발 조회는 최대 10단계, 각 단계는 이벤트 2×100개와 메시지 2×1개로 제한한다. 최대 100턴/본문 UTF8 4MiB를 메모리에 보관하고 생략·불완전 이력·`has_more`를 표시한다. 이벤트와 메시지는 별도 커서를 사용하며 마지막에 account focus를 다시 확인한다.

JSONL은 `reset`, `conversation`, `reconnecting`, `stopped`를 출력한다. `conversation`은 snapshot/messages/omittedMessages 표시 필드와 `has_more`만 제공하며 자격증명·내부 커서·raw 도구 결과를 포함하지 않는다. Ctrl+C로 중단한다. 인증 실패는 중단하고 읽기 전용 임시 오류만 재시도한다. 같은 sid의 갱신은 다음 단계에서 새 vault를 읽고 커서를 유지한다.

`watch-live`는 ready OS vault의 토큰과 GET DPoP로 receive-only WSS에 연결한다. 이벤트 알림은 HTTP 조회를 깨우며 표시 내용은 HTTP로 검증한다. 조용한 연결도 `--interval-ms` 간격으로 포커스·vault를 확인한다. 같은 sid의 토큰 갱신은 커서를 보존하고 소켓을 교체한다. cursor conflict는 snapshot으로 복구하고, 새 자격증명 발급 없이 기존 vault만 재확인한다. 진행 없는 인증·cursor 실패는 한 번 복구 후 중단하며 WSS 전송 실패는 세 번 재시도한다. 프로필·계정 변경은 명시적으로 중단 후 다시 실행한다.

The explicit `conversation`, `watch-conversation` and `watch-live` actions read bounded canonical snapshots, execution events and linked terminal messages. Live mode uses scoped GET DPoP over receive-only WSS to wake authoritative HTTP recovery, with periodic vault/focus checks. Same-session token rotation replaces the socket without resetting cursors. Display projections exclude credentials; authentication, integrity and repeated no-progress socket failures stop. Ctrl+C waits for actual socket teardown. These commands do not send chat messages; migration of existing chat sends remains subsequent work.

### Canonical 공유 대화 TUI

```sh
dex ui --canonical --user-id 7 --profile corp
```

대화형 TTY에서 승인된 CLI 기기의 HTTPS Platform Session으로 현재 공유 대화와 실행 상태를 표시한다. 첫 화면은 한 번 조회하며 R은 재조회, W는 실시간 WSS/HTTP 연결, S는 연결 중단, Q 또는 Ctrl+Q는 종료다. ↑↓·PgUp/PgDn·Home/End로 조회한 본문을 스크롤한다. 프로필·계정은 실행 시 고정되므로 바꾸려면 종료 후 다시 실행한다.

L은 소유 세션의 최신 목록, P는 이전 페이지다. 최대 100개씩 페이지를 교체하며 ↑↓/Enter로 활성 세션을 선택한다. 보관된 세션은 열 수 없다. 최신 목록 확인 후 N으로 workflow ID와 제목을 입력해 서버 ID의 새 세션을 만들고, X/Enter로 현재 선택을 해제한다. workflow ID는 실행 가능한 기존 workflow의 ID를 입력한다. 생성·선택은 조회한 focus version으로 비교하며, 생성 응답 유실이나 충돌은 L로 최신 결과를 확인하기 전까지 쓰기를 잠근다. 생성 요청은 자동 반복하지 않는다.

I는 한 줄 메시지 입력, Enter는 송신, Esc는 입력 닫기다. 입력 모드의 R/W/S/Q/N/T는 글자로 입력되고 Ctrl+Q는 종료한다. 붙여넣은 개행은 공백으로 표시하며 그 보이는 입력을 전송한다. 메시지는 UTF-8 262144 bytes까지다. 송신 결과가 불명확하면 R로 같은 대화를 확인한 뒤 Y로 원래 본문·버전·중복 방지 키를 그대로 재확인한다. T는 검증된 현재 실행 ID와 버전으로 중단을 요청한다. 접수는 답변 완료를 뜻하지 않으며, 후속 조회에서 완료 본문을 확인한다. 불명확한 턴이 남아 있으면 생성·선택은 차단한다.

완료되고 검증된 메시지만 표시하며 생략·불완전 이력·부분 조회를 안내한다. 실행 중 본문은 완료 후 조회한다. 재연결·인증 실패·선택 변경·중단 시 오래된 대화를 지우며, 취소된 요청과 실제 vault/소켓 정리가 끝난 뒤 다음 작업을 시작한다. 서버 제목·본문의 터미널 제어 문자는 제거한다. 대화와 마지막 선택을 파일에 저장하지 않는다.

로그인 세션 또는 실제 대화가 바뀌면 이전 draft·재시도 요청·목록을 폐기한다. 같은 sid의 정상 token rotation은 허용하되 네이티브 vault 잠금 안에서 원래 로그인 범위를 다시 확인한 뒤 서명한다. 임시 읽기 실패에는 같은 로그인 범위의 draft와 불명확한 턴을 메모리에 보존하고, 검증된 재조회 전까지 쓰기를 막는다. 첨부와 로컬 도구 연결은 후속 작업이다.

HTTPS 프로필과 `dex session login`의 ACTIVE 세션이 먼저 필요하다. 인증을 자동 갱신하거나 재로그인하지 않으며 인증 실패 때 안전한 안내를 표시한다. 현재 enrollment Compose에서는 ACTIVE 발급이 503으로 차단되어 이 화면도 대화를 표시할 수 없다. CLI 명령 `session create-agent-session`, `switch-agent-focus`, `chat --canonical`은 별도로 사용할 수 있다.

`ui --canonical` uses the fixed CLI account, HTTPS origin, native Platform Session and OS vault. R reads, W starts receive-only WSS wakeups and authoritative HTTP recovery, S stops, and Q/Ctrl+Q exits. L loads the latest owned catalog; P replaces it with an older page of at most 100 items. Arrows/Enter select an active row. N creates a session from an existing workflow ID and title; X/Enter clears focus. Lifecycle mutations use the verified focus version, and unknown creation or conflicts require explicit latest catalog recovery with no automatic replay.

I opens a single-line editor. Enter submits the visible UTF-8 text (262144-byte limit), Esc closes it, and navigation letters are text while editing. Pasted newlines become spaces without submitting. An unknown turn requires an authoritative R read and explicit Y retry with the exact original message, session, version and idempotency key. T stops the verified current turn with its exact ID/version. Reservations and stop receipts are not completed answers; subsequent reads display verified terminal messages. Unknown turns block lifecycle changes. Binding/focus changes discard old drafts and private retry intent; temporary loss retains same-login intent in memory with writes disabled. Native writes recheck the original login binding under the vault lock before proof/wire and allow same-sid rotation. Controls are stripped, conversation state is not persisted, and actual request/vault/socket drain precedes transitions or exit. Authentication is never refreshed automatically. Attachments/local tools and actual ACTIVE Gateway success remain gates; enrollment mode currently returns 503 for ACTIVE issuance.

### 기존 Canonical 대화에 턴 제출

이미 Canonical 방식으로 생성된 대화에는 명시적으로 한 턴을 제출할 수 있다.

```sh
printf '%s' '계속 설명해줘' | dex chat --canonical \
  --user-id 7 \
  --session-id 018f1240-0000-7000-8000-000000000002 \
  --expected-state-version 3 \
  --idempotency-key terminal-request-1 \
  --stdin --json
```

메시지는 `--message`와 `--stdin` 중 하나로만 전달하며 UTF-8 262144바이트가 상한이다. `--idempotency-key`는 자동 생성하지 않는다. 응답을 받지 못해 결과가 불명확하면 같은 메시지, session ID, expected state version, idempotency key를 명시해 다시 실행해야 한다. 다른 메시지에 같은 key를 재사용하면 서버가 거절한다. Ctrl+C와 SIGTERM은 현재 HTTP 요청만 취소하며 서버의 턴 중단 요청을 보내지 않는다.

명령의 성공은 서버가 턴을 한 번 접수했다는 응답이다. AI 답변 완료를 뜻하지 않는다. 결과는 `dex session watch-live --user-id <id>` 또는 `watch-conversation`/`conversation`으로 확인한다. 이 명령은 새 Canonical 대화나 workflow를 만들지 않으므로 기존 workflow와 서버 Agent Session ID가 필요하다. 세션 생성·선택은 위 TUI 또는 `session create-agent-session`/`switch-agent-focus`로 수행할 수 있다. 첨부 파일과 로컬 도구 연결은 지원하지 않는다. 기존 `dex chat --agent` 경로와 자격증명은 fallback으로 사용하지 않는다.

`chat --canonical` explicitly submits one turn to an existing server-issued Canonical session through the CLI's OS-vault Platform access and scoped POST DPoP. Supply the session ID, snapshot state version and stable idempotency key yourself. UTF-8 stdin, including trailing newlines, is preserved exactly; the limit is 262144 bytes. A successful response acknowledges reservation, not AI completion. Read the conversation separately. A lost response or cancellation after dispatch reports an unknown outcome and never retries automatically; explicitly repeat the same message, session, original version and key to reconcile. SIGINT does not request server-side turn cancellation. Create/select sessions through the TUI or the session lifecycle commands. Attachments and local tools remain pending.

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

## 로컬 도구

로컬 도구는 기본적으로 꺼져 있습니다. 작업 폴더와 허용 경로를 명시해 켜면 `dex chat`, TUI,
`dex serve --stdio`가 로그인 사용자의 XGEN 도구 bridge에 카탈로그를 광고합니다.

```bash
dex tools enable --cwd . --allow . --block sudo
dex tools list
dex tools status
```

기본 지원 도구는 `Shell`, `ShellJob`, `ReadFile`, `WriteFile`, `ListDir`, `Search`,
`Open`입니다. 기본 셸은 허용 작업 공간의 파일만 읽고 쓰며, 명령의 자식 프로세스에도
같은 범위를 적용합니다. 작업 폴더가 설정돼 있으면 허용 범위에 포함됩니다.
`LocalControl`은 현재 사용 가능한 PC 도구와 접근 범위를 조회합니다.

`dex tools configure --shell`은 **작업 공간 밖까지 셸 접근을 허용**합니다.
`--no-shell`은 기본 작업 공간 제한으로 돌아갑니다. 셸 자체를 끄는 옵션이 아닙니다.
파일 전용 도구는 전체 셸 접근과 무관하게 허용 폴더를 지킵니다.

작업 공간 제한 셸은 macOS 및 Linux(bubblewrap 설치 필요)에서 지원합니다.
Windows에서는 아직 지원하지 않으며, 제한 없는 실행으로 자동 전환하지 않습니다.
시스템 런타임은 읽기 전용으로 제공하고, 홈·임시 파일은 작업 공간 안의 명령별 임시
폴더를 사용합니다. 해당 폴더는 명령 종료 시 정리됩니다.

기본 작업 공간에서 실행을 검증하려면 다음과 같이 호출합니다.

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
사용자 권한 전체로 실행되는 별도 opt-in 기능이며, `--block`의 명령과 파괴적 명령 패턴은 거부됩니다.
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
