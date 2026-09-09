import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Span, Trace } from '@dex/protocol';
import { xgen } from '../bridge';
import { RefreshIcon } from '../brand/icons';
import { useLoader, fmtWhen, ViewerEmpty, StateNote } from './agent-viewer-shared';
import { useViewerState, useViewerScroll } from './agent-viewer-state';
import {
  filterTraces,
  fmtDuration,
  spanInLevel,
  traceHasError,
  tracePageInfo,
  traceStatus,
  type SpanLevel,
  type TraceStatusFilter,
} from './agent-inspector-model';

const PAGE_SIZE = 20;
const LEVELS: [SpanLevel, string][] = [
  ['all', '전체'],
  ['tool', '도구'],
  ['llm', 'LLM'],
  ['rag', 'RAG'],
  ['error', '오류'],
];
/** 임의 값 → 사람이 읽는 문자열(문자열은 그대로, 그 외엔 예쁜 JSON). */
function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** span_type → 배지 톤(색). */
function spanTone(t: string): string {
  if (t === 'tool_call' || t === 'tool_output') return 'blue';
  if (t === 'error') return 'red';
  if (t === 'warning') return 'amber';
  if (t === 'llm_call') return 'slate';
  if (t === 'rag_search') return 'emerald';
  if (t === 'agent_input' || t === 'agent_output') return 'violet';
  return 'gray';
}

// 인자/결과/메타가 길면 펼침 행 하나가 화면 전체를 삼킨다 — 접었다가
// [더보기]로 편다. 서버가 도구 결과를 통째로 pretty-print 해서 내려주므로
// (예: 큰 파일 읽기, RAG 검색 hits) 이 캡이 없으면 스크롤이 실질적으로
// 못 쓰는 길이가 되는 사례가 실제로 있었다.
const TEXT_LIMIT = 800;

const ExpandableText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > TEXT_LIMIT;
  const shown = open || !long ? text : text.slice(0, TEXT_LIMIT) + '…';
  return (
    <div>
      <pre className={`viewer-body${className ? ` ${className}` : ''}`}>{shown}</pre>
      {long && (
        <button className="viewer-btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? '접기' : `더보기 (${text.length.toLocaleString()}자)`}
        </button>
      )}
    </div>
  );
};

const SpanRow: React.FC<{ span: Span; idx: number }> = ({ span, idx }) => {
  const [open, setOpen] = useState(false);
  const input = pretty(span.input_data);
  const output = pretty(span.output_data);
  // 서버는 metadata 를 JSON **문자열**로 내려준다(컬럼이 text) — 한 번 파싱해
  // 보고, 아니면 원문 그대로 보여 준다.
  const meta = useMemo(() => {
    const raw = span.metadata;
    if (raw === undefined || raw === null || raw === '') return '';
    if (typeof raw === 'string') {
      try {
        return pretty(JSON.parse(raw));
      } catch {
        return raw;
      }
    }
    return pretty(raw);
  }, [span.metadata]);
  const hasDetail = !!(input || output || meta || span.error_message);
  return (
    <div className={`viewer-span ${span.error_message ? 'err' : ''}`}>
      <button
        className="viewer-span-row"
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((o) => !o)}
      >
        <span className="viewer-idx">{idx + 1}</span>
        <span className={`viewer-badge ${spanTone(span.span_type)}`}>{span.span_type}</span>
        {span.tool_name && (
          <span className="viewer-span-name" title={span.tool_name}>
            {span.tool_name}
          </span>
        )}
        <span className="viewer-spacer" />
        {typeof span.duration_ms === 'number' && (
          <span className="viewer-ms">{fmtDuration(span.duration_ms)}</span>
        )}
        {hasDetail && <span className="viewer-caret">{open ? '−' : '+'}</span>}
      </button>
      {open && hasDetail && (
        <div className="viewer-span-detail">
          {span.error_message && (
            <>
              <div className="viewer-label err">오류</div>
              <ExpandableText className="err" text={span.error_message} />
            </>
          )}
          {input && (
            <>
              <div className="viewer-label">입력 (args)</div>
              <ExpandableText text={input} />
            </>
          )}
          {output && (
            <>
              <div className="viewer-label">출력 (result)</div>
              <ExpandableText text={output} />
            </>
          )}
          {meta && (
            <>
              <div className="viewer-label">부가 정보</div>
              <ExpandableText text={meta} />
            </>
          )}
        </div>
      )}
    </div>
  );
};

const TraceCard: React.FC<{ trace: Trace; focused: boolean; onFocused: () => void }> = ({
  trace,
  focused,
  onFocused,
}) => {
  const head = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useViewerState(`log.open:${trace.trace_id}`, false);
  const [level, setLevel] = useViewerState<SpanLevel>(`log.level:${trace.trace_id}`, 'all');
  // Collapsed rows only use the list summary. Details are requested on expansion.
  const detail = useLoader(
    () => (open ? xgen.agentData.traceDetail(trace.trace_id) : Promise.resolve(null)),
    [trace.trace_id, open],
  );
  const ordered = useMemo(
    () => [...(detail.data?.spans ?? [])].sort((a, b) => (a.span_order ?? 0) - (b.span_order ?? 0)),
    [detail.data],
  );
  const shown = ordered
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => spanInLevel(span, level));
  const status = traceStatus(trace);
  useEffect(() => {
    if (!focused || !open || detail.loading) return;
    head.current?.scrollIntoView({ block: 'start' });
    head.current?.focus({ preventScroll: true });
    onFocused();
  }, [focused, open, detail.loading, onFocused]);
  return (
    <article
      className={`viewer-trace execution-card${traceHasError(trace) ? ' err' : ''}`}
      data-trace-id={trace.trace_id}
    >
      <button
        ref={head}
        className="execution-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`viewer-badge ${status.tone}`}>{status.label}</span>
        <span className="execution-title">
          <strong>{trace.model_name || trace.provider || '에이전트 실행'}</strong>
          <span>
            {fmtWhen(trace.created_at)}
            {trace.provider ? ` · ${trace.provider}` : ''}
          </span>
        </span>
        <span className="execution-counts">
          <span>
            도구 {trace.total_tool_calls ?? '—'} · LLM {trace.total_llm_calls ?? '—'}
          </span>
          <span>
            {trace.total_spans ?? '—'}단계 · {fmtDuration(trace.duration_ms)}
          </span>
        </span>
        <span className="viewer-caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {trace.error_message && (
        <div className="execution-error" title={trace.error_message}>
          {trace.error_message}
        </div>
      )}
      {open && (
        <div className="execution-detail">
          <div className="execution-id">
            실행 ID <code>{trace.trace_id}</code>
          </div>
          <StateNote loading={detail.loading} error={detail.error} />
          {detail.error && (
            <button className="viewer-btn sm" onClick={detail.reload}>
              상세 다시 불러오기
            </button>
          )}
          {detail.data && (
            <>
              <div className="execution-step-filters" aria-label="실행 단계 필터">
                {LEVELS.map(([key, label]) => (
                  <button
                    key={key}
                    className={`viewer-chip ${key === level ? 'active' : ''}`}
                    aria-pressed={key === level}
                    onClick={() => setLevel(key)}
                  >
                    {label}
                    <span className="viewer-chip-count">
                      {ordered.filter((span) => spanInLevel(span, key)).length}
                    </span>
                  </button>
                ))}
              </div>
              {shown.length ? (
                <div className="viewer-span-list">
                  {shown.map(({ span, index }) => (
                    <SpanRow key={index} span={span} idx={index} />
                  ))}
                </div>
              ) : (
                <div className="viewer-note">
                  {ordered.length
                    ? '이 필터에 해당하는 단계가 없습니다.'
                    : '저장된 실행 단계가 없습니다.'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
};

export const AgentExecutionView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const [page, setPage] = useViewerState('log.page', 1);
  const [status, setStatus] = useViewerState<TraceStatusFilter>('log.status', 'all');
  const [query, setQuery] = useViewerState('log.query', '');
  const [focusedTrace, setFocusedTrace] = useViewerState<string | null>('log.focusedTrace', null);
  const loader = useLoader(
    () => xgen.agentData.traceList(workflowId, page, PAGE_SIZE),
    [workflowId, page],
  );
  const scroll = useViewerScroll(`log.scroll:${page}`, !!loader.data);
  const traces = loader.data?.traces ?? [];
  const shown = filterTraces(traces, status, query);
  const pagination = tracePageInfo(loader.data ?? { traces: [] }, page, PAGE_SIZE);
  const reset = () => {
    setStatus('all');
    setQuery('');
  };

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar inspector-toolbar">
        <div>
          <strong>실행 기록</strong>
          <span>실행을 펼쳐 도구 호출과 응답을 확인하세요.</span>
        </div>
        <button className="viewer-btn" disabled={loader.loading} onClick={loader.reload}>
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      <div className="execution-controls">
        <div className="viewer-filters">
          {(
            [
              ['all', '전체'],
              ['error', '실패·부분 실패'],
              ['running', '실행 중'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`viewer-chip ${status === key ? 'active' : ''}`}
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="viewer-search"
          aria-label="현재 페이지 실행 검색"
          placeholder="모델, 실행 ID, 오류 검색…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="inspector-muted">
          검색·필터는 현재 페이지에 적용{loader.data ? ` · ${shown.length}/${traces.length}개` : ''}
        </span>
      </div>
      <div className="viewer-scroll execution-scroll" {...scroll}>
        {loader.loading || loader.error || !traces.length ? (
          <ViewerEmpty
            title={
              loader.loading
                ? '실행 기록을 불러오는 중…'
                : loader.error
                  ? '실행 기록을 불러오지 못했습니다'
                  : page > 1
                    ? '이 페이지에 실행 기록이 없습니다'
                    : '아직 실행 기록이 없습니다'
            }
            description={
              loader.error ||
              (loader.loading ? undefined : '에이전트를 실행하면 상태와 상세 단계가 표시됩니다.')
            }
            error={!!loader.error}
            onRetry={loader.loading ? undefined : loader.reload}
          />
        ) : shown.length ? (
          <div className="execution-list">
            {shown.map((trace) => (
              <TraceCard
                key={trace.trace_id}
                trace={trace}
                focused={focusedTrace === trace.trace_id}
                onFocused={() => setFocusedTrace(null)}
              />
            ))}
          </div>
        ) : (
          <div className="execution-no-results">
            <ViewerEmpty
              title="조건에 맞는 실행이 없습니다"
              description="현재 페이지의 다른 상태를 확인하거나 다음 페이지를 살펴보세요."
            />
            <button className="viewer-btn" onClick={reset}>
              검색·필터 초기화
            </button>
          </div>
        )}
      </div>
      <div className="execution-pagination">
        <span>
          {loader.data
            ? `${pagination.start}–${pagination.end}개${pagination.total !== null ? ` / 전체 ${pagination.total.toLocaleString()}개` : ''}`
            : '페이지당 20개'}
        </span>
        <div>
          <button
            className="viewer-btn"
            disabled={loader.loading || page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            이전 페이지
          </button>
          <span aria-live="polite">{page} 페이지</span>
          <button
            className="viewer-btn"
            disabled={loader.loading || !loader.data || !pagination.hasNext}
            onClick={() => setPage((value) => value + 1)}
          >
            다음 페이지
          </button>
        </div>
      </div>
    </div>
  );
};
