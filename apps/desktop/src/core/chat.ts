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
import { HttpClient } from './client';
import { SseParser } from './sse';
import type { ChatEvent, ChatRequest, ToolEvent } from './types';

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
  const d = parseData(rawData);

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
      return { kind: 'log', data: d ?? rawData };
    case 'execution_io':
      return d ? { kind: 'execution_io', executionIoId: Number(d.execution_io_id ?? 0) } : null;
    case 'download_artifact':
      return d ? { kind: 'download', data: d } : null;
    case 'a2ui_command':
      return d ? { kind: 'ui_command', surface: 'a2ui', command: d } : null;
    case 'floui_command':
      return d ? { kind: 'ui_command', surface: 'floui', command: d } : null;
    case 'quota_warning':
      return d ? { kind: 'quota', level: 'warning', data: d } : null;
    case 'quota_exceeded':
      return d ? { kind: 'quota', level: 'exceeded', data: d } : null;
    case 'execution_suspended':
      return { kind: 'error', detail: '워크플로우가 관리자에 의해 일시 중지되었습니다.' };
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
    case 'error':
      return { kind: 'error', detail: String(d.detail ?? d.error ?? 'unknown error') };
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
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const f of frames) {
          const ev = frameToChatEvent(f.event, f.data);
          if (ev) {
            yield ev;
            if (ev.kind === 'end') return;
          }
        }
      }
      for (const f of parser.flush()) {
        const ev = frameToChatEvent(f.event, f.data);
        if (ev) yield ev;
      }
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
  ): Promise<{ text: string; tools: ToolEvent[]; error?: string; executionIoId?: number }> {
    let text = '';
    let summary = '';
    const tools: ToolEvent[] = [];
    let error: string | undefined;
    let executionIoId: number | undefined;
    for await (const e of this.stream(req, signal)) {
      onEvent?.(e);
      if (e.kind === 'text') text += e.content;
      else if (e.kind === 'summary') summary = e.text;
      else if (e.kind === 'tool') tools.push(e.event);
      else if (e.kind === 'execution_io') executionIoId = e.executionIoId;
      else if (e.kind === 'error') error = e.detail;
    }
    return { text: text || summary, tools, error, executionIoId };
  }
}
