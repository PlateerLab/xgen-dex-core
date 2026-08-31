# XGEN Connector 기능 이관 가이드

이 문서는 `dex-cli`에 기능을 추가할 때 `xgen-connector`의 어떤 파일을 참고해야 하는지 판단하기
위한 개발 가이드다. 목표는 Connector 소스를 런타임 의존성으로 다시 연결하는 것이 아니라, 필요한
API 계약과 로직만 `dex-cli` 안으로 이관하는 것이다.

기준 디렉터리 구조는 다음과 같다.

```text
xgen-cli/
├── dex-cli/
└── xgen-connector/
```

문서에 표시된 Connector 경로는 모두 `dex-cli` 기준 `../xgen-connector/` 아래의 읽기 전용 참고
경로다. 기존 Electron 앱 파일은 수정하지 않는다.

## 이관 원칙

1. `xgen-connector/src/core/index.ts` 전체를 가져오지 않는다.
2. 기능이 사용하는 endpoint, 응답 매핑, 타입만 `dex-cli/src/xgen/`에 옮긴다.
3. `xgen-connector`를 가리키는 상대 import를 만들지 않는다.
4. Electron API가 필요한 부분은 VS Code API 또는 Node.js 구현으로 교체한다.
5. transport, engine, RPC, UI를 서로 분리한다.
6. 이관한 기능에는 mock server 기반 통합 테스트를 추가한다.

기능 구현의 기본 흐름은 다음과 같다.

```text
src/xgen/<feature>.ts        XGEN HTTP/SSE/WebSocket 계약
          ↓
src/engine.ts                인증 재시도와 CLI 업무 로직
          ↓
src/rpc-server.ts            VS Code용 JSON-RPC
          ↓
src/cli.ts / src/tui/        CLI와 TUI
          ↓
vscode-extension/            VS Code 화면
```

## 현재 CLI에 이관된 기반 코드

| 기능 | CLI 파일 | 원래 참고한 Connector 파일 |
|---|---|---|
| 공통 HTTP와 `ApiError` | `src/xgen/client.ts` | `src/core/client.ts` |
| 로그인·검증·토큰 회전 | `src/xgen/auth.ts` | `src/core/auth.ts`, `src/core/hash.ts` |
| Agent 목록 | `src/xgen/agents.ts` | `src/core/agents.ts` |
| SSE 채팅 | `src/xgen/chat.ts`, `src/xgen/sse.ts` | `src/core/chat.ts`, `src/core/sse.ts` |
| 대화 목록·turn | `src/xgen/history.ts` | `src/core/history.ts`, `src/core/browser.ts`의 context 제거 로직 |
| 공통 타입 | `src/xgen/types.ts` | `src/core/types.ts` 중 사용 타입만 |
| 조립과 세션 상태 | `src/xgen/index.ts` | `src/core/index.ts`의 `XgenClient` 중 사용 기능만 |

현재 `HttpClient`가 제공하는 메서드는 `get`, `post`, `json`, `stream`이다. 새 기능이 필요로 할 때만
아래 메서드를 Connector의 `src/core/client.ts`에서 이관한다.

| 필요한 작업 | 추가할 메서드 |
|---|---|
| 설정 수정 | `put`, `patch` |
| 리소스 삭제 | `del` 또는 `json('DELETE', ...)` |
| multipart 업로드 | `upload` |
| 파일 다운로드 | `getBinary` |
| 음성 등 binary POST | `postBinary` |

## 서버 API 기능별 파일 지도

### 인증 확장

SSO 로그인이나 서버 세션 정책을 추가할 때 참고한다.

- `xgen-connector/src/core/auth.ts`
  - `loginWithToken`
  - `sessionConfig`
- `xgen-connector/src/core/types.ts`
  - `LoginResult`, `CurrentUser`
- SSO 브라우저 창이 필요하면 `xgen-connector/src/main/sso-window-options.ts`는 동작 참고용으로만
  사용한다. VS Code에서는 `vscode.env.openExternal`과 callback 처리로 다시 구현한다.

현재 비밀번호 로그인, validate, refresh, logout은 이미 이관되어 있다.

### Agent 상세·실행 데이터

Agent 상세 화면, trace, memory, task, job run, forged tool, server workspace를 추가할 때 사용한다.

- 핵심 파일: `xgen-connector/src/core/agent-data.ts`
- 공통 의존: `src/core/client.ts`
- 포함 기능:
  - `basicInfo`
  - `traceList`, `traceDetail`
  - `memoryList`, `memoryRead`
  - `tasksList`, `taskRuns`, `taskOutput`, `endSession`
  - `toolsList`, `toolGet`
  - `workspaceTree`, `workspaceFile`, `workspaceBinary`, `workspaceUpload`

읽기 전용 상세 기능은 대체로 `HttpClient.get/post`만 필요하다. Workspace binary 다운로드에는
`getBinary`, 업로드에는 `upload`가 추가로 필요하다. `agent-data.ts`의 모든 타입을 한 번에 옮기지
말고 화면에서 사용하는 타입만 `src/xgen/agent-data.ts`에 함께 둔다.

### 채팅 첨부 파일

- 채팅 요청 계약: `xgen-connector/src/core/chat.ts`
- 첨부 타입: `xgen-connector/src/core/types.ts`의 `HistoryAttachment`, `ChatRequest.selectedFiles`
- 업로드·다운로드: `xgen-connector/src/core/agent-data.ts`
- 추가 transport: `HttpClient.upload`, 필요 시 `getBinary`

VS Code 파일 선택은 Connector renderer를 옮기지 않고 `vscode.window.showOpenDialog`로 구현한다.
업로드 결과를 `selectedFiles` 형식으로 변환한 뒤 기존 `chat/start` RPC에 전달한다.

### 사용자 환경설정과 Avatar

- 사용자 설정: `xgen-connector/src/core/preferences.ts`
- Avatar asset·스토어: `xgen-connector/src/core/avatars.ts`
- Avatar 타입: 위 두 파일의 `AvatarConfig`, `AvatarDescriptor`, `StoreAvatar`
- 추가 transport: `put`, `upload`, `DELETE`

Avatar 렌더링 엔진 자체는 transport가 아니다. Live2D/Spine을 VS Code에서 보여주려면 Webview용
renderer와 CSP/resource 처리 설계가 별도로 필요하다.

### 음성 STT/TTS

- API: `xgen-connector/src/core/voice.ts`
- 타입: `xgen-connector/src/core/types.ts`의 `SttPref`, `TtsPref`, `VoiceConfig`, `TtsSpeakOptions`
- 추가 transport: `upload`, `postBinary`

`voice.ts`는 서버 통신만 담당한다. 실제 마이크 입력, 권한 요청, 음성 재생은 Connector 코드를
복사하지 않고 VS Code Webview의 MediaDevices/Audio API 또는 별도 Node helper로 구현한다.

### SSH 설정

- API와 타입: `xgen-connector/src/core/ssh.ts`
- 추가 transport: `put`, `del`
- 주요 기능: 설정 조회, 활성화, 서버 생성·수정·삭제, 연결 테스트

SSH 비밀번호와 key 같은 secret을 VS Code state나 Webview에 저장하지 않는다. 서버 API 또는 CLI
credential store가 소유하도록 한다.

### XGEN Teams

- 방·메시지·멤버·검색·리액션 HTTP API: `xgen-connector/src/core/teams.ts`
- Agent context와 공유 메시지 포맷: `xgen-connector/src/core/teams-bridge.ts`
- Teams 타입: `xgen-connector/src/core/types.ts`의 `Teams*`
- 실시간 사용자·방 WebSocket: `xgen-connector/src/main/teams-ws.ts`
- 첨부 파일 로컬 처리 참고: `xgen-connector/src/main/teams-files.ts`
- 추가 transport: `put`, `patch`, `del`, `upload`, `getBinary`

`teams.ts`만 이관하면 목록과 메시지 CRUD까지만 가능하다. 실시간 메시지와 알림까지 구현하려면
`teams-ws.ts`의 인증 header, heartbeat, reconnect, room socket lifecycle을 Node `ws` 기반으로 별도
이관해야 한다. Electron IPC 코드는 가져오지 않고 RPC notification으로 VS Code에 전달한다.

## 로컬·플랫폼 기능별 파일 지도

이 섹션의 파일들은 대부분 `src/core`가 아니라 Electron main process 코드다. 그대로 복사하지 않고
기능 계약과 안전장치만 참고한다.

### 로컬 도구 확장

현재 CLI에는 `Shell`, `ReadFile`, `WriteFile`, `ListDir`, `Search`, `Open`이 자체 구현되어 있다.

- Connector 전체 참고: `xgen-connector/src/main/local-tools.ts`
- 도구 bridge 참고: `xgen-connector/src/main/mcp-bridge.ts`
- CLI 현재 구현:
  - `src/local-tools.ts`
  - `src/local-tool-bridge.ts`

추가 도구별 참고 위치:

| 추가 도구 | Connector 참고 | CLI 대체 구현 |
|---|---|---|
| `ShellJob` | `local-tools.ts`의 background job·`ShellJob` | Node child process registry와 process-tree 종료 |
| `Clipboard` | `local-tools.ts`의 clipboard schema·handler | OS별 명령 또는 검증된 clipboard package |
| `Notify` | `local-tools.ts`, `notification-center.ts` | VS Code `showInformationMessage` 또는 OS notifier |
| Browser tools | `browser-tools.ts` | 별도 browser runtime이 먼저 필요 |
| Workspace bridge tools | `workspace-bridge-tools.ts` | local workspace sync가 먼저 필요 |

Electron의 `clipboard`, `Notification` import는 CLI에 가져오지 않는다.

### 외부 MCP 서버

로컬 stdio/HTTP/SSE MCP 서버를 CLI가 직접 연결하고 그 도구를 XGEN에 노출할 때 필요하다.

- MCP client lifecycle: `xgen-connector/src/main/mcp-manager.ts`
- XGEN WebSocket catalog/call bridge: `xgen-connector/src/main/mcp-bridge.ts`
- OAuth: `xgen-connector/src/main/mcp-oauth.ts`
- secret 저장: `xgen-connector/src/main/mcp-secrets.ts`
- 실행 로그: `xgen-connector/src/main/mcp-runtime-log.ts`
- 관리 도구 schema와 delegate: `xgen-connector/src/main/local-tools.ts`의 `Mcp*Server`

CLI의 `LocalToolBridge`가 XGEN WebSocket 계약을 이미 구현하므로 `mcp-bridge.ts` 전체를 다시 옮기지
않는다. MCPManager의 catalog를 기존 bridge catalog와 합치는 방식으로 확장한다. OAuth token은
CLI credential store 또는 별도 keychain service에 저장한다.

### 내장 브라우저와 Browser tools

- 순수 타입·URL·context: `xgen-connector/src/core/browser.ts`
- runtime: `xgen-connector/src/main/browser-runtime.ts`
- 보안 정책: `xgen-connector/src/main/browser-security.ts`
- element/region 선택: `xgen-connector/src/main/browser-selection.ts`
- Agent 도구: `xgen-connector/src/main/browser-tools.ts`
- history: `xgen-connector/src/main/browser-history.ts`
- 자동 실행: `xgen-connector/src/main/agent-browser-runner.ts`
- CDP proxy: `xgen-connector/src/main/cdp-page-proxy.ts`

`core/browser.ts`만으로는 브라우저가 실행되지 않는다. Connector runtime은 Electron WebContents/CDP에
의존하므로 CLI에서는 Playwright/Chromium 같은 별도 엔진을 선택해야 한다. URL scheme 제한,
사용자 승인, 다운로드 경로 제한은 `browser-security.ts`를 참고해 동일한 수준으로 다시 구현한다.

### 알림

- 순수 설정·mute/privacy 정책: `xgen-connector/src/core/notifications.ts`
- Electron 표시와 클릭 routing: `xgen-connector/src/main/notification-center.ts`

정책 코드는 이관할 수 있지만 표시 코드는 Electron `Notification`을 사용한다. VS Code 확장에서는
`showInformationMessage/showWarningMessage`와 command callback으로 대체한다. CLI 단독 실행에서는
OS별 notifier adapter가 필요하다.

### 로컬 Workspace 동기화

서버 Agent workspace를 로컬 폴더와 양방향 동기화하는 기능이다. 관련 범위가 넓으므로 파일 하나만
이관해서는 동작하지 않는다.

- 동기화 계약: `xgen-connector/src/main/sync-protocol.ts`
- 변경 계획·충돌 판단: `xgen-connector/src/main/sync-plan.ts`
- 원격 transport와 WebSocket: `xgen-connector/src/main/sync-transport.ts`
- 한 sync pair 실행: `xgen-connector/src/main/local-sync.ts`
- 여러 Agent lifecycle: `xgen-connector/src/main/local-sync-manager.ts`
- 로컬 폴더 명명: `xgen-connector/src/main/local-sync-folder.ts`
- 서버 workspace API: `xgen-connector/src/main/workspace-api.ts`
- workspace 모델·관리: `workspace.ts`, `workspace-manager.ts`, `workspace-backend.ts`
- Agent 내부 도구: `xgen-connector/src/main/workspace-bridge-tools.ts`

CLI에 추가할 때는 먼저 단방향 pull/push와 dry-run 계획부터 분리해 구현한다. 파일 watcher,
충돌 정책, 심볼릭 링크, 허용 root, 삭제 전파, reconnect를 모두 테스트하기 전에는 자동 양방향
동기화를 활성화하지 않는다.

### 화면 캡처와 시스템 상태

- 화면 캡처: `xgen-connector/src/main/screen-capture.ts`
- 시스템 메트릭 계약: `xgen-connector/src/core/system-metrics.ts`
- Electron 프로세스 메트릭 구현: `xgen-connector/src/main/system-metrics.ts`

화면 캡처는 Electron API 대신 VS Code/OS 권한과 도구를 새로 선택해야 한다. 시스템 메트릭은 타입만
재사용하고 Node `os`, `process.resourceUsage`, child process 정보를 기반으로 CLI용 구현을 만든다.

## 가져오지 않아야 하는 파일

아래 파일은 조립 지점 또는 UI/platform glue이므로 기능 하나를 위해 통째로 복사하지 않는다.

- `xgen-connector/src/core/index.ts`: 모든 core 기능을 한꺼번에 import한다.
- `xgen-connector/src/core/types.ts`: Teams·Voice·Avatar 등 미사용 타입까지 포함한다.
- `xgen-connector/src/main/index.ts`: Electron lifecycle, IPC, tray, updater를 모두 조립한다.
- `xgen-connector/src/main/ipc.ts`: Electron renderer-main 계약이다.
- `xgen-connector/src/preload/*`: VS Code에서는 사용하지 않는다.
- `xgen-connector/src/renderer/*`: UI를 Webview 구조에 맞게 새로 만든다.
- `xgen-connector/src/main/keychain.ts`: CLI는 이미 `src/credential-store.ts`를 사용한다.

`core/index.ts`에서 class 하나를 가져와야 하는 경우에도 그 class가 import하는 하위 모듈만 직접
확인하고 최소 단위로 이관한다.

## 기능 이관 체크리스트

### 1. 범위 확인

- 사용자 화면에서 필요한 동작을 먼저 목록화한다.
- 읽기만 필요한지, 수정·업로드·실시간 연결까지 필요한지 구분한다.
- Connector에서 endpoint와 wire type을 확인한다.

### 2. transport 이관

- `src/xgen/<feature>.ts`를 만든다.
- 필요한 타입만 같은 파일 또는 `src/xgen/types.ts`에 추가한다.
- 필요한 `HttpClient` 메서드만 확장한다.
- `src/xgen/index.ts`의 `XgenClient`에 feature API를 등록한다.

### 3. engine과 RPC

- `DexEngine`에 인증 재시도를 포함한 메서드를 추가한다.
- `rpc-server.ts`에 request method를 추가한다.
- 장기 실행·실시간 기능은 notification과 명시적 start/stop lifecycle을 제공한다.
- 비밀번호, token, API key, 파일 내용이 로그로 출력되지 않게 한다.

### 4. UI

- CLI 명령과 `--json` 출력을 먼저 만든다.
- TUI와 VS Code는 동일한 engine/RPC를 사용한다.
- Electron IPC 또는 renderer component를 복사하지 않는다.

### 5. 검증

- mock XGEN server로 endpoint, 인증 header, snake_case 매핑을 테스트한다.
- 401/403 token refresh 재시도를 테스트한다.
- WebSocket 기능은 reconnect, heartbeat, 중복 연결, shutdown을 테스트한다.
- upload/download 기능은 크기 제한과 허용 경로를 테스트한다.
- `rg 'xgen-connector|\.\./\.\./xgen-connector' src test` 결과가 비어 있어야 한다.
- esbuild metafile의 모든 로컬 input이 `dex-cli` 안에 있는지 확인한다.
- `npm run verify:all`과 `npm pack --dry-run`을 통과시킨다.

## 장기 공유가 필요한 경우

같은 API를 Electron 앱과 CLI 양쪽에서 반복적으로 수정하게 되면 복사 이관 대신 독립
`@xgen/core` 패키지를 만드는 것이 적합하다. 그때도 package에는 HTTP/SSE 타입과 매핑만 넣고,
Electron·VS Code·Node별 UI와 OS 기능은 각 host에 남겨야 한다.
