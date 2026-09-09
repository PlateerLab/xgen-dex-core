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

import { parseSubscribed, type LiveTurnSnapshot } from '@dex/protocol';
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

  /**
   * @param onTurn    완결된 턴이 서버에서 밀려왔다.
   * @param onRunning 구독 시점에 **이미 도는 턴이 있는가**. 서버 실행은 연결이
   *   아니라 대화에 매여 있어서(연결을 끊어도 계속 돈다), 웹이나 다른 기기에서
   *   시작한 턴이 이 앱을 켠 순간에도 돌고 있을 수 있다. 재연결 때마다 다시
   *   보고되므로, 소켓이 끊겼다 붙는 것만으로 상태가 스스로 맞춰진다.
   *
   *   세 번째 인자 `live` 는 그 턴의 **여기까지**다(구독 시점에만 온다;
   *   하트비트·종료 알림에는 없어서 `undefined`). 이것이 없으면 다시 붙은 화면은
   *   "진행 중" 표시와 **빈 답변**을 함께 보여 준다 — 서버는 열심히 돌고 있는데
   *   화면에는 아무것도 없는 상태다.
   */
  constructor(
    private onTurn: (turn: ConversationTurn) => void,
    private onRunning?: (
      interactionId: string,
      running: boolean,
      live?: LiveTurnSnapshot | null,
    ) => void,
  ) {}

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
      if (frame?.type === 'heartbeat') {
        // 하트비트가 **현재 사실**을 되풀이해 말한다 — 지금 도는 턴이 있는가.
        // subscribed(구독 시점)와 message(완결) 사이가 비어 있어, 스트림이
        // 분리된 뒤 다른 기기에서 새로 시작된 턴을 놓치던 자리다.
        if (typeof frame.data?.running === 'boolean') {
          this.onRunning?.(interactionId, frame.data.running === true);
        }
        return;
      }
      if (frame?.type === 'subscribed') {
        // 서버가 구독 확립과 함께 "지금 도는 턴이 있는가" 와, 돌고 있다면
        // **그 턴의 여기까지**를 알려 준다. 꺼내는 자리는 정본 파서 하나다
        // (@dex/protocol parseSubscribed) — 예전에는 소비자 셋이 각자
        // `data.running` 만 읽고 진행분은 통째로 버렸다.
        const state = parseSubscribed(frame.data);
        this.onRunning?.(interactionId, state.running, state.live);
        return;
      }
      if (frame?.type === 'exec_done' || frame?.type === 'exec_error' || frame?.type === 'exec_stopped') {
        // 이 대화의 실행이 끝났다 — 우리 스트림이 아니어도 상태는 정리한다.
        this.onRunning?.(interactionId, false);
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
