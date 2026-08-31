# XGen Dex

A desktop **connector** for [XGEN](https://github.com/PlateerLab) — set your XGEN
server URL, log in, browse **your agents** (the "Agent 목록"), and **chat** with
any of them with live streaming. Built as an Electron app with a small,
framework-agnostic transport core.

It is **node-agnostic**: it works with every XGEN agent node type —
`agent_geny`, `agent_xgen`, `agent_harness` — because it drives the single XGEN
agent execution stream. Avatar/overlay support is intentionally left as an
**extension point** for a future release (see `AvatarSlot`).

> XGEN itself is a private product; this connector is the public client that
> talks to a deployed XGEN instance over its HTTP gateway.

## Download

Grab an installer from the [**Releases**](https://github.com/PlateerLab/xgen-connector/releases/latest) page:

| OS      | File                                  | Install                                                                                                                                                                                       |
| ------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `XGen-Dex-Setup-*.exe`          | Run it → if SmartScreen appears, **More info → Run anyway** (unsigned).                                                                                                                       |
| macOS   | `XGen-Dex-*.dmg`                | Open, drag **XGen-Dex.app** to **Applications** → first launch **right-click → Open**. If it says _"damaged"_, run `xattr -dr com.apple.quarantine "/Applications/XGen-Dex.app"`. |
| Linux   | `XGen-Dex-*.AppImage` / `*.deb` | AppImage: `chmod +x` then run · deb: `sudo dpkg -i`.                                                                                                                                          |

The app auto-updates from these releases (toggle in Settings). On first launch,
enter your **XGEN server URL** and **account**, then pick an agent and chat.

## Features

- **Server URL setup** — point the connector at any XGEN gateway
  (`https://xgen.example.com`); pre-seed with the `XGEN_SERVER_URL` env var.
- **Login** — email + password (password is SHA-256-hashed client-side, as XGEN
  requires). The JWT is stored in the **OS keychain** (Keychain / Credential
  Manager / libsecret), never in a plaintext file. Sessions are restored and
  refreshed automatically across restarts.
- **Agent list** — your agents, paged/searchable, filter by 개인/공유, exactly
  like the XGEN grid.
- **Chat** — pick an agent and chat with live token streaming, tool-activity
  chips, and multi-turn continuity (one conversation id per session).
- **Teams (사람 사이의 대화)** — a third sidebar view next to Agent and 탐색기.
  Browse the rooms you belong to, open one as a tab, and talk to your teammates
  in real time (WebSocket): live messages, replies, edits, file attachments with
  inline image previews, typing indicators, presence, emoji reactions, unread
  badges, group rooms and 1:1 DMs. Rooms created here are people-only
  (`router_mode: chat`); agents stay silent until you add them.
- **Agent ↔ Teams bridge** — the two tabs stay separate (an agent session and a
  team room are different kinds of space), but the boundary is permeable:
  - **Teams → Agent**: whichever room you were last viewing rides along as a
    context chip above the composer, so "이거 요약해줘" already knows what "이거"
    is. Scope is adjustable, the chip can be switched off, and the first send
    per room+range asks for confirmation stating exactly how many messages go out.
  - **Agent → Teams**: any finished answer can be shared into a room, carrying a
    provenance header so the room can jump back to the source conversation.
  - **탐색기 → Teams**: agent output on the virtual drive can be attached to a
    room directly from the file tree.
- **Two-panel tabs** — drag chat, browser and avatar tabs between groups or onto
  a left/right/top/bottom edge. At most two groups stay live; the divider,
  direction, tab order and group focus are restored after restart.
- **Agent browser (opt-in)** — each workflow gets an isolated browser tab with
  multiple visible pages plus a private background page for untargeted agent
  calls. Account cookies persist in an account-hashed Electron partition, while
  page state remains workflow-scoped. The browser toolbar can attach one element
  or a dragged region to the matching agent chat as sanitized DOM context plus a
  cropped screenshot. Enable it in Settings → 로컬 도구.
- **Auto-update** — via GitHub Releases (`electron-updater`); toggle in settings.
- **Settings** — server URL, theme (system/light/dark), auto-update.
- **Floating avatar overlay** — a Geny-style transparent, always-on-top,
  click-through window that floats an **avatar + a visual-novel speech bubble**
  of what the agent is saying over your desktop. **Locked** by default
  (click-through; only a small lock chip is interactive); **unlock** to reveal a
  dashed resize frame (8 handles + "크기 조절") and a bar with just lock + delete.
  Dragging is DPI-safe (`setPosition`, so it never grows on 150%-scaled displays).
  The speech bubble **types out at a fixed, user-set pace** (Settings → 자막 출력
  속도) so even a fast burst of many tokens stays readable. Toggle from the
  sidebar (bot icon) or Settings. TTS / STT / screen-capture are intentionally
  excluded.
- **Quick chat** — a Spotlight-style floating input bar summoned by a global
  hotkey (`Ctrl/Cmd+Shift+Enter`, **rebindable** via the recorder in Settings);
  type + Enter relays the message into the active agent's chat.
- **Local MCP** — host MCP servers on your machine (stdio or Streamable HTTP) and
  the connector bridges their tools to your XGEN agents: the backend auto-injects
  them into the selected session's agent (agent_xgen / agent_harness / agent_geny),
  no agentflow edit needed. Configure servers in Settings → 로컬 MCP. The bridge
  runs in the main process over `/api/tools/ws/connector-mcp/{user_id}` (requires
  the matching xgen-workflow backend).
- **System tray** — the app lives in the tray: closing the window hides it (the
  floating avatar + quick-chat hotkey keep running). Tray menu: open chat / quick
  chat / settings / show-hide avatar / auto-update / **launch-on-login** / reset
  window positions / restart / quit. Single-instance (a second launch focuses the
  running app). The avatar bar can open the chat + settings windows.
- **Avatar extension point** — `setAvatarRenderer()` mounts a future avatar into
  the overlay, bound to the active agent + its streamed text. Until then a branded
  placeholder avatar shows.

## Architecture

```
src/
  core/        # framework-agnostic transport (no Electron/React) — unit-tested
    client.ts    HttpClient: base URL + Bearer + JSON/stream helpers
    auth.ts      login / validate-token / refresh / logout
    agents.ts    GET /api/agentflow/list/detail (paged)
    chat.ts      POST /api/agentflow/execute/based-id/stream → normalized events
    sse.ts       incremental SSE frame parser
    history.ts   io-logs + interaction list
    teams.ts     /api/teams/* — rooms, messages, members, attachments
    teams-bridge.ts  Agent↔Teams 다리 — 컨텍스트 봉투 + 공유 출처 표식 (순수)
    index.ts     XgenClient facade
  main/        # Electron main: window, connector.json config, keychain, updater, IPC
               # browser runtime, one-page CDP proxies, agent-browser command queues
               # teams-ws.ts: Teams realtime sockets (headers → gateway auth)
               # teams-files.ts: 첨부의 디스크 쪽 (경로는 렌더러로 새지 않는다)
  preload/     # contextBridge → window.xgen (the only renderer↔native surface)
  renderer/    # React UI: ServerSetup → Login → Workspace(agent list + Chat)
```

The transport core lives in the **main process** (Node fetch), so tokens and
network calls never touch the renderer. The renderer reaches XGEN only through
the typed `window.xgen` bridge.

## XGEN API used

| Purpose           | Endpoint                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Login             | `POST /api/auth/login` `{email, password: sha256(pw), token:null}`                                              |
| Session/identity  | `POST /api/auth/validate-token`, `POST /api/auth/refresh`                                                       |
| Agent list        | `GET /api/agentflow/list/detail?page&page_size&search&owner`                                                    |
| Chat (SSE)        | `POST /api/agentflow/execute/based-id/stream` → `text/event-stream`                                             |
| History           | `GET /api/chat/io-logs`, `GET /api/interaction/list`                                                            |
| Teams rooms       | `GET /api/teams/rooms/list`, `POST /api/teams/rooms/create`, `POST /api/teams/rooms/dm/lookup-or-create`        |
| Teams messages    | `GET                                                                                                            | POST /api/teams/rooms/{id}/messages`, `PATCH …/{msgId}`, `POST …/{msgId}/reactions` |
| Teams members     | `GET                                                                                                            | POST /api/teams/rooms/{id}/members`, `GET /api/teams/users/search`                  |
| Teams realtime    | `WS /api/teams/ws/{roomId}` (room), `WS /api/teams/ws/user` (notifications)                                     |
| Teams attachments | `POST /api/teams/rooms/{id}/attachments/upload` (multipart `file`), `GET …/attachments/{storage_key}?filename=` |

All authenticated calls send `Authorization: Bearer <access_token>` (including
the SSE stream). Continue a conversation by reusing the same `interaction_id`.

The Teams WebSockets carry the same `Authorization` header on the handshake —
the gateway turns it into the `X-User-Id` header the workflow service expects.
Browsers cannot set handshake headers (the web app uses cookies instead), so
these sockets live in the **main process** (`src/main/teams-ws.ts`) and the
renderer receives normalized events over IPC.

Two connector-only envelopes ride inside the chat `input` and are stripped
before anything is shown to a user: `<xgen_browser_context>` (open pages) and
`<xgen_teams_context>` (the attached room's recent messages). They nest — teams
inside, browser outside — and `session-store.ts` peels them in that order. The
Teams envelope is capped and drops the oldest messages first, recording
`truncated` so the model knows the head is missing.

Sharing in the other direction writes a provenance header as the first line of
the Teams message (`🤖 <agent> · XGEN 에이전트 답변 공유 ⟨xgen:…⟩`). The connector
hides that line and renders a card with 원본 대화 보기; clients that don't know the
tag (the web Teams UI) still read it as a plain attribution sentence. There is no
metadata column on Teams messages, which is why the marker lives in the body.

The chat SSE stream is normalized into a single `ChatEvent` union:
`text` · `tool` · `node_status` · `execution_io` · `summary` · `error` · `end`
(plus `log` / `ui_command` / `download` / `quota`).

## Develop

```bash
npm install
npm test          # transport unit + e2e (mock XGEN) — no live server needed
npm run typecheck # main/preload/core
npm run build     # electron-vite bundle
npm run dev       # run the app (needs a display)
```

## Package

Build installers locally (only your own OS can be fully built locally):

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # nsis
npm run dist:mac     # dmg (macOS ad-hoc signed via build/afterPack.cjs)
```

### Cutting a release

Bump `version` in `package.json`, then push a matching `v*` tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The [`Release Installers`](.github/workflows/release.yml) workflow builds
macOS/Windows/Linux on GitHub runners, then publishes every installer plus the
`latest*.yml` update feeds to a **GitHub Release**. Those releases feed the
in-app auto-updater (`electron-updater`). macOS is ad-hoc signed and Windows is
unsigned (Developer ID + notarization land later).

## Using the transport core directly

The `core` package is a usable XGEN client on its own (Node ≥18 or a browser):

```ts
import { XgenClient } from 'xgen-connector/core';

const xgen = new XgenClient({ baseUrl: 'https://xgen.example.com' });
await xgen.login('me@corp.com', 'password');
const { items } = await xgen.agents.list();
for await (const ev of xgen.chat.stream({
  workflowId: items[0].workflowId,
  workflowName: items[0].workflowName,
  input: '안녕하세요',
  interactionId: 'conv-1',
})) {
  if (ev.kind === 'text') process.stdout.write(ev.content);
}
```

## Design

The UI follows the **XGEN design system** — the brand gradient (`#305eeb → #783ced`),
Pretendard typography, gray scale, chat bubbles and citation pills are copied 1:1
from `xgen-frontend` (`packages/ui/src/styles/globals.css`). The XGEN logo is the
official mark from `@xgen/icons`, re-authored as clean React SVGs in
[`src/renderer/src/brand/Logo.tsx`](src/renderer/src/brand/Logo.tsx). Light and dark
themes are both supported (Settings → 테마).

## License

Apache-2.0

Bundled font **Pretendard** (`src/renderer/src/assets/fonts/PretendardVariable.woff2`)
is © Kil Hyung-jin, licensed under the SIL Open Font License 1.1.

The pinned `agent-browser` 0.27.3 native helper is bundled under its Apache-2.0
license. Packaging retains only the binaries required by the target OS/arch
(Linux retains glibc and musl variants).
