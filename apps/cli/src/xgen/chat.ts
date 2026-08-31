import { HttpClient } from './client';
import { SseParser } from './sse';
import type { ChatEvent, ChatRequest, ToolEvent } from './types';

function requestBody(request: ChatRequest): Record<string, unknown> {
  return {
    workflow_name: request.workflowName,
    workflow_id: request.workflowId,
    input_data: request.input,
    interaction_id: request.interactionId,
    selected_collections: request.selectedCollections ?? [],
    selected_files: request.selectedFiles ?? [],
    include_logs: request.includeLogs ?? true,
    include_node_status: request.includeNodeStatus ?? true,
    include_tool_events: request.includeToolEvents ?? true,
    response_format: 'stream',
    client_surface: 'connector',
    ...(request.executionTarget ? { execution_target: request.executionTarget } : {}),
  };
}

function toolEvent(data: Record<string, unknown>): ToolEvent {
  return {
    eventType: String(data.event_type ?? data.type ?? 'tool'),
    toolName: data.tool_name as string | undefined,
    toolInput: data.tool_input,
    result: data.result as string | undefined,
    resultLength: data.result_length as number | undefined,
    error: data.error as string | undefined,
    citations: data.citations as ToolEvent['citations'],
    runId: data.run_id as string | undefined,
    indicator: data.indicator,
    durationMs: data.duration_ms as number | undefined,
    timestamp: data.timestamp as string | undefined,
  };
}

function objectData(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function frameToChatEvent(frameEvent: string | undefined, raw: string): ChatEvent | null {
  const data = objectData(raw);
  switch (frameEvent) {
    case 'tool':
      return data ? { kind: 'tool', event: toolEvent(data) } : null;
    case 'node_status':
      return data
        ? { kind: 'node_status', event: { nodeId: String(data.node_id ?? ''), status: String(data.status ?? ''), ...data } }
        : null;
    case 'log':
      return { kind: 'log', data: data ?? raw };
    case 'execution_io':
      return data ? { kind: 'execution_io', executionIoId: Number(data.execution_io_id ?? 0) } : null;
    case 'download_artifact':
      return data ? { kind: 'download', data } : null;
    case 'a2ui_command':
      return data ? { kind: 'ui_command', surface: 'a2ui', command: data } : null;
    case 'floui_command':
      return data ? { kind: 'ui_command', surface: 'floui', command: data } : null;
    case 'quota_warning':
      return data ? { kind: 'quota', level: 'warning', data } : null;
    case 'quota_exceeded':
      return data ? { kind: 'quota', level: 'exceeded', data } : null;
    case 'execution_suspended':
      return { kind: 'error', detail: '워크플로우가 관리자에 의해 일시 중지되었습니다.' };
    case undefined:
    case '':
    case 'message':
      break;
    default:
      return null;
  }
  if (!data) return null;
  switch (data.type) {
    case 'data':
      return { kind: 'text', content: String(data.content ?? '') };
    case 'summary': {
      const summary = (data.data as Record<string, unknown>) ?? {};
      const outputs = (summary.outputs as unknown[]) ?? [];
      return { kind: 'summary', text: outputs.map(String).join(''), data: summary };
    }
    case 'end':
      return { kind: 'end' };
    case 'error':
      return { kind: 'error', detail: String(data.detail ?? data.error ?? 'unknown error') };
    case 'tool_call':
    case 'tool_start':
    case 'tool_result':
    case 'tool_error':
      return { kind: 'tool', event: toolEvent(data) };
    default:
      return null;
  }
}

export class ChatApi {
  constructor(private readonly http: HttpClient) {}

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent, void, void> {
    const response = await this.http.stream(
      '/api/agentflow/execute/based-id/stream',
      requestBody(request),
      signal,
    );
    if (!response.body) throw new Error('스트림 응답 본문이 없습니다.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = frameToChatEvent(frame.event, frame.data);
          if (!event) continue;
          yield event;
          if (event.kind === 'end') return;
        }
      }
      for (const frame of parser.flush()) {
        const event = frameToChatEvent(frame.event, frame.data);
        if (event) yield event;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already own or release the reader after cancellation.
      }
    }
  }
}
