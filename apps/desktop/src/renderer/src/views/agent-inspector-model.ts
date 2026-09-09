import type { BasicInfoGroup, BasicInfoSurface, Span, Trace, TraceListResult } from '@dex/protocol';

export type TraceStatusFilter = 'all' | 'error' | 'running';
export type SpanLevel = 'all' | 'tool' | 'llm' | 'rag' | 'error';

export function traceHasError(trace: Trace) {
  return !!trace.error_message || ['failed', 'error', 'partial'].includes(trace.status ?? '');
}

export function traceStatus(trace: Trace): { label: string; tone: string } {
  if (trace.status === 'partial') return { label: '부분 실패', tone: 'amber' };
  if (traceHasError(trace)) return { label: '실패', tone: 'red' };
  if (trace.status === 'completed') return { label: '완료', tone: 'emerald' };
  if (trace.status === 'running') return { label: '실행 중', tone: 'amber' };
  if (trace.status === 'cancelled') return { label: '취소', tone: 'gray' };
  return { label: trace.status || '상태 미상', tone: 'gray' };
}

export function filterTraces(traces: Trace[], status: TraceStatusFilter, query: string) {
  const text = query.trim().toLowerCase();
  return traces.filter((trace) => {
    if (status === 'error' && !traceHasError(trace)) return false;
    if (status === 'running' && trace.status !== 'running') return false;
    return (
      !text ||
      [trace.trace_id, trace.model_name, trace.provider, trace.error_message].some((value) =>
        value?.toLowerCase().includes(text),
      )
    );
  });
}

export function spanInLevel(span: Span, level: SpanLevel) {
  if (level === 'all') return true;
  if (level === 'tool') return span.span_type === 'tool_call' || span.span_type === 'tool_output';
  if (level === 'llm') return span.span_type === 'llm_call';
  if (level === 'rag') return span.span_type === 'rag_search';
  return span.span_type === 'error' || span.span_type === 'warning' || !!span.error_message;
}

export function tracePageInfo(
  result: TraceListResult,
  requestedPage: number,
  requestedSize: number,
) {
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const page = positive(result.page, requestedPage);
  const size = positive(result.page_size, requestedSize);
  const total =
    typeof result.total === 'number' && Number.isFinite(result.total) && result.total >= 0
      ? result.total
      : null;
  const count = result.traces.length;
  return {
    page,
    size,
    total,
    start: count ? (page - 1) * size + 1 : 0,
    end: count ? (page - 1) * size + count : 0,
    hasNext: total === null ? count >= size : page * size < total,
  };
}

/** Connector only. Deduplicate repeated stage entries and support older flat tool responses. */
export function connectedToolGroups(surface?: BasicInfoSurface | null): BasicInfoGroup[] {
  if (!surface || surface.available === false) return [];
  const groups = (surface.provision?.stages ?? []).flatMap((stage) =>
    stage.groups.map((group) => ({ ...group, key: `${stage.key}:${group.key}` })),
  );
  const source = groups.length
    ? groups
    : [{ key: 'connected', title: '연결된 도구', kind: 'tools', tools: surface.tools ?? [] }];
  const seen = new Set<string>();
  return source
    .map((group) => ({
      ...group,
      tools: (group.tools ?? []).filter((tool) => {
        if (seen.has(tool.name)) return false;
        seen.add(tool.name);
        return true;
      }),
    }))
    .filter((group) => group.tools.length > 0);
}

export function fmtDuration(ms?: number) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}초`;
}
