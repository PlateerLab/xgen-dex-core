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
}

export interface ChatWsHandle {
  execute(input: string): Promise<void>;
  stop(): void;
  close(): void;
  state(): ChatWsState;
}

export interface ChatWsOptions {
  wsBase: string; // ws(s)://gateway
  workflowId: string;
  workflowName: string;
  interactionId: string;
  onState?: (s: ChatWsState) => void;
  /** 테스트 주입용 — 기본은 전역 WebSocket. */
  wsFactory?: (url: string) => WebSocket;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;

/** exec 프레임 1건 → 콜백. 'end'/'error' 반환 시 실행 종료. */
export function dispatchExec(
  eventName: string,
  parsed: Record<string, unknown> | undefined,
  cb: ExecCallbacks,
): 'end' | 'error' | null {
  if (eventName === 'tool') {
    const p = parsed ?? {};
    cb.onTool?.({
      eventType: String(p.event_type ?? p.type ?? 'tool'),
      toolName: p.tool_name as string | undefined,
      error: p.error as string | undefined,
    });
    return null;
  }
  if (
    eventName === 'log' ||
    eventName === 'node_status' ||
    eventName === 'execution_io' ||
    eventName === 'canvas_command' ||
    eventName === 'a2ui_command' ||
    eventName === 'floui_command' ||
    eventName === 'download_artifact' ||
    eventName === 'quota_warning' ||
    eventName === 'execution_suspended'
  ) {
    return null; // 모바일 화면이 아직 소비하지 않는 이벤트 — 무해 무시
  }
  if (eventName === 'quota_exceeded') {
    cb.onError?.('토큰 한도를 초과했습니다.');
    return 'error';
  }
  // event 명 없는 message — parsed.type 으로 분기 (웹 dispatchExecEvent 동일).
  const type = (parsed as { type?: string } | undefined)?.type;
  if (type === 'data') {
    const content = (parsed as { content?: unknown }).content;
    // ⚠ 청크 단위로 마커를 지우면 안 된다 — 마커가 청크 경계에서 잘리면
    // 절반이 화면에 샌다. 원문을 그대로 넘기고, 표시는 누적본에
    // stripAgentMarkers 를 적용한다 (App 렌더).
    if (typeof content === 'string') cb.onData?.(content);
    return null;
  }
  if (type === 'summary') {
    const outputs = (parsed as { data?: { outputs?: unknown[] } }).data?.outputs;
    if (Array.isArray(outputs) && outputs.length > 0) {
      const first = outputs[0];
      cb.onData?.(typeof first === 'string' ? first : JSON.stringify(first, null, 2));
    }
    return null;
  }
  if (type === 'end') return 'end';
  if (type === 'error') {
    cb.onError?.(String((parsed as { message?: unknown })?.message ?? '실행 오류'));
    return 'error';
  }
  return null;
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
      attempts = 0;
      subscribed = false;
      ws?.send(
        JSON.stringify({
          type: 'subscribe',
          data: {
            workflow_id: opts.workflowId,
            workflow_name: opts.workflowName,
            after: null,
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
      if (frame.type === 'subscribed') {
        subscribed = true;
        setState('connected');
        return;
      }
      if (frame.type === 'unsupported') {
        // geny 에이전트가 아니다 — 모바일은 WS 전용이므로 여기서 끝낸다.
        setState('unsupported');
        closedByUser = true;
        failPending('이 에이전트는 모바일 채팅을 지원하지 않습니다.');
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
    ws.onclose = () => {
      if (pending) failPending('연결이 끊어졌습니다.');
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
