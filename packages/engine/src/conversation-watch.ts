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

/**
 * **다른 화면**에서 벌어지는 턴 — 시작·진행·종료.
 *
 * 이것이 없던 동안, 앱과 웹을 나란히 열어 두고 한 쪽에서 말을 걸면 다른 쪽에는
 * 턴이 끝날 때까지 아무것도 나타나지 않았다. 그리고 끝난 뒤에도 최대 10초 뒤에야
 * 나타났다(서버가 하트비트마다 DB 를 다시 읽었다).
 */
export type PeerTurnEvent =
  | { kind: 'started'; interactionId: string; input: string }
  | { kind: 'exec'; interactionId: string; event: string; data: unknown }
  | { kind: 'ended'; interactionId: string; ioId: number | null; input: string; output: string }
  /** 전파에 구멍이 났다 — 이때만 히스토리를 다시 읽으면 된다. */
  | { kind: 'gap'; interactionId: string };

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
  /** 마지막으로 받은 전파 번호 — 간격이 곧 유실 신호다. */
  lastSeq: number;
}

/**
 * 이 앱 화면의 표식. **프로세스마다 하나**다 — 같은 PC 에서 앱과 웹을 나란히
 * 열면 기기는 하나지만 화면은 둘이고, 각자 자기 스트림을 본다.
 */
export const DEX_ORIGIN_ID = `dex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
    /** 다른 화면이 돌리는 턴 — 시작·진행·종료·구멍. */
    private onPeer?: (event: PeerTurnEvent) => void,
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
      lastSeq: 0,
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

  /**
   * 번호가 하나씩 늘었는가. 늘지 않았으면 그 사이 프레임이 사라진 것이다.
   *
   * 밀어 주는 구조에서 유실은 없앨 수 없다 — **감지할 수 있게** 만드는 것이
   * 우리가 할 수 있는 일이고, 그래야 "혹시 몰라 계속 다시 읽기" 를 안 해도 된다.
   */
  private checkSeq(interactionId: string, entry: WatchEntry, seq: unknown): void {
    if (typeof seq !== 'number') return;
    const ok = entry.lastSeq === 0 || seq === entry.lastSeq + 1;
    entry.lastSeq = seq;
    if (!ok) this.onPeer?.({ kind: 'gap', interactionId });
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
            origin_id: DEX_ORIGIN_ID,
            // **남의 턴도 실시간으로 보겠다**는 선언. 서버는 이 말을 한 화면에만
            // 전파 프레임을 보낸다 — 옛 화면과 새 화면이 같은 서버에 붙는다.
            live_exec: true,
          },
        }),
      );
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      let frame: { type?: string; seq?: number; origin_id?: string; data?: Record<string, unknown> };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      // ── 다른 화면이 돌리는 턴 ─────────────────────────────────────
      //
      // 자기 턴은 서버가 걸러 준다(origin_id). 자기 실행 스트림의 exec 에는
      // seq 가 없다 — 그것이 두 경로를 가르는 표식이다.
      if (
        frame?.type === 'turn_started'
        || frame?.type === 'turn_ended'
        || (frame?.type === 'exec' && typeof frame.seq === 'number')
      ) {
        this.checkSeq(interactionId, entry, frame.seq);
        const d = frame.data ?? {};
        if (frame.type === 'turn_started') {
          this.onPeer?.({ kind: 'started', interactionId, input: String(d.input ?? '') });
        } else if (frame.type === 'turn_ended') {
          this.onPeer?.({
            kind: 'ended',
            interactionId,
            ioId: typeof d.io_id === 'number' ? d.io_id : null,
            input: String(d.input ?? ''),
            output: String(d.output ?? ''),
          });
        } else {
          this.onPeer?.({
            kind: 'exec',
            interactionId,
            event: String((d as { event?: unknown }).event ?? 'message'),
            data: (d as { data?: unknown }).data,
          });
        }
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
        // 번호 기준선. 재연결마다 다시 받으므로 끊긴 사이의 유실은 여기서
        // 조용히 지나간다 — 그 구간은 히스토리 재조회가 메운다.
        entry.lastSeq = typeof frame.data?.seq === 'number' ? (frame.data.seq as number) : 0;
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
