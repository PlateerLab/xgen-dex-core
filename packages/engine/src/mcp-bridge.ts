/**
 * McpBridge — the connector side of the XGEN "connector-hosted Local MCP" bridge.
 *
 * Opens a WebSocket to the XGEN backend (through the gateway) at
 * `/api/tools/ws/connector-mcp/{user_id}`, advertises the aggregated local MCP
 * tool catalog via a `hello` frame, then answers `mcp_call` frames by invoking
 * the local MCP server through MCPManager and replying with `mcp_result`.
 *
 * The XGEN backend auto-injects these tools into the user's running agents
 * (agent_xgen / agent_harness / agent_geny), so any chat with the logged-in
 * user can call the connector-hosted tools.
 *
 * Lives in the MAIN process: tokens + subprocess spawning stay out of the
 * renderer. Uses `ws` (Node global WebSocket isn't stable on Electron's Node).
 *
 * Reconnect UX is DEBOUNCED so a flapping socket (e.g. the backend endpoint not
 * yet deployed, or an idle proxy timeout) doesn't make the status flicker
 * "연결 대기 중 ↔ 연결됨": a connection is reported "connected" only after it stays
 * open a beat (settle), and "disconnected" only after it stays closed a beat
 * (grace). Reconnect uses exponential backoff; status emits are de-duplicated.
 */
import WebSocket from 'ws';
import { getMcpManager, type McpServerAdvert } from './mcp-manager';
import {
  getLocalToolProvider,
  localToolCallContext,
  LOCAL_SERVER,
} from './local-tools';
import { appendMcpRuntimeLog } from './mcp-runtime-log';
import { xgenWebSocketTlsOptions } from './connection-security';

const HEARTBEAT_MS = 20000;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const SETTLE_MS = 1200; // stay open this long before we call it "connected"
const GRACE_MS = 4000; // stay closed this long before we call it "disconnected"

export interface McpBridgeStatus {
  enabled: boolean;
  connected: boolean;
  /** 최신 hello 카탈로그를 workflow가 catalog_id로 확인했는지 여부. */
  catalogSynced: boolean;
  /** workflow가 ACK한 최신 카탈로그의 도구 수. */
  serverToolCount: number;
  error?: string;
  servers: McpServerAdvert[];
}

export class McpBridge {
  private ws: WebSocket | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private backoff = RECONNECT_MIN_MS;
  private stopped = true;
  /** Debounced UI state — NOT the raw socket state, to avoid flicker. */
  private uiConnected = false;
  private catalogSynced = false;
  private serverToolCount = 0;
  private catalogSeq = 0;
  private pendingCatalogId = '';
  private serverUrl = '';
  private userId = '';
  private allowPrivateCertificate = false;
  private getToken: () => Promise<string | null> = async () => null;
  private refreshAuth: () => Promise<string | null> = async () => null;
  private lastServers: McpServerAdvert[] = [];
  private lastError: string | undefined;
  private lastEmit = '';
  private onStatus: (s: McpBridgeStatus) => void = () => {};

  setStatusListener(cb: (s: McpBridgeStatus) => void): void {
    this.onStatus = cb;
  }

  status(): McpBridgeStatus {
    // Include the connector-hosted built-ins as a synthetic `local` server so the
    // renderer's "exposed tools" view lists them alongside external MCP servers
    // (they ride the same agent catalog). Full schemas — the UI shows per-tool
    // description/inputSchema.
    const localTools = getLocalToolProvider().advertise();
    const localServer: McpServerAdvert[] = localTools.length
      ? [{ name: LOCAL_SERVER, connected: true, tools: localTools }]
      : [];
    return {
      enabled: !this.stopped,
      connected: this.uiConnected,
      catalogSynced: this.catalogSynced,
      serverToolCount: this.serverToolCount,
      error: this.lastError,
      servers: [...localServer, ...this.lastServers],
    };
  }

  /** Emit only when the status actually changed (dedupe). */
  private emit(): void {
    const s = this.status();
    const key = JSON.stringify({
      e: s.enabled,
      c: s.connected,
      sync: s.catalogSynced,
      tools: s.serverToolCount,
      err: s.error,
      n: s.servers.map((x) => [x.name, x.connected, x.tools.length]),
    });
    if (key === this.lastEmit) return;
    this.lastEmit = key;
    this.onStatus(s);
  }

  start(opts: {
    serverUrl: string;
    userId: string;
    allowPrivateCertificate: boolean;
    getToken: () => Promise<string | null>;
    /** 핸드셰이크 401/403 자가치유 — refresh 로 토큰 회전(single-flight). */
    refreshAuth?: () => Promise<string | null>;
  }): void {
    // A no-op restart (same target, already running) must NOT tear down a live
    // socket — that alone would cause a visible flap on every auth refresh.
    const sameTarget =
      this.serverUrl === opts.serverUrl &&
      this.userId === opts.userId &&
      this.allowPrivateCertificate === opts.allowPrivateCertificate;
    this.serverUrl = opts.serverUrl;
    this.userId = opts.userId;
    this.allowPrivateCertificate = opts.allowPrivateCertificate;
    this.getToken = opts.getToken;
    if (opts.refreshAuth) this.refreshAuth = opts.refreshAuth;
    if (!this.stopped && sameTarget && (this.ws || this.retry)) {
      void this.refreshCatalog();
      return;
    }
    this.stopped = false;
    this.backoff = RECONNECT_MIN_MS;
    this.reconnect(true);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      const ws = this.ws;
      if (ws) {
        ws.removeAllListeners();
        // 연결 중인 소켓을 닫으면 ws 가 'error' 를 낸다("WebSocket was closed
        // before the connection was established"). 리스너를 모두 뗀 뒤라 받을
        // 핸들러가 없고, EventEmitter 의 미처리 'error' 는 **던진다** — 프로세스가
        // 죽는다. 그래서 닫기 직전에 삼킬 핸들러 하나를 다시 단다.
        ws.on('error', () => undefined);
        ws.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.uiConnected = false;
    this.catalogSynced = false;
    this.serverToolCount = 0;
    this.pendingCatalogId = '';
    this.lastError = undefined;
    this.emit();
  }

  private clearTimers(): void {
    for (const t of [this.retry, this.hb, this.settle, this.grace]) if (t) clearTimeout(t as never);
    this.retry = this.hb = this.settle = this.grace = null;
  }

  /**
   * 서버들에 다시 붙어 카탈로그·상태를 갱신한다.
   *
   * 소켓이 열려 있지 않아도 재광고한다 — 한 번 실패한 서버의 오류 문구가
   * 소켓 이벤트가 있을 때까지 화면에 그대로 남아 있던 문제(사용자가 uv 를
   * 나중에 설치한 경우)를 여기서 끊는다. sendHello() 는 열려 있을 때만
   * 실제로 전송하고, 상태는 항상 emit 한다.
   */
  /**
   * 카탈로그가 서버에 반영될 때까지 기다린다 (헤드리스 실행용).
   *
   * CLI 는 한 번 물어보고 끝나는 명령이 많다 — 브릿지가 붙기 전에 채팅을 시작하면
   * 에이전트에게 로컬 도구가 없는 채로 첫 턴이 돈다. 데스크톱은 창이 떠 있으니
   * 상태 표시로 충분하지만 CLI 에는 기다릴 자리가 필요하다.
   *
   * 타임아웃은 실패가 아니다 — 현재 상태를 그대로 돌려주고, 부를 쪽이 판단한다.
   */
  async waitUntilReady(timeoutMs = 3_000): Promise<McpBridgeStatus> {
    if (this.status().catalogSynced) return this.status();
    return new Promise((resolve) => {
      // 기존 리스너를 가로채고 끝나면 되돌린다 — 데스크톱은 상태 표시를 이
      // 리스너로 받고 있어서, 잠깐 기다린 대가로 그게 죽으면 안 된다.
      const previous = this.onStatus;
      let done = false;
      const finish = (s: McpBridgeStatus): void => {
        if (done) return;
        done = true;
        this.setStatusListener(previous);
        resolve(s);
      };
      const timer = setTimeout(() => finish(this.status()), Math.max(0, timeoutMs));
      this.setStatusListener((s) => {
        previous(s);
        if (!s.catalogSynced) return;
        clearTimeout(timer);
        finish(s);
      });
    });
  }

  async refreshCatalog(): Promise<void> {
    await this.sendHello();
  }

  private wsUrl(): string {
    const base = this.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}/api/tools/ws/connector-mcp/${encodeURIComponent(this.userId)}`;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = this.backoff;
    this.backoff = Math.min(RECONNECT_MAX_MS, Math.round(this.backoff * 1.8));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reconnect(false);
    }, delay);
  }

  private async reconnect(immediate: boolean): Promise<void> {
    if (this.stopped) return;
    if (immediate && this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (!immediate && this.retry) return;
    if (this.settle) {
      clearTimeout(this.settle);
      this.settle = null;
    }
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
    try {
      const ws = this.ws;
      if (ws) {
        ws.removeAllListeners();
        // 연결 중인 소켓을 닫으면 ws 가 'error' 를 낸다("WebSocket was closed
        // before the connection was established"). 리스너를 모두 뗀 뒤라 받을
        // 핸들러가 없고, EventEmitter 의 미처리 'error' 는 **던진다** — 프로세스가
        // 죽는다. 그래서 닫기 직전에 삼킬 핸들러 하나를 다시 단다.
        ws.on('error', () => undefined);
        ws.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
    const token = await this.getToken();
    if (this.stopped || !this.serverUrl || !this.userId) {
      if (!this.stopped) this.scheduleRetry();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl(), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        ...xgenWebSocketTlsOptions(this.allowPrivateCertificate),
      });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    // 핸드셰이크가 401/403 으로 거절됐다 = 토큰이 회전됐거나 세션이 회수된 것
    // (게이트웨이는 회전/세션제한 때 이전 세션 키를 지운다). 이 리스너가 없으면
    // 'error' 로만 떨어져 **폐기된 토큰으로 백오프 재시도만 반복**하고, 브릿지는
    // 영영 안 붙는다 → 에이전트에 로컬 도구가 절대 노출되지 않는다 (실기).
    // refresh 로 토큰을 회전시키면(다음 reconnect 가 getToken 으로 새 토큰을
    // 집는다) 즉시 재시도한다. 리스너를 단 순간 기본 error/close 경로가 꺼지므로
    // 정리와 재시도 스케줄까지 여기서 책임진다.
    ws.on('unexpected-response', (_req, res) => {
      const sc = res?.statusCode ?? 0;
      try { res?.resume?.(); } catch { /* drain */ }
      this.lastError = `handshake HTTP ${sc}`;
      const heal =
        sc === 401 || sc === 403
          ? Promise.resolve(this.refreshAuth()).catch(() => null)
          : Promise.resolve<string | null>(null);
      void heal.then((fresh) => {
        if (this.ws === ws) this.ws = null;
        try {
          ws.removeAllListeners();
          ws.close();
        } catch {
          /* ignore */
        }
        if (fresh) this.backoff = RECONNECT_MIN_MS;
        this.emit();
        this.scheduleRetry();
      });
    });

    ws.on('open', () => {
      if (this.grace) {
        clearTimeout(this.grace);
        this.grace = null;
      }
      this.lastError = undefined;
      void this.sendHello();
      if (this.hb) clearInterval(this.hb);
      this.hb = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      // Report "connected" only after the socket has stayed open a beat — a
      // socket that opens then immediately closes never flips the UI.
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        this.settle = null;
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          this.uiConnected = true;
          this.backoff = RECONNECT_MIN_MS; // a good connection resets backoff
          this.emit();
        }
      }, SETTLE_MS);
    });

    ws.on('message', (raw: WebSocket.RawData) => void this.onMessage(String(raw)));

    ws.on('close', () => {
      if (this.settle) {
        clearTimeout(this.settle);
        this.settle = null;
      }
      if (this.hb) {
        clearInterval(this.hb);
        this.hb = null;
      }
      if (this.stopped) return;
      this.catalogSynced = false;
      this.serverToolCount = 0;
      this.pendingCatalogId = '';
      // Only flip the UI to "disconnected" after a grace period, so a quick
      // reconnect (settle before grace) keeps the UI steady on "연결됨".
      if (this.uiConnected && !this.grace) {
        this.grace = setTimeout(() => {
          this.grace = null;
          this.uiConnected = false;
          this.emit();
        }, GRACE_MS);
      }
      this.scheduleRetry();
    });
    ws.on('error', (e: Error) => {
      this.lastError = e?.message;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private async sendHello(): Promise<void> {
    try {
      const adverts = await getMcpManager().advertise();
      this.lastServers = adverts;
      const tools = adverts
        .filter((a) => a.connected)
        .flatMap((a) =>
          a.tools.map((t) => ({
            server: a.name,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        );
      // Connector-hosted built-ins (local shell, …) ride the SAME catalog as
      // configured MCP servers — the backend/agent can't tell them apart, so
      // local machine control needs no server-side wiring. Prepended so they
      // are stable and visible even before any external server connects.
      const builtins = getLocalToolProvider()
        .advertise()
        .map((t) => ({
          server: LOCAL_SERVER,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      tools.unshift(...builtins);
      if (this.ws?.readyState === WebSocket.OPEN) {
        const catalogId = `${Date.now()}-${++this.catalogSeq}`;
        this.pendingCatalogId = catalogId;
        this.catalogSynced = false;
        this.serverToolCount = 0;
        this.ws.send(JSON.stringify({ type: 'hello', catalog_id: catalogId, tools }));
        appendMcpRuntimeLog({
          kind: 'catalog',
          message: `도구 카탈로그 ${tools.length}개 재초기화 요청`,
          requestId: catalogId,
        });
      }
      this.emit();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  private async onMessage(text: string): Promise<void> {
    let msg: {
      type?: string;
      request_id?: string;
      server?: string;
      tool?: string;
      args?: unknown;
      context?: unknown;
      catalog_id?: string;
      tool_count?: number;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      if (msg.catalog_id !== this.pendingCatalogId) return;
      this.catalogSynced = true;
      this.serverToolCount = Number.isFinite(msg.tool_count)
        ? Math.max(0, Math.trunc(msg.tool_count as number))
        : 0;
      appendMcpRuntimeLog({
        kind: 'catalog',
        message: `workflow 도구 ${this.serverToolCount}개 적용 완료`,
        requestId: msg.catalog_id,
        ok: true,
      });
      this.emit();
      return;
    }
    if (msg.type === 'mcp_call') {
      const { request_id, server, tool, args } = msg;
      const context = localToolCallContext(msg.context);
      const startedAt = Date.now();
      appendMcpRuntimeLog({
        kind: 'call',
        message: '로컬 MCP 도구 호출 수신',
        requestId: request_id,
        server: String(server),
        tool: String(tool),
      });
      let payload: Record<string, unknown>;
      try {
        // Built-in (connector-hosted) tools dispatch locally; everything else
        // goes to the configured MCP server via MCPManager. Same wire contract.
        const local = getLocalToolProvider();
        const result = local.owns(String(server))
          ? await local.callTool(String(tool), args ?? {}, context)
          : await getMcpManager().callTool(String(server), String(tool), args ?? {});
        payload = { request_id, ok: true, result };
      } catch (e) {
        payload = { request_id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      appendMcpRuntimeLog({
        kind: 'result',
        message: payload.ok
          ? '로컬 MCP 도구 실행 성공'
          : String(payload.error || '로컬 MCP 도구 실행 실패'),
        requestId: request_id,
        server: String(server),
        tool: String(tool),
        ok: payload.ok === true,
        durationMs: Date.now() - startedAt,
      });
      try {
        this.ws?.send(JSON.stringify({ type: 'mcp_result', ...payload }));
      } catch {
        /* socket gone */
      }
    }
    // 'pong' / 'ready' — nothing to do.
  }
}

let _bridge: McpBridge | null = null;
export function getMcpBridge(): McpBridge {
  if (!_bridge) _bridge = new McpBridge();
  return _bridge;
}
