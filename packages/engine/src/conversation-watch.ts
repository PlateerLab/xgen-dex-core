/**
 * ConversationWatchHub — 열린 채팅의 **대화 소켓**(geny-chat WS) 구독.
 *
 * 데스크톱 채팅은 자기가 시작한 턴만 SSE 로 받는다. 서버가 세션에 주입하는
 * 턴 — Job/sub-agent 트리거의 반응 턴 — 은 어느 스트림에도 실리지 않아
 * "새로고침해야 보이는" 상태였다. 이 허브가 대화마다
 * `/api/agentflow/ws/geny-chat/{interaction}` 을 구독해 서버 push('message')
 * 를 렌더러로 흘린다. 완결 턴만 온다(진행 중 반응 턴은 서버가 보류).
 *
 * 소켓 관리는 TeamsSocketHub 와 같은 원칙: main 에서 ws(node) + Bearer,
 * 백오프 재연결, 하트비트. 'unsupported'(geny 에이전트 아님)면 그 대화는
 * 다시 붙지 않는다.
 */

import WebSocket from 'ws';
import { xgenWebSocketTlsOptions } from './connection-security';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;
const HEARTBEAT_MS = 25_000;

export interface WatchDeps {
  baseUrl: () => string;
  token: () => Promise<string | null>;
  allowPrivateCertificate: () => boolean;
}

export interface ConversationTurn {
  interactionId: string;
  ioId: number;
  input: string;
  output: string;
  source: string;
  updatedAt: string;
}

interface WatchEntry {
  workflowId: string;
  workflowName: string;
  ws: WebSocket | null;
  retryMs: number;
  retryTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  closed: boolean;
}

export class ConversationWatchHub {
  private entries = new Map<string, WatchEntry>();
  private deps: WatchDeps | null = null;

  constructor(private onTurn: (turn: ConversationTurn) => void) {}

  setDeps(deps: WatchDeps): void {
    this.deps = deps;
  }

  watch(workflowId: string, workflowName: string, interactionId: string): void {
    if (!interactionId || this.entries.has(interactionId)) return;
    const entry: WatchEntry = {
      workflowId,
      workflowName,
      ws: null,
      retryMs: RETRY_MIN_MS,
      retryTimer: null,
      heartbeat: null,
      closed: false,
    };
    this.entries.set(interactionId, entry);
    this.connect(interactionId, entry);
  }

  unwatch(interactionId: string): void {
    const entry = this.entries.get(interactionId);
    if (!entry) return;
    entry.closed = true;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    try {
      entry.ws?.close();
    } catch {
      /* already gone */
    }
    this.entries.delete(interactionId);
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.unwatch(id);
  }

  private scheduleRetry(interactionId: string, entry: WatchEntry): void {
    if (entry.closed || entry.retryTimer) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.connect(interactionId, entry);
    }, entry.retryMs);
    entry.retryMs = Math.min(RETRY_MAX_MS, Math.round(entry.retryMs * 1.8));
  }

  private async connect(interactionId: string, entry: WatchEntry): Promise<void> {
    if (entry.closed || !this.deps) return;
    let ws: WebSocket;
    try {
      const base = this.deps.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws');
      const token = await this.deps.token();
      if (!token) throw new Error('no access token');
      ws = new WebSocket(
        `${base}/api/agentflow/ws/geny-chat/${encodeURIComponent(interactionId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          ...xgenWebSocketTlsOptions(this.deps.allowPrivateCertificate()),
        },
      );
    } catch {
      this.scheduleRetry(interactionId, entry);
      return;
    }
    entry.ws = ws;

    ws.on('open', () => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) entry.retryMs = RETRY_MIN_MS;
      }, 5_000);
      // 라이브 전용 — 히스토리는 REST 가 소유한다 (웹 채팅과 동일 계약).
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          data: {
            workflow_id: entry.workflowId,
            workflow_name: entry.workflowName,
            after: null,
          },
        }),
      );
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = setInterval(() => {
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
      if (frame?.type === 'unsupported') {
        // geny 에이전트 아님 — 이 대화는 감시 대상이 아니다.
        this.unwatch(interactionId);
        return;
      }
      if (frame?.type !== 'message' || !frame.data) return;
      const d = frame.data;
      this.onTurn({
        interactionId,
        ioId: Number(d.io_id ?? 0),
        input: String(d.input_data ?? ''),
        output: String(d.output_data ?? ''),
        source: String(d.source ?? 'user'),
        updatedAt: String(d.updated_at ?? ''),
      });
    });

    ws.on('close', () => {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
      if (entry.ws === ws) entry.ws = null;
      if (!entry.closed) this.scheduleRetry(interactionId, entry);
    });
    ws.on('error', () => {
      /* close 가 뒤따른다 */
    });
  }
}
