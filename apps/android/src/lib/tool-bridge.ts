/**
 * 모바일 도구 브리지 — connector-mcp WebSocket 의 안드로이드 반쪽.
 *
 * `wss://<gateway>/api/tools/ws/connector-mcp/{user_id}` (쿠키 인증) 에 붙어
 * `hello` 로 모바일 도구 카탈로그를 광고하고, `mcp_call` 을 받아 기기에서
 * 실행한 뒤 `mcp_result` 로 답한다 — 데스크톱 McpBridge 와 같은 와이어 계약
 * (서버 무변경). 서버는 사용자당 1연결 last-writer-wins 다: 이 브리지가
 * 붙어 있는 동안 데스크톱 커넥터의 로컬 도구 대신 **이 휴대폰의 도구**가
 * 에이전트에 노출된다.
 */

import type { ToolAdvert, ToolResult } from './mobile-tools';

export type BridgeState = 'off' | 'connecting' | 'connected' | 'error';

export interface BridgeStatus {
  state: BridgeState;
  /** 서버가 ACK 한 카탈로그의 도구 수. */
  toolCount: number;
  error?: string;
}

export interface ToolBridgeOptions {
  wsBase: string;
  userId: string;
  catalog: () => ToolAdvert[];
  call: (tool: string, args: unknown) => Promise<ToolResult>;
  onStatus?: (s: BridgeStatus) => void;
  wsFactory?: (url: string) => WebSocket;
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 20_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export class MobileToolBridge {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoff = RECONNECT_MIN_MS;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private catalogSeq = 0;
  private pendingCatalogId = '';
  private status: BridgeStatus = { state: 'off', toolCount: 0 };

  constructor(private opts: ToolBridgeOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff = RECONNECT_MIN_MS;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.clearHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.emit({ state: 'off', toolCount: 0 });
  }

  current(): BridgeStatus {
    return this.status;
  }

  /** 앱 복귀 등 — 백오프 대기를 건너뛰고 지금 재연결한다 (연결돼 있으면 no-op). */
  kick(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.backoff = RECONNECT_MIN_MS;
    this.connect();
  }

  private emit(s: BridgeStatus): void {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private clearHeartbeat(): void {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = this.backoff;
    this.backoff = Math.min(RECONNECT_MAX_MS, Math.round(this.backoff * 1.8));
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private wsUrl(): string {
    const base = this.opts.wsBase.replace(/\/+$/, '');
    return `${base}/api/tools/ws/connector-mcp/${encodeURIComponent(this.opts.userId)}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.opts.wsFactory ?? ((url: string) => new WebSocket(url));
    let ws: WebSocket;
    try {
      ws = factory(this.wsUrl());
    } catch (e) {
      this.emit({ state: 'error', toolCount: 0, error: e instanceof Error ? e.message : String(e) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.emit({ state: 'connecting', toolCount: 0 });

    ws.onopen = () => {
      this.backoff = RECONNECT_MIN_MS;
      this.sendHello();
      this.clearHeartbeat();
      const hbMs = this.opts.heartbeatMs ?? HEARTBEAT_MS;
      if (hbMs > 0) {
        this.hb = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, hbMs);
      }
    };
    ws.onmessage = (evt: MessageEvent) => {
      void this.onMessage(String(evt.data));
    };
    ws.onclose = () => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) {
        this.emit({ state: 'connecting', toolCount: 0, error: this.status.error });
        this.scheduleRetry();
      }
    };
    ws.onerror = () => {
      /* onclose 가 뒤따른다 */
    };
  }

  private sendHello(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const tools = this.opts.catalog();
    const catalogId = `${Date.now()}-${++this.catalogSeq}`;
    this.pendingCatalogId = catalogId;
    this.ws.send(JSON.stringify({ type: 'hello', catalog_id: catalogId, tools }));
  }

  private async onMessage(text: string): Promise<void> {
    let msg: {
      type?: string;
      request_id?: string;
      server?: string;
      tool?: string;
      args?: unknown;
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
      this.emit({
        state: 'connected',
        toolCount: Number.isFinite(msg.tool_count) ? Math.max(0, Math.trunc(msg.tool_count as number)) : 0,
      });
      return;
    }
    if (msg.type === 'mcp_call') {
      const { request_id, tool } = msg;
      let payload: Record<string, unknown>;
      try {
        const result = await this.opts.call(String(tool), msg.args ?? {});
        payload = { request_id, ok: true, result };
      } catch (e) {
        payload = { request_id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        this.ws?.send(JSON.stringify({ type: 'mcp_result', ...payload }));
      } catch {
        /* socket gone */
      }
    }
  }
}
