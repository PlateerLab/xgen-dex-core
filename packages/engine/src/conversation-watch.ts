/**
 * ConversationWatchHub — 열린 채팅의 **대화 소켓**(geny-chat WS) 구독.
 *
 * 데스크톱 채팅은 자기가 시작한 턴만 SSE 로 받는다. 서버가 세션에 주입하는
 * 턴 — Job/sub-agent 트리거의 반응 턴 — 은 어느 스트림에도 실리지 않아
 * "새로고침해야 보이는" 상태였다. 이 허브가 대화마다
 * `/api/agentflow/ws/geny-chat/{interaction}` 을 구독해 서버 push('message')
 * 를 렌더러로 흘린다. 완결 턴만 온다(진행 중 반응 턴은 서버가 보류). 도구를 쓴 턴의 완결 행에는
 * 서버가 실행 기록에서 되살린 작업 과정(`process`)이 함께 온다.
 *
 * 소켓 관리는 TeamsSocketHub 와 같은 원칙: main 에서 ws(node) + Bearer,
 * 백오프 재연결, 하트비트. 'unsupported'(geny 에이전트 아님)면 그 대화는
 * 다시 붙지 않는다.
 */

import {
  parseSubscribed,
  toHistoryProcess,
  turnAttachments,
  turnInputText,
  type HistoryFlowItem,
  type LiveTurnSnapshot,
  type TurnAttachment,
} from '@dex/protocol';
import WebSocket from 'ws';
import { xgenWebSocketTlsOptions } from './connection-security';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;
const HEARTBEAT_MS = 15_000;
/**
 * 이만큼 아무 프레임도 없으면 소켓이 죽은 것이다. 서버는 10초마다 하트비트를 보내고 우리 ping 에도 답한다 —
 * 반쯤 열린 연결(절전에서 깨어남·Wi-Fi 전환)은 close 가 영영 오지 않으므로 이 침묵이 유일한 신호다.
 */
const SILENT_MS = 45_000;
/** 깨어났을 때 묻는 ping 의 답을 기다리는 시간. */
const PROBE_MS = 5_000;

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
  | { kind: 'started'; interactionId: string; input: string; attachments: TurnAttachment[]; originId?: string }
  | { kind: 'exec'; interactionId: string; event: string; data: unknown; originId?: string }
  | {
      kind: 'ended';
      interactionId: string;
      ioId: number | null;
      input: string;
      output: string;
      attachments: TurnAttachment[];
      originId?: string;
    }
  /**
   * 전파에 구멍이 났다 — 이때만 히스토리를 다시 읽으면 된다. 번호가 건너뛰었을 때와, 소켓이 끊겼다 다시
   * 붙었을 때(그 사이에 시작해 끝난 턴은 어떤 프레임으로도 오지 않는다) 온다.
   */
  | { kind: 'gap'; interactionId: string };

export interface ConversationTurn {
  interactionId: string;
  ioId: number;
  input: string;
  output: string;
  source: string;
  updatedAt: string;
  /**
   * 이 턴의 작업 과정(글·도구 순서) — 도구를 쓴 턴에만, 서버가 실행 기록에서 되살린 것. 진행 프레임을
   * 놓친 화면도 이것으로 같은 타임라인을 그린다. 옛 서버는 싣지 않는다.
   */
  process?: HistoryFlowItem[];
}

interface WatchEntry {
  workflowId: string;
  workflowName: string;
  ws: WebSocket | null;
  retryMs: number;
  retryTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  /** 깨어났을 때 보낸 ping 의 답을 기다리는 중. */
  probe: NodeJS.Timeout | null;
  /** 마지막으로 무엇이든 받은 시각 — 침묵이 길면 소켓이 죽은 것이다. */
  lastFrameAt: number;
  closed: boolean;
  /** 마지막으로 받은 전파 번호 — 간격이 곧 유실 신호다. */
  lastSeq: number;
  /** 한 번이라도 구독이 확립됐는가 — 그 뒤의 구독 확립은 끊겼다 다시 붙은 것이다. */
  subscribedOnce: boolean;
}

/**
 * 이 앱 화면이 보내는 턴의 표식(실행 요청의 `origin_id`). **프로세스마다 하나**다 — 같은 PC 에서 앱과 웹을
 * 나란히 열면 기기는 하나지만 화면은 둘이고, 각자 자기 스트림을 본다.
 */
export const DEX_ORIGIN_ID = `dex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 감시 소켓이 구독할 때 쓰는 표식 — 턴의 표식(`DEX_ORIGIN_ID`)과 **일부러 다르다.**
 *
 * 서버는 구독 표식과 같은 표식의 턴을 이 소켓으로 보내지 않는다(메아리 거르기). 그런데 이 앱의 턴은 이
 * 소켓이 아니라 SSE 로 흐르고, 그 SSE 가 끊기면(절전·네트워크 전환·게이트웨이 1시간 컷) 그 턴의 나머지를
 * 볼 길이 이 소켓뿐이다. 같은 표식으로 구독하면 바로 그때 서버가 진행·종료를 걸러 버려, 화면은 끊긴
 * 자리에서 멈춘다. 그래서 서버는 거르지 않게 하고, 거르기는 스트림의 처지를 아는 화면이 한다:
 * 자기 표식의 프레임은 스트림이 살아 있는 동안 버리고, 분리된 뒤에는 남의 턴처럼 받는다(`originId`).
 */
export const WATCH_ORIGIN_ID = `${DEX_ORIGIN_ID}-watch`;

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
    /**
     * 이 대화의 모델이 바뀌었다(어느 화면에서든). `data.current` 가 새 지금 모델이다
     * (@dex/protocol applyModelNotice). 턴 번호가 없는 소식이라 간격 감지와 섞지 않는다.
     */
    private onModel?: (interactionId: string, data: Record<string, unknown>) => void,
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
      probe: null,
      lastFrameAt: Date.now(),
      closed: false,
      lastSeq: 0,
      subscribedOnce: false,
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
    if (entry.probe) clearTimeout(entry.probe);
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
   * 지금 살아 있는지 확인한다 — 절전에서 깨어났거나 창이 다시 앞으로 왔을 때.
   *
   * 붙어 있지 않으면 백오프를 기다리지 않고 지금 다시 붙는다. 붙어 있다고 믿는 소켓에는 ping 을 보내고,
   * 잠깐 안에 아무 답도 없으면 끊고 새로 붙는다 — 잠든 사이 서버 쪽에서 놓친 소켓은 이쪽에서 보기엔
   * 멀쩡히 열려 있다. 새로 붙으면 구독 확립이 "지금 도는가" 와 구멍을 알려 화면이 스스로 맞춘다.
   */
  refresh(): void {
    for (const [interactionId, entry] of this.entries) {
      if (entry.closed) continue;
      const ws = entry.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (ws && ws.readyState === WebSocket.CONNECTING) continue;
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
        entry.retryMs = RETRY_MIN_MS;
        void this.connect(interactionId, entry);
        continue;
      }
      if (entry.probe) continue;
      const askedAt = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* 아래 확인이 끊는다 */
      }
      entry.probe = setTimeout(() => {
        entry.probe = null;
        if (entry.ws === ws && entry.lastFrameAt < askedAt) this.drop(entry, ws);
      }, PROBE_MS);
    }
  }

  /** 죽은 소켓을 버린다 — close 가 오지 않는 연결이라 terminate 로 끊고, 곧바로 다시 붙게 한다. */
  private drop(entry: WatchEntry, ws: WebSocket): void {
    entry.retryMs = RETRY_MIN_MS;
    try {
      ws.terminate();
    } catch {
      /* close 가 뒤따른다 */
    }
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
            // 턴의 표식과 다른 값이다(WATCH_ORIGIN_ID 설명) — 이 앱의 턴도 이 소켓으로 온다.
            origin_id: WATCH_ORIGIN_ID,
            // **남의 턴도 실시간으로 보겠다**는 선언. 서버는 이 말을 한 화면에만
            // 전파 프레임을 보낸다 — 옛 화면과 새 화면이 같은 서버에 붙는다.
            live_exec: true,
          },
        }),
      );
      entry.lastFrameAt = Date.now();
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - entry.lastFrameAt > SILENT_MS) {
          // 서버 하트비트도, 우리 ping 의 답도 오지 않는다 — 반쯤 열린 연결이다.
          this.drop(entry, ws);
          return;
        }
        ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      if (entry.ws === ws) entry.lastFrameAt = Date.now();
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
        // 누가 시작한 턴인가 — 화면이 자기 스트림의 메아리를 가른다(WATCH_ORIGIN_ID 설명).
        const originId = typeof frame.origin_id === 'string' && frame.origin_id ? frame.origin_id : undefined;
        // 질문은 본문만, 첨부는 따로 — 옛 서버는 `{input_str, attachments}` 를 JSON 으로 실어 보냈다.
        const attachments = turnAttachments(Array.isArray(d.attachments) ? d.attachments : d.input);
        if (frame.type === 'turn_started') {
          this.onPeer?.({ kind: 'started', interactionId, input: turnInputText(d.input), attachments, originId });
        } else if (frame.type === 'turn_ended') {
          this.onPeer?.({
            kind: 'ended',
            interactionId,
            ioId: typeof d.io_id === 'number' ? d.io_id : null,
            input: turnInputText(d.input),
            output: String(d.output ?? ''),
            attachments,
            originId,
          });
        } else {
          this.onPeer?.({
            kind: 'exec',
            interactionId,
            event: String((d as { event?: unknown }).event ?? 'message'),
            data: (d as { data?: unknown }).data,
            originId,
          });
        }
        return;
      }
      if (frame?.type === 'model') {
        this.onModel?.(interactionId, frame.data ?? {});
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
        // 다시 붙었다 — 끊긴 사이에 시작해 끝난 턴은 어떤 프레임으로도 오지 않는다(완결 행도 구독 시점의
        // 기준선에 묻힌다). 화면이 히스토리로 메우도록 구멍을 알린다. 첫 구독은 화면이 막 히스토리를 읽었다.
        if (entry.subscribedOnce) this.onPeer?.({ kind: 'gap', interactionId });
        entry.subscribedOnce = true;
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
        input: turnInputText(d.input_data),
        output: String(d.output_data ?? ''),
        source: String(d.source ?? 'user'),
        updatedAt: String(d.updated_at ?? ''),
        process: toHistoryProcess(d.process),
      });
    });

    ws.on('close', () => {
      if (entry.ws !== ws) return; // 이미 새 소켓으로 갈아탔다
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
      if (entry.probe) clearTimeout(entry.probe);
      entry.probe = null;
      entry.ws = null;
      if (!entry.closed) this.scheduleRetry(interactionId, entry);
    });
    ws.on('error', () => {
      /* close 가 뒤따른다 */
    });
  }
}
