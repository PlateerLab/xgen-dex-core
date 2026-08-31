# XGen Dex — API protocol reference

The connector talks to a deployed XGEN instance through its **gateway**
(`http(s)://<gateway-host>:8000`). Everything is under `/api`. All
authenticated calls send `Authorization: Bearer <access_token>` (including the
SSE stream). The gateway validates the token and injects `X-User-*` identity
headers upstream.

## Login — `POST /api/auth/login`
Request:
```json
{ "email": "user@corp.com", "password": "<sha256_hex(plaintext)>", "token": null }
```
> The password MUST be the SHA-256 hex digest of the plaintext — the gateway
> compares it verbatim to the stored hash. Sending plaintext always fails.

Response `200`:
```json
{ "success": true, "access_token": "<JWT>", "refresh_token": "<JWT>",
  "token_type": "bearer", "user_id": "123", "username": "alice" }
```

## Identity / session
- `POST /api/auth/validate-token` `{ "token": "<access>", "refresh_token": "<opt>" }`
  → `{ valid, user_id, username, is_superuser, roles, permissions, new_access_token? }`.
  Listing agents needs the `main.agentflow:read` permission.
- `POST /api/auth/refresh` `{ "refresh_token": "<JWT>" }` → `{ access_token }`.
- `POST /api/auth/logout` `{ "token": "<access>" }`.

## Agent list — `GET /api/agentflow/list/detail`
Query: `page` (1), `page_size` (24), `search`, `status`, `owner` (`personal`|`shared`),
`include_harness`. Response:
```json
{ "items": [ { "id": 42, "workflow_id": "wf_abc", "workflow_name": "Sales Agent",
    "node_count": 7, "is_shared": false, "is_deployed": false, "is_completed": true,
    "workflow_type": "canvas", "description": "...", "username": "alice",
    "full_name": "Alice Kim", "created_at": "...", "updated_at": "..." } ],
  "pagination": { "page": 1, "page_size": 24, "total_count": 32, "total_pages": 2 } }
```
An agent is identified by `workflow_id` + `workflow_name`.

## Chat — `POST /api/agentflow/execute/based-id/stream`
Request:
```json
{ "workflow_name": "Sales Agent", "workflow_id": "wf_abc",
  "input_data": "안녕하세요", "interaction_id": "conv-1",
  "include_logs": true, "include_node_status": true, "include_tool_events": true,
  "response_format": "stream" }
```
Reuse the same `interaction_id` to continue a conversation.

Response: `Content-Type: text/event-stream`. Two frame shapes, separated by a
blank line:
- Named: `event: <name>\ndata: <json>\n\n` — `log`, `node_status`, `tool`,
  `a2ui_command`, `floui_command`, `download_artifact`, `execution_io`,
  `quota_warning`, `quota_exceeded`, `execution_suspended`.
- Default: `data: <json>\n\n` where json has a `type` — `data` (text chunk),
  `summary`, `end`, `error`. Some `tool_*` frames also arrive bare (no `event:`).

Terminal marker: `data: {"type":"end"}`. Stop reading there.

`tool` payload:
```json
{ "event_type": "tool_call|tool_start|tool_result|tool_error",
  "tool_name": "web_search", "tool_input": {...}, "result": "...",
  "citations": [ { "file_name": "a.pdf", "page_number": 3, "score": 0.82 } ],
  "run_id": "...", "duration_ms": 42 }
```

The connector flattens all of this into the `ChatEvent` union (see
`src/core/types.ts`). This one endpoint drives every agent node type
(agent_geny / agent_xgen / agent_harness).

## History
- `GET /api/chat/io-logs?workflow_id=&interaction_id=&workflow_name=` → ordered turns.
- `GET /api/interaction/list` → past conversations (`execution_meta_list`).

## Local execution (connector-side agent turns)

See `docs/LOCAL_EXECUTION.md`. Endpoints used in addition to the chat stream:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agentflow/geny-agent/local-runtime/manifest` | server runtime/CLI target versions |
| GET | `/api/agentflow/geny-agent/{workflowId}/local-turn-context` | agent config + account credentials + admin settings + `graph` (canvas suppliers) + extra `options` |
| POST | `/api/agentflow/geny-agent/{workflowId}/report-turn` | record a locally executed turn (text, tool events, usage, status) |
| POST | `/api/agentflow/geny-memory/{workflowId}/rpc` | memory RPC used by the sidecar (shared vault) |

Chat body extras: `client_surface: "connector"` (always), `execution_target: "sandbox"` (only when a turn could not run locally).

`local-turn-context` response extras:
```json
{ "agent": {...}, "context": {...}, "protocol": 2,
  "options": { "memory": [ { "role": "user", "content": "..." } ], "output_schema": {...} },
  "graph": { "suppliers": [ { "port": "tools", "node_id": "n1", "node_type": "tool/mcp" } ],
             "shipped": ["memory"], "unsupported": ["tools"], "local_supported": false } }
```
`graph.local_supported === false` → the connector falls back to the server (reason `graph_suppliers`).
`HTTP 429` with `{"detail":{"code":"quota_exceeded","message":"...","usage":...,"limit":...}}` → the turn is
**blocked** (status `{surface:"blocked", reason:"quota_exceeded", detail:message}` + `error` + `end`), no server fallback.

### Sidecar turn request / events (connector ↔ `xgen_agent_runtime.host.sidecar`, protocol 2)

Turn request `server` bridge carries the connector TLS policy:
```json
{ "op": "turn", "id": "...", "workspace_dir": "...", "provider": "codex", "text": "...",
  "context": { "api_keys": {...}, "settings": {...} },
  "server": { "url": "https://xgen.example", "token": "<jwt>", "tls": { "verify": false } },
  "options": { "...agent params + server options", "workflow_id": "wf", "interaction_id": "i", "streaming": true } }
```
`tls.verify` is `false` when the connector setting "사설 인증서 허용" (`allowPrivateCertificate`) is on; the sidecar reads
`server.tls.{verify, ca_file}`.

Events: `started` · `chunk` · `tool` · `canvas_command` · `meta` · **`usage`** · `done` · `error` · `cancelled`.
`usage` is a first-class event emitted once after the pipeline completes:
```json
{ "id": "...", "type": "usage",
  "data": { "input_tokens": 120, "output_tokens": 45, "cache_read_tokens": 30, "cache_creation_tokens": null,
            "total_cost_usd": 0.0012, "model": "gpt-5.3-codex", "provider": "codex" } }
```
The connector stores it as `TurnReport.usage` and sends it verbatim as `report-turn.usage` (the server records
`output_data.usage` and the input/output token columns). It is not rendered in the chat.

## Connector-hosted local MCP — caller context

The connector advertises local tools over
`/api/tools/ws/connector-mcp/{user_id}`. A browser tool must be able to create
its first page without putting internal workflow identifiers in every chat
message, so the backend includes the authenticated execution identity only in
the corresponding `mcp_call` frame:

```json
{
  "type": "mcp_call",
  "request_id": "call-1",
  "server": "local",
  "tool": "BrowserTabs",
  "args": { "action": "create", "mode": "shared", "url": "https://example.com" },
  "context": {
    "workflow_id": "wf_abc",
    "workflow_name": "Sales Agent",
    "interaction_id": "conv-1"
  }
}
```

`context.workflow_id` must come from the authenticated server-side execution,
not from model-generated tool arguments. The connector temporarily accepts an
argument-level `workflow_id` for compatibility with older servers, but rejects
it when it disagrees with the server context.
