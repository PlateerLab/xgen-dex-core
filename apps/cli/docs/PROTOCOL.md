# Dex CLI stdio protocol v1

`dex serve --stdio`는 장기 실행 엔진 프로세스를 시작합니다. 전송은 UTF-8 NDJSON이고 각 줄은
완전한 JSON-RPC 2.0 객체입니다.

## 전송 규칙

- stdin: client request와 notification
- stdout: server response와 notification
- stderr: 사람이 읽는 로그와 진단
- 한 줄에 정확히 하나의 JSON 객체
- 첫 request는 반드시 `initialize`
- protocol version은 현재 `1`
- request ID는 string, number 또는 null
- 비밀번호를 포함한 request 전체를 로그에 남기지 않음

## 초기화

Request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"xgen-vscode","version":"0.1.0"}}}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "server": { "name": "dex-cli", "version": "0.1.0" },
    "capabilities": {
      "profiles": true,
      "authentication": ["password"],
      "agents": true,
      "chatStreaming": true,
      "chatCancellation": true,
      "history": true,
      "localTools": true
    }
  }
}
```

초기화 전에 다른 method를 부르면 `-32002` 오류가 반환됩니다.

## Methods

### Process

- `initialize({protocolVersion})`
- `health()`
- `shutdown()`
- `exit` notification

### Profiles

- `profile/list()`
- `profile/set({name, serverUrl})`
- `profile/use({name})`

### Authentication

- `auth/login({profile?, email, password})`
- `auth/status({profile?})`
- `auth/logout({profile?})`

`password`는 stdio frame 안에만 존재하고 저장되지 않습니다. 로그인 결과의 token은 응답에
포함하지 않고 엔진이 OS keychain에 저장합니다.

### Agents

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "agents/list",
  "params": {
    "profile": "corp",
    "page": 1,
    "pageSize": 24,
    "search": "sales",
    "owner": "personal",
    "includeHarness": true
  }
}
```

### Local tools

- `localTools/status()`
- `localTools/list()`
- `localTools/configure({profile?, enabled?, cwd?, timeoutMs?, allowedRoots?, blockedCommands?, allowDangerous?})`
- `localTools/run({tool, args})`
- `localTools/start({profile?, waitMs?})`
- `localTools/stop()`

Bridge 연결 상태가 바뀌면 다음 notification을 전송합니다.

```json
{"jsonrpc":"2.0","method":"localTools/status","params":{"running":true,"connected":true,"catalogSynced":true,"advertisedTools":6,"serverTools":6}}
```

`localTools/configure`의 기본값은 `enabled:false`, `allowDangerous:false`입니다. 활성화된 stdio 엔진은
`/api/tools/ws/connector-mcp/{userId}`에 인증 WebSocket을 연결하고 `local` 서버의 도구를 광고합니다.

### History

- `history/conversations({profile?})`
- `history/turns({profile?, workflowId, workflowName?, interactionId})`

### Chat

Start request:

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "chat/start",
  "params": {
    "profile": "corp",
    "workflowId": "wf_abc",
    "workflowName": "Sales Agent",
    "interactionId": "optional-conversation-id",
    "input": "hello"
  }
}
```

Start response:

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": {
    "streamId": "b4df...",
    "interactionId": "6fb9...",
    "workflowId": "wf_abc",
    "workflowName": "Sales Agent"
  }
}
```

Stream notification:

```json
{"jsonrpc":"2.0","method":"chat/event","params":{"streamId":"b4df...","event":{"kind":"text","content":"안녕"}}}
```

Terminal notifications:

```json
{"jsonrpc":"2.0","method":"chat/complete","params":{"streamId":"b4df...","interactionId":"6fb9..."}}
{"jsonrpc":"2.0","method":"chat/error","params":{"streamId":"b4df...","error":{"code":"network_error","message":"..."}}}
```

Cancel request:

```json
{"jsonrpc":"2.0","id":21,"method":"chat/cancel","params":{"streamId":"b4df..."}}
```

## Errors

표준 JSON-RPC 오류:

- `-32700`: parse error
- `-32600`: invalid request
- `-32601`: method not found
- `-32602`: invalid params
- `-32002`: initialize required
- `-32000`: engine error

Engine error의 안정적인 문자열 code는 `error.data.code`에 들어갑니다.

- `auth_required`
- `auth_invalid`
- `config_invalid`
- `credential_store_unavailable`
- `network_error`
- `not_found`
- `protocol_mismatch`
- `usage_error`
