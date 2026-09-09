/**
 * 모바일 채팅 전송로 — 서버 세션 WebSocket.
 *
 * Backend: `wss://<gateway>/api/agentflow/ws/geny-chat/{interaction_id}`
 * (xgen-workflow geny_chat_ws.py — 게이트웨이가 쿠키 `xgen_access_token` 으로
 * 인증하므로 브라우저/WebView 는 URL 만 열면 된다. **WS 는 CORS 대상이 아니라**
 * 모바일 WebView 에서 게이트웨이 무변경으로 동작하는 유일한 스트리밍 전송로다.)
 *
 * 와이어 (웹 프론트 geny-chat-ws.ts 와 동일 계약):
 *   → {type:'subscribe',  data:{workflow_id, workflow_name, after}}
 *   ← {type:'subscribed'}
 *   → {type:'execute',    data:{input_data, additional_params, client_surface,
 *                              execution_target, ...}}
 *   ← {type:'exec',       data:{event, data}}   // SSE 이벤트명과 1:1
 *   ← {type:'message'}    // 타 기기/능동보고 완결 턴
 *   ← {type:'unsupported'}// geny 에이전트 아님 — 모바일은 여기서 안내로 종료
 *   → {type:'stop'}
 *
 * 모바일 특이점:
 *   - `client_surface: 'connector'` — 커넥터-호스팅 도구(우리의 **모바일 도구**)
 *     주입 게이트가 이 값이다 (agent_geny.connector_surface_allowed).
 *   - `execution_target: 'sandbox'` — 실행은 항상 서버 sandbox. 모바일은 로컬
 *     워크스페이스 실행이 없다 (도구만 모바일에서 돈다).
 */
import { parseSubscribed, turnEventToChatEvent, type LiveTurnSnapshot } from '@dex/protocol';

export type ChatWsState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'unsupported'
  | 'closed';

/** 화면이 소비하는 실행 이벤트 — SSE/WS 공통 의미의 부분집합. */
export interface ExecCallbacks {
  onData?: (text: string) => void;
  onTool?: (ev: { eventType: string; toolName?: string; error?: string }) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  /**
   * 스트림이 끊겼다 — **실패가 아니다.** 서버의 그 턴은 계속 돈다.
   *
   * 받는 쪽이 할 일: 오류를 그리지 말고 [진행 중] 을 유지한다. 재연결이 상태를
   * 다시 확인하고(subscribed.running), 그 사이 끝난 턴은 완결 push 로 온다.
   */
  onDetached?: () => void;
}

/** 서버가 push 한 완결 턴 — Job/sub-agent 트리거의 반응이 대표다.
 *  (자기 실행 턴도 올 수 있다 — 소비자가 source 로 거른다.) */
export interface ServerTurn {
  ioId: number;
  input: string;
  output: string;
  source: string;
}

/**
 * 이 화면의 표식. **연결마다** 새로 만든다 — 기기가 아니라 화면 단위여야 한다
 * (같은 계정으로 폰과 웹을 함께 열면 기기는 둘이지만, 표식은 화면이 소유한다).
 *
 * 서버는 이 표식으로 시작한 턴의 전파를 이 화면에 되돌려 보내지 않는다 —
 * 자기 스트림으로 이미 받고 있으므로, 없으면 이 화면만 글자를 두 번 본다.
 */
export function newOriginId(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * **다른 화면**(웹·PC 앱·다른 폰)이 돌리는 턴.
 *
 * 이것이 없던 동안, 웹에서 던진 질문은 폰 화면에 **턴이 끝날 때까지** 나타나지
 * 않았고, 끝난 뒤에도 서버가 하트비트마다 DB 를 다시 읽을 때까지(최대 10초)
 * 기다려야 했다.
 */
export type PeerTurnEvent =
  | { kind: 'started'; input: string }
  | { kind: 'exec'; event: string; data: unknown }
  | { kind: 'ended'; ioId: number | null; input: string; output: string }
  /** 전파에 구멍이 났다 — 이때만 다시 맞추면 된다. */
  | { kind: 'gap' };

export interface ChatWsHandle {
  execute(input: string): Promise<void>;
  stop(): void;
  close(): void;
  state(): ChatWsState;
}

export interface ChatWsOptions {
  /** 진단 로그 (선택) — WS 수명 이벤트를 남긴다. */
  log?: (line: string) => void;
  wsBase: string; // ws(s)://gateway
  workflowId: string;
  workflowName: string;
  interactionId: string;
  onState?: (s: ChatWsState) => void;
  /** 테스트 주입용 — 기본은 전역 WebSocket. */
  wsFactory?: (url: string) => WebSocket;
  /** 서버 push 완결 턴(트리거 반응 등) — 실시간 반영용. */
  onServerTurn?: (turn: ServerTurn) => void;
  /**
   * 다른 화면이 돌리는 턴 — 시작(질문 본문)·진행(토큰)·종료(완결 본문)·구멍.
   *
   * 이 콜백을 주면 구독할 때 서버에 `live_exec` 를 선언한다. 주지 않으면 서버는
   * 전파 프레임을 보내지 않는다 — 옛 화면과 새 화면이 같은 서버에 붙기 때문에
   * 그 선언이 계약이다.
   */
  onPeerTurn?: (event: PeerTurnEvent) => void;
  /**
   * 이 대화에 **지금 도는 턴이 있는가** — 구독 확립과 재연결마다 온다.
   *
   * 서버 실행은 연결이 아니라 대화에 매여 있다(끊어도 계속 돈다). 웹이나 앱에서
   * 시작한 턴이 이 폰을 켠 순간에도 돌 수 있는데, 그 사실을 모르면 여기서는 끝난
   * 대화처럼 보이고 그 위에 새 턴을 보내 같은 대화에서 둘이 겹친다.
   *
   * 재연결마다 다시 보고되므로 폴링이 필요 없다 — 소켓이 붙는 것만으로 맞춰진다.
   */
  onRunning?: (running: boolean) => void;
  /**
   * 구독 시점에 이미 도는 턴이 있다면 **그 턴의 여기까지**. 도는 턴이 없으면
   * 부르지 않는다.
   *
   * 이것이 없으면 폰을 다시 켠 화면은 "진행 중" 표시와 **빈 말풍선**을 함께
   * 보여 준다 — 서버는 열심히 돌고 있는데 폰에는 아무것도 없는 상태다.
   * `text` 가 빈 문자열인 것과 아예 안 불리는 것은 다르다: 전자는 "돌고 있는데
   * 아직 한 글자도 안 나왔다".
   */
  onLiveTurn?: (live: LiveTurnSnapshot) => void;
  /** 이 기기의 커넥터 슬롯 키 — 실행에 client_device_id 로 실린다. */
  clientDeviceId?: string;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;

/**
 * exec 프레임 1건 → 콜백. ``'end'``/``'error'`` 반환 시 실행 종료.
 *
 * **해석은 정본이 한다** (``turnEventToChatEvent``). 예전에는 여기에 이벤트 이름을
 * 손으로 나열한 분기가 있었고, 같은 뜻의 분기가 @dex/protocol 과 웹에도 따로
 * 있었다 — 해석기가 셋이었다. 서버가 내보내는 것은 18종인데 아는 이름은 각각
 * 15·16·10종이었고, 모르는 이벤트는 **조용히 버려졌다.**
 *
 * 그래서 새 이벤트가 생기면 세 곳을 고쳐야 했고, 안 고친 곳은 아무 신호 없이
 * 다르게 동작했다. 이제 이름을 아는 일은 한 곳이고, 여기는 **이 화면이 그중
 * 무엇을 쓰는가**만 정한다.
 */
export function dispatchExec(
  eventName: string,
  parsed: Record<string, unknown> | undefined,
  cb: ExecCallbacks,
): 'end' | 'error' | null {
  const ev = turnEventToChatEvent(eventName, parsed ?? null);
  if (!ev) return null;
  switch (ev.kind) {
    case 'tool': {
      const p = parsed ?? {};
      cb.onTool?.({
        eventType: String(p.event_type ?? p.type ?? 'tool'),
        toolName: p.tool_name as string | undefined,
        error: p.error as string | undefined,
      });
      return null;
    }
    case 'text':
      // ⚠ 청크 단위로 마커를 지우면 안 된다 — 마커가 청크 경계에서 잘리면 절반이
      // 화면에 샌다. 원문을 그대로 넘기고, 표시는 누적본에 stripAgentMarkers 를
      // 적용한다 (App 렌더).
      cb.onData?.(ev.content);
      return null;
    case 'summary': {
      const outputs = (ev.data as { outputs?: unknown[] })?.outputs;
      if (Array.isArray(outputs) && outputs.length > 0) {
        const first = outputs[0];
        cb.onData?.(typeof first === 'string' ? first : JSON.stringify(first, null, 2));
      }
      return null;
    }
    case 'quota':
      if (ev.level !== 'exceeded') return null;
      cb.onError?.('토큰 한도를 초과했습니다.');
      return 'error';
    case 'end':
      return 'end';
    case 'error':
      cb.onError?.(ev.detail || '실행 오류');
      return 'error';
    default:
      // 이 화면이 아직 안 쓰는 이벤트 — 무해 무시. **버리는 것과 모르는 것은
      // 다르다**: 정본이 이미 이름을 알고 있으므로, 쓰기로 하는 날 여기 한 줄이면 된다.
      return null;
  }
}

/**
 * XGEN 특수 마커([AGENT_STATUS]…[/AGENT_STATUS], <think>…</think>) 제거 —
 * 채팅 표시용. **누적본**에 적용해야 한다 (청크 경계에서 마커가 잘려도,
 * 닫힘이 도착하는 순간 통째로 사라진다). 스트리밍 중 아직 닫히지 않은
 * 블록(꼬리의 미폐쇄 마커/think)은 열림 지점부터 잘라 숨긴다 — 닫힘이
 * 오면 위 규칙이 정식으로 지운다.
 */
export function stripAgentMarkers(text: string): string {
  let out = text
    .replace(/\[AGENT_(?:STATUS|EVENT)\][\s\S]*?\[\/AGENT_(?:STATUS|EVENT)\]/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '');
  // 미폐쇄 블록 — 스트리밍 중간 상태. 열림 이후를 통째로 숨긴다.
  out = out.replace(/\[AGENT_(?:STATUS|EVENT)\][\s\S]*$/, '');
  out = out.replace(/<think>[\s\S]*$/, '');
  return out;
}

export function connectChatWs(opts: ChatWsOptions): ChatWsHandle {
  const factory = opts.wsFactory ?? ((url: string) => new WebSocket(url));
  const url = `${opts.wsBase.replace(/\/+$/, '')}/api/agentflow/ws/geny-chat/${encodeURIComponent(
    opts.interactionId,
  )}`;

  let ws: WebSocket | null = null;
  let state: ChatWsState = 'connecting';
  let subscribed = false;
  /** 이 화면의 표식 — 소켓과 실행 요청이 같은 값을 써야 짝이 맞는다. */
  const originId = newOriginId();
  /** 마지막으로 받은 전파 번호 — 간격이 곧 유실 신호다. */
  let lastSeq = 0;
  let closedByUser = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { cb: ExecCallbacks; resolve: () => void; reject: (e: Error) => void } | null = null;

  const setState = (s: ChatWsState): void => {
    if (state === s) return;
    state = s;
    opts.onState?.(s);
  };

  const failPending = (msg: string): void => {
    if (!pending) return;
    const p = pending;
    pending = null;
    p.cb.onError?.(msg);
    p.reject(new Error(msg));
  };

  /**
   * 진행 중이던 턴을 **실패시키지 않고** 놓는다.
   *
   * 이 스트림은 여기서 끝나지만 서버의 턴은 계속 돈다. 그래서 promise 는 정상
   * 종료시키고(호출부가 예외를 오류로 그리지 않도록), running 은 켜 둔다 —
   * 재연결이 상태를 다시 확인하고 완결 턴은 push 로 온다.
   */
  const detachPending = (): void => {
    if (!pending) return;
    const p = pending;
    pending = null;
    p.cb.onDetached?.();
    opts.onRunning?.(true);
    p.resolve();
  };

  const scheduleReconnect = (): void => {
    if (closedByUser || state === 'unsupported') return;
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      setState('failed');
      return;
    }
    setState('reconnecting');
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  const connect = (): void => {
    reconnectTimer = null;
    try {
      ws = factory(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      opts.log?.(`채팅 WS 연결 (${opts.workflowId})`);
      attempts = 0;
      subscribed = false;
      ws?.send(
        JSON.stringify({
          type: 'subscribe',
          data: {
            workflow_id: opts.workflowId,
            workflow_name: opts.workflowName,
            after: null,
            origin_id: originId,
            // **남의 턴도 실시간으로 보겠다**는 선언. 콜백을 받은 화면만 말한다 —
            // 서버는 말하지 않은 화면에 전파 프레임을 보내지 않는다.
            ...(opts.onPeerTurn ? { live_exec: true } : {}),
          },
        }),
      );
    };
    ws.onmessage = (evt: MessageEvent) => {
      let frame: { type?: string; data?: Record<string, unknown> };
      try {
        frame = JSON.parse(String(evt.data));
      } catch {
        return;
      }
      if (frame.type === 'heartbeat') {
        // 하트비트가 **현재 사실**을 되풀이해 말한다 — 지금 도는 턴이 있는가.
        // subscribed 는 구독 시점만, message 는 완결만 알려 줘서, 그 사이에
        // 다른 기기에서 새로 시작된 턴을 놓치던 자리다.
        if (typeof (frame.data as { running?: unknown } | undefined)?.running === 'boolean') {
          opts.onRunning?.((frame.data as { running: boolean }).running);
        }
        return;
      }
      // ── 다른 화면이 돌리는 턴 ──────────────────────────────────────
      //
      // 자기 턴은 서버가 표식으로 걸러 준다. 자기 실행 스트림의 exec 에는 seq 가
      // 없다 — 그것이 두 경로를 가르는 표식이다.
      if (
        frame.type === 'turn_started' ||
        frame.type === 'turn_ended' ||
        (frame.type === 'exec' && typeof (frame as { seq?: unknown }).seq === 'number')
      ) {
        const seq = (frame as { seq?: number }).seq;
        if (typeof seq === 'number') {
          if (!(lastSeq === 0 || seq === lastSeq + 1)) opts.onPeerTurn?.({ kind: 'gap' });
          lastSeq = seq;
        }
        const d = (frame.data ?? {}) as Record<string, unknown>;
        if (frame.type === 'turn_started') {
          opts.onPeerTurn?.({ kind: 'started', input: String(d.input ?? '') });
        } else if (frame.type === 'turn_ended') {
          opts.onPeerTurn?.({
            kind: 'ended',
            ioId: typeof d.io_id === 'number' ? d.io_id : null,
            input: String(d.input ?? ''),
            output: String(d.output ?? ''),
          });
        } else {
          opts.onPeerTurn?.({
            kind: 'exec',
            event: String(d.event ?? 'message'),
            data: (d as { data?: unknown }).data,
          });
        }
        return;
      }
      if (frame.type === 'subscribed') {
        subscribed = true;
        setState('connected');
        // 번호 기준선. 재연결마다 다시 받으므로 끊긴 사이의 유실은 여기서 조용히
        // 지나간다 — 그 구간은 완결 push(message)가 메운다.
        lastSeq = typeof (frame.data as { seq?: unknown } | undefined)?.seq === 'number'
          ? ((frame.data as { seq: number }).seq)
          : 0;
        // 다른 기기에서 시작한 턴이 아직 도는가, 그리고 돈다면 **어디까지 왔나**.
        // 앞의 것이 없으면 폰에서는 대화가 끝난 것처럼 보여 그 위에 새 턴을 얹게
        // 되고, 뒤의 것이 없으면 "진행 중" 옆이 빈 말풍선으로 남는다.
        // 꺼내는 자리는 정본 파서 하나다 (@dex/protocol parseSubscribed).
        const state = parseSubscribed(frame.data);
        opts.onRunning?.(state.running);
        if (state.live) opts.onLiveTurn?.(state.live);
        return;
      }
      if (frame.type === 'unsupported') {
        // geny 에이전트가 아니다 — 모바일은 WS 전용이므로 여기서 끝낸다.
        setState('unsupported');
        closedByUser = true;
        failPending('이 에이전트는 모바일 채팅을 지원하지 않습니다.');
        return;
      }
      if (frame.type === 'message' && frame.data) {
        // 대화 소켓 push — 서버가 주입한 완결 턴(트리거 반응 등).
        const d = frame.data as Record<string, unknown>;
        opts.onServerTurn?.({
          ioId: Number(d.io_id ?? 0),
          input: String(d.input_data ?? ''),
          output: String(d.output_data ?? ''),
          source: String(d.source ?? 'user'),
        });
        return;
      }
      // 이 대화의 실행이 끝났다 — 우리 턴이 아니어도 [진행 중] 은 내려야 한다.
      if (
        frame.type === 'exec_done' ||
        frame.type === 'exec_error' ||
        frame.type === 'exec_stopped'
      ) {
        if (!pending) opts.onRunning?.(false);
        return;
      }
      if (frame.type === 'exec' && frame.data) {
        if (!pending) return;
        const terminal = dispatchExec(
          String((frame.data as { event?: unknown }).event ?? 'message'),
          (frame.data as { data?: Record<string, unknown> }).data,
          pending.cb,
        );
        if (terminal === 'end') {
          const p = pending;
          pending = null;
          p.cb.onEnd?.();
          p.resolve();
        } else if (terminal === 'error') {
          const p = pending;
          pending = null;
          p.reject(new Error('execution error'));
        }
      }
    };
    ws.onerror = () => {
      /* onclose 가 뒤따른다 */
    };
    ws.onclose = (evt: CloseEvent) => {
      opts.log?.(`채팅 WS 종료 code=${evt?.code ?? '?'} (${opts.workflowId})`);
      // 소켓이 끊겼다고 **턴이 실패한 것이 아니다.** 서버 실행은 연결이 아니라
      // 대화에 매여 있어서 그 턴은 계속 돈다 — 사용자가 [정지] 를 누르지 않는 한.
      //
      // 예전에는 여기서 곧장 실패로 접었다. 폰이 잠기거나 지하철에 들어가거나
      // 게이트웨이가 시간 제한으로 자르면, 멀쩡히 도는 턴이 "연결이 끊어졌습니다"
      // 로 끝난 것처럼 보였고 진짜 답은 아무 데도 안 보였다.
      //
      // 이제 분리로 알리고 재연결에 맡긴다. 다시 붙으면 subscribed 가 running 을
      // 다시 보고하고, 그 사이 끝난 턴은 완결 push(message)로 도착한다.
      if (pending) detachPending();
      if (!closedByUser) scheduleReconnect();
    };
  };
  connect();

  return {
    execute(input: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (!(state === 'connected' && subscribed && ws?.readyState === WebSocket.OPEN)) {
          reject(new Error('서버 세션에 연결되지 않았습니다.'));
          return;
        }
        if (pending) {
          reject(new Error('이미 실행 중입니다.'));
          return;
        }
        pending = { cb: this._cb ?? {}, resolve, reject };
        ws.send(
          JSON.stringify({
            type: 'execute',
            data: {
              input_data: input,
              selected_files: [],
              additional_params: {},
              // 모바일 도구 주입 게이트 — connector 표면이어야 커넥터-호스팅
              // MCP 카탈로그(모바일 도구)가 에이전트에 노출된다.
              client_surface: 'connector',
              // 이 화면의 표식 — 서버가 이 턴의 전파를 여기로 되돌리지 않는다.
              origin_id: originId,
              ...(opts.clientDeviceId ? { client_device_id: opts.clientDeviceId } : {}),
              // 실행은 항상 서버 sandbox — 모바일에는 로컬 실행이 없다.
              execution_target: 'sandbox',
            },
          }),
        );
      });
    },
    stop() {
      try {
        ws?.send(JSON.stringify({ type: 'stop' }));
      } catch {
        /* noop */
      }
    },
    close() {
      closedByUser = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      failPending('closed');
      setState('closed');
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    },
    state: () => state,
  } as ChatWsHandle & { _cb?: ExecCallbacks };
}

/** execute 에 콜백을 붙이는 편의 래퍼 — 핸들 하나 = 대화 하나. */
export function createChat(opts: ChatWsOptions & { callbacks: ExecCallbacks }): ChatWsHandle {
  const handle = connectChatWs(opts) as ChatWsHandle & { _cb?: ExecCallbacks };
  handle._cb = opts.callbacks;
  return handle;
}
