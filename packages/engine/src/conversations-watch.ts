/**
 * ConversationsWatch — 대화 **목록**의 변화를 밀어 받는다.
 *
 * 대화 하나를 여는 소켓(`ConversationWatchHub`)은 그 대화의 일만 안다. 그런데
 * 사용자가 보는 것은 목록이기도 하다: 다른 기기에서 만든 새 대화, 지운 대화,
 * 바뀐 제목. 예전에는 그것을 알 길이 목록을 **다시 여는** 것뿐이어서, 웹에서
 * 지운 대화가 이 앱 목록에 남아 있고 눌러 보면 빈 대화가 열렸다.
 *
 * 사용자당 소켓 하나다 — 대화가 백 개여도 소켓은 하나다. 소켓 관리 규칙은
 * ConversationWatchHub 와 같다(main 에서 ws(node) + Bearer, 백오프, 하트비트).
 */

import WebSocket from 'ws';
import { xgenWebSocketTlsOptions } from './connection-security';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;
const HEARTBEAT_MS = 25_000;

export interface ConversationsWatchDeps {
  baseUrl: () => string;
  token: () => Promise<string | null>;
  allowPrivateCertificate: () => boolean;
}

export interface ConversationListEvent {
  kind: string;
  interactionId: string;
  workflowId: string;
  running?: boolean;
}

export class ConversationsWatch {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  private deps: ConversationsWatchDeps | null = null;

  constructor(private onEvent: (event: ConversationListEvent) => void) {}

  setDeps(deps: ConversationsWatchDeps): void {
    this.deps = deps;
  }

  start(): void {
    if (this.ws || this.retryTimer) return;
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.retryTimer = null;
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, Math.round(this.retryMs * 1.8));
  }

  private async connect(): Promise<void> {
    if (this.closed || !this.deps) return;
    let ws: WebSocket;
    try {
      const base = this.deps.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws');
      const token = await this.deps.token();
      if (!token) throw new Error('no access token');
      ws = new WebSocket(`${base}/api/agentflow/ws/conversations`, {
        headers: { Authorization: `Bearer ${token}` },
        ...xgenWebSocketTlsOptions(this.deps.allowPrivateCertificate()),
      });
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) this.retryMs = RETRY_MIN_MS;
      }, 5_000);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      let frame: { type?: string; data?: Record<string, unknown> };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const kind = String(frame?.type ?? '');
      if (!kind || kind === 'heartbeat' || kind === 'pong' || kind === 'subscribed') return;
      const d = frame.data ?? {};
      this.onEvent({
        kind,
        interactionId: String(d.interaction_id ?? ''),
        workflowId: String(d.workflow_id ?? ''),
        ...(typeof d.running === 'boolean' ? { running: d.running } : {}),
      });
    });

    ws.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      if (!this.closed) this.scheduleRetry();
    });

    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    });
  }
}
