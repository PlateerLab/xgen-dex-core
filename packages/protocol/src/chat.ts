/**
 * Chat streaming against an XGEN agent.
 *
 * Endpoint: POST /api/agentflow/execute/based-id/stream → text/event-stream.
 * This one endpoint drives EVERY agent node type (agent_geny, agent_xgen,
 * agent_harness, …) — the connector is node-agnostic. Continue a conversation
 * by reusing the same `interactionId` across turns.
 *
 * The raw SSE frames are normalized into the `ChatEvent` union (see types.ts)
 * so callers get one stream of typed events: text chunks, tool/agent activity,
 * node status, citations (inside tool_result), an `execution_io` id, and a
 * terminal `end`.
 */
import { describeStreamError } from './errors';
import { ApiError, HttpClient } from './client';
import { SseParser } from './sse';
import type { ChatEvent, ChatRequest, ChatStopResult, ToolEvent } from './types';

function toRequestBody(req: ChatRequest): Record<string, unknown> {
  return {
    workflow_name: req.workflowName,
    workflow_id: req.workflowId,
    input_data: req.input,
    interaction_id: req.interactionId,
    selected_collections: req.selectedCollections ?? [],
    selected_files: req.selectedFiles ?? [],
    include_logs: req.includeLogs ?? true,
    include_node_status: req.includeNodeStatus ?? true,
    include_tool_events: req.includeToolEvents ?? true,
    response_format: 'stream',
    // 대화 출처 — 이 턴이 데스크톱 커넥터에서 왔음을 서버에 알린다. 서버는 이
    // 값이 "connector" 인 실행에만 커넥터 호스팅 로컬 도구(이 PC 의 파일/셸/
    // 브라우저/오피스 조작)를 에이전트에 노출·실행한다. 웹 채팅은 이 필드를
    // 보내지 않으므로, 같은 사용자가 커넥터를 켜 둔 상태로 웹에서 대화해도
    // 로컬 도구는 절대 작동하지 않는다.
    client_surface: 'connector',
    // 실행 환경 지시 — 로컬 실행 v2 폴백 턴은 'sandbox'(서버 sandbox 강제; 커넥터
    // 로컬 워크스페이스를 원격 조작하는 중간 형태를 쓰지 않는다). 없으면 생략(auto).
    ...(req.executionTarget ? { execution_target: req.executionTarget } : {}),
    // 멀티 디바이스 — 이 표면의 커넥터 기기. 서버 resolve_device 의 prefer.
    ...(req.clientDeviceId ? { client_device_id: req.clientDeviceId } : {}),
  };
}

function mapToolEvent(d: Record<string, unknown>): ToolEvent {
  return {
    eventType: String(d.event_type ?? d.type ?? 'tool'),
    toolName: d.tool_name as string | undefined,
    toolInput: d.tool_input,
    result: d.result as string | undefined,
    resultLength: d.result_length as number | undefined,
    error: d.error as string | undefined,
    citations: d.citations as ToolEvent['citations'],
    runId: d.run_id as string | undefined,
    indicator: d.indicator,
    durationMs: d.duration_ms as number | undefined,
    timestamp: d.timestamp as string | undefined,
  };
}

function parseData(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Translate one SSE frame into a ChatEvent (or null to ignore). Exported for
 * unit testing the protocol mapping without a live server.
 */
export function frameToChatEvent(
  frameEvent: string | undefined,
  rawData: string,
): ChatEvent | null {
  return turnEventToChatEvent(frameEvent, parseData(rawData), rawData);
}

/**
 * 서버가 내보내는 **이름 있는** 턴 이벤트 전부.
 *
 * 서버 ``controller/workflow/utils/turn_events.py`` 의 TURN_EVENTS 표와 짝이다.
 * 그쪽 테스트가 자기 표와 코어 방출을 기계적으로 대조하고, 이쪽은 그 표를 받아
 * 적는다 — 레포가 달라 자동 대조가 안 되므로 **두 검사가 만나는 지점**이 이 목록이다.
 *
 * 목록을 값으로 내보내는 이유: 소비자(웹·모바일)가 자기 해석기가 뒤처졌는지
 * **스스로 검사할 수 있어야** 한다. 예전에는 각자 이름을 손으로 나열해서, 서버가
 * 이벤트를 늘려도 아무 신호가 나지 않았다 — 해석기 셋이 각각 15·16·10종을 알고
 * 있었고 나머지는 조용히 버려졌다.
 */
export const TURN_EVENT_NAMES = [
  'log',
  'node_status',
  'tool',
  'execution_io',
  'llm_progress',
  'llm_end',
  'llm_contract_error',
  'a2ui_command',
  'floui_command',
  'canvas_command',
  'download_artifact',
  'quota_exceeded',
  'quota_warning',
  'execution_suspended',
] as const;

/**
 * 기본 채널(SSE 의 이름 없는 프레임 / WS 의 ``event: 'message'``)로 오는 것들.
 * payload 의 ``type`` 으로 갈린다.
 */
export const TURN_MESSAGE_TYPES = ['data', 'summary', 'end', 'error'] as const;

/**
 * 진행 중인 턴의 **여기까지** — 서버 `turn_stream` 버퍼의 스냅샷.
 *
 * 서버 실행은 연결이 아니라 대화에 매여 있다. 접속기를 닫아도 턴은 계속 도는데,
 * 다시 켰을 때 그 진행분을 볼 길이 없었다: `subscribed` 는 `running: true` 만
 * 알려 주고 히스토리에는 완결 턴만 있으니, 사용자에게는 **"진행 중" 표시와 빈
 * 답변**이 함께 보인다 — 서버는 열심히 돌고 있는데 화면은 비어 있는 상태다.
 */
export interface LiveTurnSnapshot {
  /** 지금까지의 답변 본문. 빈 문자열일 수 있다 — 아직 한 글자도 안 나온 턴이다. */
  text: string;
  /** 본문이 아닌 진행(도구·노드 상태 등). 서버가 아직 안 실으면 빈 배열. */
  events: unknown[];
}

/** `subscribed` 프레임이 말하는 것 — 커서, 지금 도는 턴이 있는가, 그 진행분. */
export interface SubscribedState {
  cursor: number;
  running: boolean;
  /**
   * `null` 과 `{text: ''}` 는 다르다. 전자는 "이 대화에 도는 턴이 없다",
   * 후자는 "돌고 있는데 아직 한 글자도 안 나왔다" — 화면이 그 둘을 다르게 그린다
   * (전자는 평소 화면, 후자는 빈 말풍선 + 진행 표시).
   */
  live: LiveTurnSnapshot | null;
}

/**
 * `subscribed` 프레임의 data → {@link SubscribedState}.
 *
 * 세 소비자(엔진·모바일·웹)가 각자 `data.running` 만 꺼내 읽고 `live` 는 통째로
 * 버리고 있었다 — 서버가 진행분을 실어 보내는데 받는 쪽이 없었다. 꺼내는 자리를
 * 하나로 둬야 다음 필드가 늘 때도 세 곳이 같이 움직인다.
 *
 * 서버가 `live` 를 생략하거나(도는 턴 없음) 형태가 어긋나면 `live: null` 이다 —
 * 구 서버에 붙어도 예전과 똑같이 동작한다.
 */
export function parseSubscribed(data: unknown): SubscribedState {
  const d = (data ?? {}) as Record<string, unknown>;
  const running = d.running === true;
  const rawLive = d.live;
  let live: LiveTurnSnapshot | null = null;
  if (running && rawLive && typeof rawLive === 'object') {
    const l = rawLive as Record<string, unknown>;
    live = {
      text: typeof l.text === 'string' ? l.text : '',
      events: Array.isArray(l.events) ? l.events : [],
    };
  }
  return {
    cursor: typeof d.cursor === 'number' ? d.cursor : Number(d.cursor ?? 0) || 0,
    running,
    live,
  };
}

/**
 * 턴 이벤트 하나 → ChatEvent. **전송로를 모른다.**
 *
 * SSE 는 `event:` 줄과 `data:` 원문을, WS 는 `{event, data}` 봉투를 준다 — 봉투만
 * 다르고 속은 같다(서버 `turn_events` 표가 그것을 보장한다). 그래서 해석은 여기
 * 하나면 된다.
 *
 * 이 함수가 생긴 이유: 해석기가 **세 벌**이었다(@dex/protocol 15종 · 모바일 16종 ·
 * 웹 10종). 서버가 내보내는 것은 18종인데 아무도 전부를 알지 못했고, 모르는
 * 이벤트는 조용히 버려졌다 — 새 이벤트를 만들면 세 곳을 고쳐야 했고, 안 고친
 * 곳은 아무 신호 없이 다르게 동작했다.
 *
 * @param name    이벤트 이름. SSE 의 이름 없는 기본 프레임은 `undefined`/`''`/`'message'`.
 * @param payload 파싱된 payload. WS 는 이미 객체를 들고 있다.
 * @param raw     원문(있으면). `log` 는 파싱 실패 시 원문을 그대로 싣는다.
 */
export function turnEventToChatEvent(
  name: string | undefined,
  payload: Record<string, unknown> | null,
  raw = '',
): ChatEvent | null {
  const d = payload;
  const frameEvent = name;

  // Named event frames.
  switch (frameEvent) {
    case 'tool':
      return d ? { kind: 'tool', event: mapToolEvent(d) } : null;
    case 'node_status':
      return d
        ? {
            kind: 'node_status',
            event: { nodeId: String(d.node_id ?? ''), status: String(d.status ?? ''), ...d },
          }
        : null;
    case 'log':
      return { kind: 'log', data: d ?? raw };
    case 'execution_io':
      return d ? { kind: 'execution_io', executionIoId: Number(d.execution_io_id ?? 0) } : null;
    case 'download_artifact':
      return d ? { kind: 'download', data: d } : null;
    case 'a2ui_command':
      return d ? { kind: 'ui_command', surface: 'a2ui', command: d } : null;
    case 'floui_command':
      return d ? { kind: 'ui_command', surface: 'floui', command: d } : null;
    case 'canvas_command':
      // 에이전트가 자기 그래프를 고쳤다(WorkflowSelf). 캔버스를 연 화면이 다시 그린다.
      // 이 줄이 없어서 앱·CLI·VSCode 는 서버가 보낸 것을 조용히 버리고 있었다.
      return d ? { kind: 'canvas_command', command: d } : null;
    case 'llm_progress':
      return d ? { kind: 'llm_contract', phase: 'progress', data: d } : null;
    case 'llm_end':
      return d ? { kind: 'llm_contract', phase: 'end', data: d } : null;
    case 'llm_contract_error':
      return d ? { kind: 'llm_contract', phase: 'error', data: d } : null;
    case 'quota_warning':
      return d ? { kind: 'quota', level: 'warning', data: d } : null;
    case 'quota_exceeded':
      return d ? { kind: 'quota', level: 'exceeded', data: d } : null;
    case 'execution_suspended':
      return {
        kind: 'error',
        detail: '워크플로우가 관리자에 의해 일시 중지되었습니다.',
        info: {
          code: 'XGEN-930',
          title: '이 에이전트가 관리자에 의해 일시 중지되었습니다.',
          hint: '관리자가 다시 시작할 때까지 기다려 주세요.',
          retryable: false,
        },
      };
    case undefined:
    case '':
    case 'message':
      break; // default frame — dispatch on the JSON `type` below
    default:
      // Unknown named event — ignore.
      return null;
  }

  // Default ("message") frames carry a `type`.
  if (!d) return null;
  switch (d.type) {
    case 'data':
      return { kind: 'text', content: String(d.content ?? '') };
    case 'summary': {
      const data = (d.data as Record<string, unknown>) ?? {};
      const outputs = (data.outputs as unknown[]) ?? [];
      return { kind: 'summary', text: outputs.map(String).join(''), data };
    }
    case 'end':
      return { kind: 'end' };
    case 'error': {
      // 서버 실행 오류 — 대개 `[ERRORnnn: 사용자용 메시지]` 마커가 들어 있다.
      // 원문(detail)은 그대로 두고, 화면이 쓸 형태(info)를 함께 싣는다.
      const detail = String(d.detail ?? d.error ?? 'unknown error');
      return { kind: 'error', detail, info: describeStreamError(detail) };
    }
    // Some tool/agent frames arrive as bare `data:` JSON (no event: line).
    case 'tool_call':
    case 'tool_start':
    case 'tool_result':
    case 'tool_error':
      return { kind: 'tool', event: mapToolEvent(d) };
    default:
      return null;
  }
}

export class ChatApi {
  constructor(private http: HttpClient) {}

  /**
   * 사람이 누른 [정지] 를 서버에 전한다.
   *
   * 예전에는 정지가 곧 **연결 끊기**였다 — 스트림을 abort 하면 서버가 그것을
   * 취소로 읽었다. 서버는 더 이상 그렇게 읽지 않는다(화면 잠금·절전·기기 이동이
   * 실행을 끊어 버렸기 때문에). 그래서 abort 는 이제 "나는 안 볼게" 일 뿐이고,
   * **정지는 이 호출이다.** 부르지 않으면 버려진 턴이 끝까지 돌아 답을 대화에
   * 적는다 — 사용자가 멈췄다고 믿은 그 대화에.
   *
   * 정지는 연결이 아니라 **대화**를 향하므로, 시작한 기기가 아니어도 닿는다.
   * 멈출 것이 없거나(404) 다른 파드가 돌리는 턴이면(409) 던지지 않고 이유를
   * 돌려준다 — 정지 버튼이 예외로 UX 를 깨서는 안 된다.
   */
  async stop(interactionId: string): Promise<ChatStopResult> {
    const id = interactionId.trim();
    if (!id) return { stopped: false, reason: 'not_running' };
    try {
      await this.http.post(`/api/agentflow/execute/stop/${encodeURIComponent(id)}`);
      return { stopped: true };
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 404) return { stopped: false, reason: 'not_running' };
      if (status === 409) return { stopped: false, reason: 'elsewhere' };
      return {
        stopped: false,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Stream a chat turn. Yields normalized ChatEvents until the terminal `end`
   * (or the stream closes). Pass an AbortSignal to cancel mid-stream.
   */
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent, void, void> {
    const res = await this.http.stream(
      '/api/agentflow/execute/based-id/stream',
      toRequestBody(req),
      signal,
    );
    const body = res.body;
    if (!body) throw new Error('스트림 응답 본문이 없습니다.');

    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    /**
     * 터미널 프레임(`end` / `error`)을 봤는가.
     *
     * 이 한 비트가 "끝났다" 와 "끊겼다" 를 가른다. 없으면 둘이 똑같이 보이고,
     * 그때 받다 만 텍스트가 최종 답이 되거나 멀쩡히 도는 턴이 실패로 표시된다.
     */
    let terminal = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const f of frames) {
          const ev = frameToChatEvent(f.event, f.data);
          if (ev) {
            if (ev.kind === 'end' || ev.kind === 'error') terminal = true;
            yield ev;
            if (ev.kind === 'end') return;
          }
        }
      }
      for (const f of parser.flush()) {
        const ev = frameToChatEvent(f.event, f.data);
        if (ev) {
          if (ev.kind === 'end' || ev.kind === 'error') terminal = true;
          yield ev;
        }
      }
      // 본문이 터미널 프레임 없이 끝났다 — 게이트웨이의 1시간 컷, 프록시, 절전,
      // 네트워크 전환. 서버의 그 턴은 **계속 돌고 있다.**
      if (!terminal) yield { kind: 'detached', reason: 'stream_closed' };
    } catch (e) {
      // 취소(AbortSignal)는 사용자가 이 스트림을 그만 보겠다는 뜻이라 그대로 던진다.
      // 그 밖의 전송 오류는 끊김이다 — 같은 규약으로 분리를 알린다.
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      yield { kind: 'detached', reason: 'network' };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Convenience: run a turn to completion and return the accumulated assistant
   * text plus collected tool events. Ignores intermediate UI/log frames.
   */
  async complete(
    req: ChatRequest,
    onEvent?: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    tools: ToolEvent[];
    error?: string;
    executionIoId?: number;
    /**
     * 스트림이 끊겼고 **그 턴은 서버에서 계속 돈다.** 이때 `text` 는 받다 만
     * 조각이지 답이 아니다 — 최종 답은 히스토리로 온다.
     */
    detached?: boolean;
  }> {
    let text = '';
    let summary = '';
    const tools: ToolEvent[] = [];
    let error: string | undefined;
    let executionIoId: number | undefined;
    let detached = false;
    for await (const e of this.stream(req, signal)) {
      onEvent?.(e);
      if (e.kind === 'text') text += e.content;
      else if (e.kind === 'summary') summary = e.text;
      else if (e.kind === 'tool') tools.push(e.event);
      else if (e.kind === 'execution_io') executionIoId = e.executionIoId;
      else if (e.kind === 'error') error = e.detail;
      else if (e.kind === 'detached') detached = true;
    }
    return {
      text: text || summary,
      tools,
      error,
      executionIoId,
      ...(detached ? { detached: true } : {}),
    };
  }
}
