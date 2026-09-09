/**
 * AgentViewer — 한 에이전트(workflow)의 **읽기 전용** 관측 뷰어.
 *
 * 채팅 헤더의 상세보기에서 새 탭으로 열린다. 일곱 하위 탭(기본정보/메모리/작업/
 * 도구/아티팩트/스토리지/전체로그)을 두고, 각 하위 뷰는 `window.xgen.agentData.*`(전부 GET)로
 * 서버 데이터를 읽어 상세 뷰처럼 보여 준다. 생성/삭제/변경은 없다.
 *
 * [기본정보] 는 **커넥터 표면만** 보여 준다 — 이 앱에서 도는 턴이 그 표면이기
 * 때문이다. 웹 화면은 반대로 web 표면만 보여 준다. 한 화면에서 둘을 토글하던
 * 예전 방식은 지금 보고 있는 게 어느 실행의 것인지 매번 확인해야 했다.
 *
 * 시각 언어는 커넥터 기존 것을 따른다(ToolLogModal 의 배지·펼침 행, --panel/
 * --border/--text-dim 토큰, --font-mono 코드 블록).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { BotIcon, CopyIcon, FolderIcon, FolderOpenIcon, DocIcon } from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';
import { ArtifactsView } from '../artifacts/ArtifactsView';
import { AgentMemoryView } from './AgentMemoryView';
import { errText, fmtWhen, useLoader, StateNote, ViewerEmpty } from './agent-viewer-shared';
import {
  AgentViewerStateContext,
  createAgentViewerState,
  useViewerState,
  useViewerScroll,
  type AgentViewerState,
} from './agent-viewer-state';
import type { Span, Trace, Task, Job, JobRun, ForgedTool, WsNode } from '@dex/protocol';

interface Props {
  workflowId: string;
  workflowName?: string;
  initialSub?: AgentViewerSub;
  navigation?: AgentViewerState;
  onSubChange?: (sub: AgentViewerSub) => void;
  /** 닫기 — 지금은 탭 X 가 담당하므로 미사용(호환용 optional). */
  onClose?: () => void;
}

/**
 * 하위 탭 — **웹 Agent 상세와 같은 순서**로 둔다.
 *
 * 같은 에이전트를 웹에서도 앱에서도 본다. 순서가 다르면 "도구 다음이 스토리지" 같은
 * 손버릇이 한쪽에서만 맞고, 옮겨 갈 때마다 눈으로 다시 찾게 된다.
 *
 * 웹에는 [진화 이력] 이 하나 더 있다(도구 다음, 전체로그 앞). 여기에는 그 화면이
 * 아직 없어서 자리를 비워 뒀을 뿐, **남은 것들의 상대 순서는 웹과 같다.**
 */
const SUBS: [AgentViewerSub, string][] = [
  ['basic', '기본정보'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['artifacts', '아티팩트'],
  ['storage', '스토리지'],
  ['fulllog', '전체로그'],
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

// ─────────────────────────────────────────────────────────────
// 전체로그 (fulllog)
// ─────────────────────────────────────────────────────────────
type Level = 'all' | 'tool' | 'llm' | 'rag' | 'error';
const LEVELS: [Level, string][] = [
  ['all', '전체'],
  ['tool', '도구'],
  ['llm', 'LLM'],
  ['rag', 'RAG'],
  ['error', '오류'],
];

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

function spanInLevel(s: Span, level: Level): boolean {
  if (level === 'all') return true;
  const t = s.span_type;
  if (level === 'tool') return t === 'tool_call' || t === 'tool_output';
  if (level === 'llm') return t === 'llm_call';
  if (level === 'rag') return t === 'rag_search';
  if (level === 'error') return t === 'error' || t === 'warning' || !!s.error_message;
  return true;
}

/** duration_ms → 사람이 읽는 짧은 표기(1000ms 이상은 초 단위, 소수 둘째 자리). */
function fmtDuration(ms?: number): string {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
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
      <button className="viewer-span-row" onClick={() => hasDetail && setOpen((o) => !o)}>
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

/** trace.status → 배지 톤. completed=초록, failed/error=빨강, running=노랑, 그 외=회색. */
function statusTone(status?: string): string {
  if (status === 'error' || status === 'failed') return 'red';
  if (status === 'running') return 'amber';
  if (status === 'completed') return 'emerald';
  return 'gray';
}

const TraceCard: React.FC<{ trace: Trace; spans: Span[]; level: Level }> = ({
  trace,
  spans,
  level,
}) => {
  const [open, setOpen] = useState(true);
  const ordered = useMemo(
    () => [...spans].sort((a, b) => (a.span_order ?? 0) - (b.span_order ?? 0)),
    [spans],
  );
  const shown = ordered.filter((s) => spanInLevel(s, level));
  return (
    <div className={`viewer-trace ${trace.error_message ? 'err' : ''}`}>
      <button className="viewer-trace-head" onClick={() => setOpen((o) => !o)}>
        <span className={`viewer-badge ${statusTone(trace.status)}`}>{trace.status || '—'}</span>
        <span className="viewer-trace-model">{trace.model_name || trace.provider || '실행'}</span>
        <span className="viewer-trace-meta">
          {typeof trace.total_tool_calls === 'number' ? `도구 ${trace.total_tool_calls}` : ''}
          {typeof trace.total_llm_calls === 'number' ? ` · LLM ${trace.total_llm_calls}` : ''}
          {typeof trace.duration_ms === 'number' ? ` · ${fmtDuration(trace.duration_ms)}` : ''}
        </span>
        <span className="viewer-spacer" />
        <span className="viewer-when">{fmtWhen(trace.created_at)}</span>
        <span className="viewer-caret">{open ? '−' : '+'}</span>
      </button>
      {trace.error_message && <div className="viewer-trace-err">{trace.error_message}</div>}
      {open && (
        <div className="viewer-span-list">
          {shown.length === 0 ? (
            <div className="viewer-note sm">이 필터에 해당하는 단계가 없습니다.</div>
          ) : (
            shown.map((s, i) => <SpanRow key={i} span={s} idx={i} />)
          )}
        </div>
      )}
    </div>
  );
};

const FullLogView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const [level, setLevel] = useViewerState<Level>('log.level', 'all');
  const loader = useLoader(async () => {
    const list = await xgen.agentData.traceList(workflowId);
    const traces = list.traces ?? [];
    const details = await Promise.all(
      traces.map((t) =>
        xgen.agentData.traceDetail(t.trace_id).catch(() => ({ trace: t, spans: [] as Span[] })),
      ),
    );
    return details.map((d, i) => ({ trace: d.trace ?? traces[i], spans: d.spans ?? [] }));
  }, [workflowId]);

  // 필터 칩 옆 개수 — 지금 이 실행 목록에 무엇이 얼마나 있는지 누르기 전에
  // 미리 보인다. 전체 스팬 대비 계산이라 트레이스가 아주 많지 않은 한 가볍다.
  const levelCounts = useMemo(() => {
    const counts: Record<Level, number> = { all: 0, tool: 0, llm: 0, rag: 0, error: 0 };
    for (const d of loader.data ?? []) {
      for (const s of d.spans) {
        counts.all += 1;
        for (const [lv] of LEVELS) {
          if (lv !== 'all' && spanInLevel(s, lv)) counts[lv] += 1;
        }
      }
    }
    return counts;
  }, [loader.data]);

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {LEVELS.map(([lv, label]) => (
            <button
              key={lv}
              className={`viewer-chip ${level === lv ? 'active' : ''}`}
              onClick={() => setLevel(lv)}
            >
              {label}
              {levelCounts[lv] > 0 && <span className="viewer-chip-count">{levelCounts[lv]}</span>}
            </button>
          ))}
        </div>
        <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
          새로고침
        </button>
      </div>
      <div className="viewer-scroll">
        <StateNote
          loading={loader.loading}
          error={loader.error}
          empty={!!loader.data && loader.data.length === 0}
          emptyText="실행 기록이 아직 없습니다 — 이 에이전트가 한 번이라도 실행되면 도구 호출·LLM 호출·오류를 여기서 실행 단위로 펼쳐 볼 수 있습니다."
        />
        {loader.data?.map((d) => (
          <TraceCard key={d.trace.trace_id} trace={d.trace} spans={d.spans} level={level} />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 작업 (tasks + jobs)
// ─────────────────────────────────────────────────────────────
const TasksView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.tasksList(workflowId), [workflowId]);
  const [selTask, setSelTask] = useViewerState<string | null>('tasks.selectedTask', null);
  const [output, setOutput] = useState<string>('');
  const [selJob, setSelJob] = useViewerState<string | null>('tasks.selectedJob', null);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [detailVersion, setDetailVersion] = useState(0);
  const openTask = (task: Task) => {
    setDetailVersion((value) => value + 1);
    setSelTask(task.task_id);
    setSelJob(null);
  };
  const openJob = (job: Job) => {
    setDetailVersion((value) => value + 1);
    setSelJob(job.session_id);
    setSelTask(null);
  };
  useEffect(() => {
    let alive = true;
    setOutput('');
    setRuns(null);
    setDetailErr(null);
    setDetailLoading(!!(selTask || selJob));
    const request = selTask
      ? xgen.agentData.taskOutput(workflowId, selTask).then((result) => {
          if (alive) setOutput(result.output || result.result || '(출력 없음)');
        })
      : selJob
        ? xgen.agentData.taskRuns(workflowId, selJob).then((result) => {
            if (alive) setRuns(result.runs ?? []);
          })
        : Promise.resolve();
    void request
      .catch((error) => {
        if (alive) setDetailErr(errText(error));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workflowId, selTask, selJob, detailVersion]);
  const listScroll = useViewerScroll('tasks.list', !!list.data);
  const detailScroll = useViewerScroll(
    `tasks.detail:${selTask || selJob}`,
    !!list.data && !detailLoading && !!(output || runs),
  );

  const tasks = list.data?.tasks ?? [];
  const jobs = list.data?.jobs ?? [];
  const nothing = !!list.data && tasks.length === 0 && jobs.length === 0;

  if (!list.data || nothing)
    return (
      <ViewerEmpty
        title={
          list.loading
            ? '작업을 불러오는 중…'
            : list.error
              ? '작업을 불러오지 못했습니다'
              : '아직 등록된 작업이 없습니다'
        }
        description={
          list.error ||
          (!list.loading
            ? '에이전트가 만든 백그라운드 작업과 예약 작업을 이곳에서 확인할 수 있습니다.'
            : undefined)
        }
        error={!!list.error}
        onRetry={list.loading ? undefined : list.reload}
      />
    );

  return (
    <div className="viewer-split">
      <div className="viewer-list" {...listScroll}>
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={nothing}
          emptyText="작업이 없습니다."
        />
        {tasks.length > 0 && <div className="viewer-list-section">작업</div>}
        {tasks.map((t) => (
          <button
            key={t.task_id}
            className={`viewer-listitem ${selTask === t.task_id ? 'active' : ''}`}
            onClick={() => void openTask(t)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${t.status === 'failed' ? 'red' : 'slate'}`}>
                {t.status || '—'}
              </span>
              {t.title || t.task_id}
            </div>
            <div className="viewer-listitem-sub">
              {t.kind || ''}
              {t.duration_s != null ? ` · ${t.duration_s}s` : ''}
              {t.created_at ? ` · ${fmtWhen(t.created_at)}` : ''}
            </div>
          </button>
        ))}
        {jobs.length > 0 && <div className="viewer-list-section">예약 작업</div>}
        {jobs.map((j) => (
          <button
            key={j.session_id}
            className={`viewer-listitem ${selJob === j.session_id ? 'active' : ''}`}
            onClick={() => void openJob(j)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${j.status === 'active' ? 'emerald' : 'gray'}`}>
                {j.status || '—'}
              </span>
              {j.name || j.session_id}
            </div>
            <div className="viewer-listitem-sub">
              {j.schedule_type || ''}
              {j.cron_expression ? ` · ${j.cron_expression}` : ''}
              {typeof j.total_executions === 'number' ? ` · ${j.total_executions}회` : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail" {...detailScroll}>
        {!selTask && !selJob && !detailLoading && (
          <div className="viewer-note">왼쪽에서 작업을 고르세요.</div>
        )}
        <StateNote loading={detailLoading} error={detailErr} />
        {selTask && output && (
          <>
            <div className="viewer-detail-head">
              <strong>작업 출력</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(output)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body">{output}</pre>
          </>
        )}
        {selJob && runs && (
          <>
            <div className="viewer-detail-head">
              <strong>실행 기록 ({runs.length})</strong>
            </div>
            {runs.length === 0 ? (
              <div className="viewer-note sm">실행 기록이 없습니다.</div>
            ) : (
              runs.map((r, i) => (
                <div key={i} className={`viewer-run ${r.error_message ? 'err' : ''}`}>
                  <div className="viewer-run-head">
                    <span className={`viewer-badge ${r.status === 'failed' ? 'red' : 'slate'}`}>
                      {r.status || '—'}
                    </span>
                    <span className="viewer-sub">
                      #{r.execution_number ?? i + 1}
                      {r.scheduled_time ? ` · ${fmtWhen(r.scheduled_time)}` : ''}
                      {r.duration_s != null ? ` · ${r.duration_s}s` : ''}
                    </span>
                  </div>
                  {r.error_message && <pre className="err">{r.error_message}</pre>}
                  {r.output && <pre className="viewer-body">{r.output}</pre>}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 도구 (forged tools)
// ─────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// 기본정보 — 이 앱에서 도는 턴의 **실제** 프롬프트 + 도구 표면
//
// 서버는 두 표면(web/connector)을 다 돌려주지만 여기서는 **connector 만** 쓴다.
// 이 창에서 시작한 턴이 그 표면으로 돌기 때문이다. 웹 화면은 반대로 web 만
// 보여 준다 — 한 화면에서 토글하던 예전 방식은 지금 보는 게 어느 실행의 것인지
// 매번 확인해야 했다.

const BasicInfoView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const loader = useLoader(() => xgen.agentData.basicInfo(workflowId), [workflowId]);
  const [tab, setTab] = useViewerState<'prompt' | 'tools'>('basic.tab', 'prompt');
  const [raw, setRaw] = useViewerState('basic.raw', false);

  const info = loader.data;
  const view = info?.surfaces?.connector ?? null;
  const groups = useMemo(() => (view?.provision?.stages ?? []).flatMap((st) => st.groups), [view]);
  const toolCount = useMemo(() => groups.reduce((n, g) => n + (g.tools?.length ?? 0), 0), [groups]);

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {(
            [
              ['prompt', '프롬프트'],
              ['tools', `연결된 도구${toolCount ? ` ${toolCount}` : ''}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`viewer-chip ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {tab === 'prompt' && view && (
            <>
              <button className="viewer-btn" onClick={() => setRaw((v) => !v)}>
                {raw ? '섹션 보기' : '원문 전체 보기'}
              </button>
              <button
                className="viewer-btn"
                onClick={() => void copyText(view.prompt?.full_prompt ?? '')}
              >
                <CopyIcon /> 복사
              </button>
            </>
          )}
          <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
            새로고침
          </button>
        </div>
      </div>
      <div className="viewer-scroll">
        <StateNote loading={loader.loading} error={loader.error} />
        {!loader.loading && !loader.error && !view && (
          <div className="viewer-note">
            이 서버는 커넥터 표면 정보를 제공하지 않습니다 (서버 업데이트가 필요합니다).
          </div>
        )}
        {view && (
          <>
            <div className="viewer-kv">
              <span className="viewer-label">실행</span>
              <span>
                {info?.provider ?? '?'} · {info?.model || '모델 미지정'}
              </span>
            </div>
            {(info?.errors?.length ?? 0) > 0 && (
              <div className="viewer-note err">
                일부 항목을 재구성하지 못했습니다: {info?.errors.join(' · ')}
              </div>
            )}

            {tab === 'prompt' ? (
              raw ? (
                <pre className="viewer-body">{view.prompt?.full_prompt || '(비어 있음)'}</pre>
              ) : (
                (view.prompt?.sections ?? []).map((sec) => (
                  <div key={sec.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{sec.title}</span>
                      {sec.dynamic && <span className="viewer-badge">실행 시 주입</span>}
                      <span className="viewer-listitem-sub">{sec.source}</span>
                    </div>
                    <pre className="viewer-body">{sec.text || sec.template || '(비어 있음)'}</pre>
                  </div>
                ))
              )
            ) : (
              <>
                {/* 노출 방식 캡션 — 웹 [기본정보]의 provision.mode_note 와 같은 자리
                    (도구 탭 안, 배지 옆의 작은 설명). 예전엔 이게 탭과 무관하게
                    화면 맨 위에 항상 떠서, 프롬프트를 보러 온 사람도 매번 지나쳐야
                    했다 — 실제로 쓰이는 곳(도구 노출 방식) 옆으로만 옮긴다. */}
                {view.provision?.mode_note && (
                  <div className="viewer-mode-note">
                    <span className="viewer-badge gray">{view.provision.exposure}</span>
                    <span>{view.provision.mode_note}</span>
                  </div>
                )}
                {groups.length === 0 && (
                  <div className="viewer-note">이 턴에 노출되는 도구가 없습니다.</div>
                )}
                {groups.map((g) => (
                  <div key={g.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{g.title}</span>
                      <span className="viewer-badge">{g.tools?.length ?? 0}</span>
                    </div>
                    {g.note && <div className="viewer-note">{g.note}</div>}
                    {g.disclosure && <div className="viewer-note">{g.disclosure}</div>}
                    {(g.tools ?? []).map((t) => (
                      <div key={t.name} className="viewer-kv">
                        <span className="viewer-tool-name">
                          <span className="viewer-path">{t.name}</span>
                          {/* 이 군체의 입구. 표시가 없으면 게이트웨이가 멤버 도구와
                              똑같이 보여, 어디서 시작해야 하는지 화면이 말해 주지 않는다.
                              웹 [기본정보] 와 같은 낱말을 쓴다 — 두 화면이 다른 말을 하면
                              같은 것을 두 개로 배우게 된다. */}
                          {t.gateway && <span className="viewer-badge gray">시작점</span>}
                        </span>
                        <span className="viewer-listitem-sub">{t.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {view.native_tools && (
                  <div className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">CLI 네이티브 도구</span>
                      <span className="viewer-badge">차단 {view.native_tools.removed.length}</span>
                    </div>
                    <div className="viewer-note">{view.native_tools.note}</div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const ToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.toolsList(workflowId), [workflowId]);
  const [sel, setSel] = useViewerState<string | null>('tools.selected', null);
  const [detail, setDetail] = useState<ForgedTool | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [detailVersion, setDetailVersion] = useState(0);
  const open = (tool: ForgedTool) => {
    setSel(tool.name);
    setDetailVersion((value) => value + 1);
  };
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailErr(null);
    setDetailLoading(!!sel);
    if (sel)
      void xgen.agentData
        .toolGet(workflowId, sel)
        .then((result) => {
          if (alive) setDetail(result);
        })
        .catch((error) => {
          if (alive) setDetailErr(errText(error));
        })
        .finally(() => {
          if (alive) setDetailLoading(false);
        });
    return () => {
      alive = false;
    };
  }, [workflowId, sel, detailVersion]);
  const listScroll = useViewerScroll('tools.list', !!list.data);
  const detailScroll = useViewerScroll(`tools.detail:${sel}`, !!list.data && !!detail);

  const tools = list.data?.tools ?? [];
  if (!list.data || tools.length === 0)
    return (
      <ViewerEmpty
        title={
          list.loading
            ? '도구를 불러오는 중…'
            : list.error
              ? '도구를 불러오지 못했습니다'
              : '아직 제작된 도구가 없습니다'
        }
        description={
          list.error ||
          (!list.loading
            ? '에이전트가 직접 제작한 도구가 표시됩니다. 연결된 도구는 기본정보에서 확인할 수 있습니다.'
            : undefined)
        }
        error={!!list.error}
        onRetry={list.loading ? undefined : list.reload}
      />
    );

  return (
    <div className="viewer-split">
      <div className="viewer-list" {...listScroll}>
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tools.length === 0}
          emptyText="제작된 도구가 없습니다."
        />
        {tools.map((t) => (
          <button
            key={t.name}
            className={`viewer-listitem ${sel === t.name ? 'active' : ''}`}
            onClick={() => void open(t)}
          >
            <div className="viewer-listitem-title">
              <span
                className={`viewer-badge ${
                  t.status === 'broken' ? 'red' : t.verified ? 'emerald' : 'amber'
                }`}
              >
                {t.status === 'broken' ? '고장' : t.verified ? '검증됨' : '미검증'}
              </span>
              {t.name}
            </div>
            <div className="viewer-listitem-sub">
              {t.runtime || ''}
              {typeof t.calls === 'number' ? ` · 호출 ${t.calls}` : ''}
              {!t.enabled ? ' · 비활성' : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail" {...detailScroll}>
        {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 도구를 고르세요.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detail && (
          <>
            <div className="viewer-detail-head">
              <strong>{detail.name}</strong>
              {detail.source && (
                <button
                  className="viewer-btn sm"
                  onClick={() => void copyText(detail.source || '')}
                >
                  <CopyIcon size={12} /> 코드 복사
                </button>
              )}
            </div>
            {detail.description && <div className="viewer-sub">{detail.description}</div>}
            <div className="viewer-kv">
              {detail.entrypoint && (
                <span>
                  <b>엔트리</b> {detail.entrypoint}
                </span>
              )}
              {detail.runtime && (
                <span>
                  <b>런타임</b> {detail.runtime}
                </span>
              )}
              {detail.env_keys && detail.env_keys.length > 0 && (
                <span>
                  <b>ENV</b> {detail.env_keys.join(', ')}
                </span>
              )}
              {detail.dependencies && detail.dependencies.length > 0 && (
                <span>
                  <b>의존성</b> {detail.dependencies.join(', ')}
                </span>
              )}
            </div>
            {detail.last_test_error && (
              <>
                <div className="viewer-label err">마지막 테스트 오류</div>
                <pre className="err">{detail.last_test_error}</pre>
              </>
            )}
            <div className="viewer-label">소스 코드</div>
            {detail.source_error ? (
              <div className="viewer-note err">{detail.source_error}</div>
            ) : (
              <pre className="viewer-body code">{detail.source || '(소스 없음)'}</pre>
            )}
            {detail.source_truncated && <div className="viewer-sub">※ 소스가 잘렸습니다.</div>}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 스토리지 (workspace)
// ─────────────────────────────────────────────────────────────
interface TreeNode {
  node: WsNode;
  children: TreeNode[];
}

const WORKSPACE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const WORKSPACE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function isWorkspaceImage(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && WORKSPACE_IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

function workspaceImageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return WORKSPACE_IMAGE_MIME[ext] ?? 'application/octet-stream';
}

function buildTree(files: WsNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  for (const n of files) byPath.set(n.path, { node: n, children: [] });
  const roots: TreeNode[] = [];
  for (const tn of byPath.values()) {
    const parent = tn.node.path.split('/').slice(0, -1).join('/');
    const p = parent && byPath.get(parent);
    if (p) p.children.push(tn);
    else roots.push(tn);
  }
  const sort = (arr: TreeNode[]): void => {
    arr.sort(
      (a, b) =>
        Number(b.node.is_dir) - Number(a.node.is_dir) || a.node.name.localeCompare(b.node.name),
    );
    for (const t of arr) sort(t.children);
  };
  sort(roots);
  return roots;
}

const TreeRow: React.FC<{
  tn: TreeNode;
  depth: number;
  selected: string | null;
  onFile: (n: WsNode) => void;
}> = ({ tn, depth, selected, onFile }) => {
  const [open, setOpen] = useState(depth < 1);
  const isDir = tn.node.is_dir;
  return (
    <>
      <button
        className={`viewer-tree-row ${selected === tn.node.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onFile(tn.node))}
      >
        <span className="viewer-tree-icon">
          {isDir ? (
            open ? (
              <FolderOpenIcon size={14} />
            ) : (
              <FolderIcon size={14} />
            )
          ) : (
            <DocIcon size={12} />
          )}
        </span>
        <span className="viewer-tree-name">{tn.node.name}</span>
        {!isDir && typeof tn.node.size === 'number' && (
          <span className="viewer-tree-size">{tn.node.size}B</span>
        )}
      </button>
      {isDir &&
        open &&
        tn.children.map((c) => (
          <TreeRow key={c.node.path} tn={c} depth={depth + 1} selected={selected} onFile={onFile} />
        ))}
    </>
  );
};

const StorageView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.workspaceTree(workflowId), [workflowId]);
  const [sel, setSel] = useViewerState<string | null>('storage.selected', null);
  const [content, setContent] = useState<string>('');
  const [imageUrl, setImageUrl] = useState<string>('');
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailNote, setDetailNote] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadId = useRef(0);
  const [detailVersion, setDetailVersion] = useState(0);

  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
  useEffect(
    () => () => {
      // 언마운트 뒤 끝난 요청이 Blob URL을 만들거나 상태를 갱신하지 못하게 한다.
      loadId.current += 1;
    },
    [],
  );

  const openFile = useCallback(
    async (path: string) => {
      const requestId = ++loadId.current;
      setContent('');
      setImageUrl('');
      setDetailErr(null);
      setDetailNote(null);
      setDetailLoading(true);
      try {
        if (isWorkspaceImage(path)) {
          const file = await xgen.agentData.workspaceBinary(workflowId, path);
          if (requestId !== loadId.current) return;
          // Uint8Array 가 더 큰 버퍼 위의 뷰일 수 있다(IPC) — 선택한 파일 바이트만 담는다.
          const bytes = file.bytes;
          const buffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          setImageUrl(
            URL.createObjectURL(
              new Blob([buffer], { type: file.contentType || workspaceImageMime(path) }),
            ),
          );
        } else {
          const file = await xgen.agentData.workspaceFile(workflowId, path);
          if (requestId !== loadId.current) return;
          setContent(file.content);
        }
      } catch (e) {
        if (requestId !== loadId.current) return;
        // 서버는 바이너리에 415, 과대 파일에 413 을 준다 — 오류가 아니라 안내로.
        const msg = errText(e);
        if (/→ 415/.test(msg)) setDetailNote('미리보기할 수 없는 파일입니다(바이너리).');
        else if (/→ 413/.test(msg)) setDetailNote('파일이 너무 커서 미리보기할 수 없습니다.');
        else setDetailErr(msg);
      } finally {
        if (requestId === loadId.current) setDetailLoading(false);
      }
    },
    [workflowId],
  );

  useEffect(() => {
    if (sel) void openFile(sel);
    return () => {
      loadId.current += 1;
    };
  }, [sel, openFile, detailVersion]);
  const listScroll = useViewerScroll('storage.list', !!list.data);
  const detailScroll = useViewerScroll(
    `storage.detail:${sel}`,
    !!list.data && !detailLoading && !!(content || imageUrl),
  );

  const tree = useMemo(() => buildTree(list.data?.files ?? []), [list.data]);
  if (!list.data || tree.length === 0)
    return (
      <ViewerEmpty
        title={
          list.loading
            ? '파일을 불러오는 중…'
            : list.error
              ? '파일을 불러오지 못했습니다'
              : '아직 저장된 파일이 없습니다'
        }
        description={
          list.error ||
          (!list.loading
            ? '에이전트가 작업하며 저장한 파일을 이곳에서 확인할 수 있습니다.'
            : undefined)
        }
        error={!!list.error}
        onRetry={list.loading ? undefined : list.reload}
      />
    );

  return (
    <div className="viewer-split">
      <div className="viewer-list tree" {...listScroll}>
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tree.length === 0}
          emptyText="파일이 없습니다."
        />
        {tree.map((tn) => (
          <TreeRow
            key={tn.node.path}
            tn={tn}
            depth={0}
            selected={sel}
            onFile={(n) => {
              setSel(n.path);
              setDetailVersion((value) => value + 1);
            }}
          />
        ))}
      </div>
      <div className="viewer-detail" {...detailScroll}>
        {!sel && !detailLoading && <div className="viewer-note">파일을 고르면 미리보기합니다.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detailNote && <div className="viewer-note">{detailNote}</div>}
        {sel && imageUrl && (
          <>
            <div className="viewer-detail-head">
              <strong className="viewer-path">{sel}</strong>
            </div>
            <div className="viewer-image-preview">
              <img src={imageUrl} alt={sel.split('/').pop() ?? sel} />
            </div>
          </>
        )}
        {sel && content && (
          <>
            <div className="viewer-detail-head">
              <strong className="viewer-path">{sel}</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(content)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body code">{content}</pre>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
export const AgentViewer: React.FC<Props> = ({
  workflowId,
  workflowName,
  initialSub,
  navigation,
  onSubChange,
}) => {
  const [fallbackNavigation] = useState(createAgentViewerState);
  const [sub, setSub] = useState<AgentViewerSub>(initialSub ?? 'memory');
  useEffect(() => {
    setSub(initialSub ?? 'memory');
  }, [initialSub]);
  return (
    <AgentViewerStateContext.Provider value={navigation ?? fallbackNavigation}>
      <div className="agent-viewer">
        {/* 한 줄 헤더 — [아이콘 이름] ──────── [탭]. 닫기(X)는 탭에 이미 있으므로 생략. */}
        <div className="viewer-header">
          <div className="viewer-title">
            <BotIcon size={16} />
            <strong>{workflowName || '에이전트'}</strong>
          </div>
          <div className="viewer-subtabs" role="tablist">
            {SUBS.map(([s, label]) => (
              <button
                key={s}
                role="tab"
                aria-selected={sub === s}
                className={`viewer-subtab ${sub === s ? 'active' : ''}`}
                onClick={() => {
                  setSub(s);
                  onSubChange?.(s);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="viewer-content">
          {sub === 'basic' && <BasicInfoView workflowId={workflowId} />}
          {sub === 'fulllog' && <FullLogView workflowId={workflowId} />}
          {sub === 'memory' && <AgentMemoryView workflowId={workflowId} />}
          {sub === 'tasks' && <TasksView workflowId={workflowId} />}
          {sub === 'tools' && <ToolsView workflowId={workflowId} />}
          {sub === 'artifacts' && (
            <ArtifactsView workflowId={workflowId} workflowName={workflowName} />
          )}
          {sub === 'storage' && <StorageView workflowId={workflowId} />}
        </div>
      </div>
    </AgentViewerStateContext.Provider>
  );
};
