import React from 'react';
import { xgen, copyText } from '../bridge';
import { CopyIcon, RefreshIcon } from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';
import { useLoader, fmtWhen, StateNote } from './agent-viewer-shared';
import { useViewerScroll, useViewerState } from './agent-viewer-state';
import { connectedToolGroups, fmtDuration, traceStatus } from './agent-inspector-model';

export const AgentOverview: React.FC<{
  workflowId: string;
  onNavigate: (sub: AgentViewerSub) => void;
  onOpenTrace: (traceId: string) => void;
}> = ({ workflowId, onNavigate, onOpenTrace }) => {
  const basic = useLoader(() => xgen.agentData.basicInfo(workflowId), [workflowId]);
  const memory = useLoader(() => xgen.agentData.memoryList(workflowId), [workflowId]);
  const tasks = useLoader(() => xgen.agentData.tasksList(workflowId), [workflowId]);
  const tools = useLoader(() => xgen.agentData.toolsList(workflowId), [workflowId]);
  const artifacts = useLoader(() => xgen.artifacts.list(workflowId), [workflowId]);
  const recent = useLoader(() => xgen.agentData.traceList(workflowId, 1, 5), [workflowId]);
  const [promptOpen, setPromptOpen] = useViewerState('overview.prompt', false);
  const [raw, setRaw] = useViewerState('overview.raw', false);
  const loaders = [basic, memory, tasks, tools, artifacts, recent];
  const loading = loaders.some((loader) => loader.loading);
  const scroll = useViewerScroll('overview.scroll', !loading);
  const surface = basic.data?.surfaces?.connector;
  const available = !!surface && surface.available !== false;
  const connected = connectedToolGroups(surface).reduce(
    (sum, group) => sum + group.tools.length,
    0,
  );
  const count = (loading: boolean, error: string | null, value: number | undefined) =>
    loading ? '…' : error || value === undefined ? '확인 불가' : value.toLocaleString();
  const metrics: {
    sub: AgentViewerSub;
    label: string;
    value: string;
    note: string;
    error?: string | null;
  }[] = [
    {
      sub: 'memory',
      label: '메모리',
      value: count(memory.loading, memory.error, memory.data?.files.length),
      note: '대화하며 쌓인 기억',
      error: memory.error,
    },
    {
      sub: 'tasks',
      label: '작업',
      value: count(
        tasks.loading,
        tasks.error,
        tasks.data
          ? (tasks.data.total ?? tasks.data.tasks.length) + (tasks.data.jobs?.length ?? 0)
          : undefined,
      ),
      note: '백그라운드 · 예약 작업',
      error: tasks.error,
    },
    {
      sub: 'tools',
      label: '연결된 도구',
      value: count(basic.loading, basic.error, available ? connected : undefined),
      note: tools.loading
        ? '제작한 도구 확인 중…'
        : tools.error
          ? '제작한 도구 확인 불가'
          : `제작한 도구 ${tools.data?.tools.length ?? 0}개`,
      error: basic.error || tools.error,
    },
    {
      sub: 'artifacts',
      label: '아티팩트',
      value: count(artifacts.loading, artifacts.error, artifacts.data?.artifacts.length),
      note: '에이전트가 만든 결과물',
      error: artifacts.error,
    },
  ];

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar inspector-toolbar">
        <div>
          <strong>에이전트 개요</strong>
          <span>구성과 최근 활동을 한눈에 확인하세요.</span>
        </div>
        <button
          className="viewer-btn"
          disabled={loading}
          onClick={() => loaders.forEach((loader) => loader.reload())}
        >
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      <div className="viewer-scroll overview-scroll" {...scroll}>
        <div className="overview-content">
          <section className="overview-model" aria-label="모델 정보">
            <div>
              <span className="inspector-eyebrow">실행 모델</span>
              <h2>{basic.loading ? '불러오는 중…' : basic.data?.model || '모델 정보 없음'}</h2>
              <span className="inspector-muted">{basic.data?.provider || '제공자 정보 없음'}</span>
            </div>
            <span className="viewer-badge blue">데스크톱 에이전트</span>
          </section>
          {basic.error && (
            <div className="inspector-notice" role="alert">
              모델 정보를 불러오지 못했습니다: {basic.error}
            </div>
          )}
          {!!basic.data?.errors?.length && (
            <div className="inspector-notice">
              일부 구성을 확인하지 못했습니다: {basic.data.errors.join(' · ')}
            </div>
          )}
          <div className="overview-metrics">
            {metrics.map((metric) => (
              <button
                key={metric.sub}
                className="overview-metric"
                onClick={() => onNavigate(metric.sub)}
                aria-label={`${metric.label} 상세 보기`}
                title={metric.error || undefined}
              >
                <span>
                  {metric.label}
                  <span aria-hidden="true">↗</span>
                </span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
                {metric.error && (
                  <small className="inspector-error">일부 정보를 불러오지 못했습니다</small>
                )}
              </button>
            ))}
          </div>
          <section className="overview-section">
            <div className="inspector-section-head">
              <div>
                <h2>최근 실행</h2>
                <span>최근 5개 실행의 상태와 소요 시간</span>
              </div>
              <button className="viewer-btn sm" onClick={() => onNavigate('fulllog')}>
                실행 기록 보기
              </button>
            </div>
            <StateNote
              loading={recent.loading}
              error={recent.error}
              empty={!!recent.data && recent.data.traces.length === 0}
              emptyText="아직 실행 기록이 없습니다."
            />
            {recent.error && (
              <button className="viewer-btn sm" onClick={recent.reload}>
                다시 불러오기
              </button>
            )}
            {recent.data?.traces.slice(0, 5).map((trace) => {
              const status = traceStatus(trace);
              return (
                <button
                  key={trace.trace_id}
                  className="overview-execution"
                  onClick={() => onOpenTrace(trace.trace_id)}
                >
                  <span className={`viewer-badge ${status.tone}`}>{status.label}</span>
                  <span className="overview-execution-title">
                    <strong>{trace.model_name || trace.provider || '에이전트 실행'}</strong>
                    <time>{fmtWhen(trace.created_at)}</time>
                  </span>
                  <span className="inspector-muted">{fmtDuration(trace.duration_ms)}</span>
                  <span aria-hidden="true">›</span>
                </button>
              );
            })}
          </section>
          <section className="overview-section overview-prompt">
            <button
              className="overview-disclosure"
              aria-expanded={promptOpen}
              onClick={() => setPromptOpen((open) => !open)}
            >
              <div>
                <h2>프롬프트 및 실행 지침</h2>
                <span>에이전트의 역할과 실행에 적용되는 지침을 확인합니다.</span>
              </div>
              <span aria-hidden="true">{promptOpen ? '−' : '+'}</span>
            </button>
            {promptOpen && (
              <div className="overview-prompt-body">
                <StateNote loading={basic.loading} error={basic.error} />
                {!basic.loading && !basic.error && !available && (
                  <div className="viewer-note">
                    {surface?.note || '이 서버는 데스크톱 실행 정보를 제공하지 않습니다.'}
                  </div>
                )}
                {available && (
                  <>
                    <div className="inspector-inline-actions">
                      <button className="viewer-btn sm" onClick={() => setRaw((value) => !value)}>
                        {raw ? '섹션 보기' : '원문 전체 보기'}
                      </button>
                      <button
                        className="viewer-btn sm"
                        onClick={() => void copyText(surface.prompt?.full_prompt ?? '')}
                      >
                        <CopyIcon size={12} /> 프롬프트 복사
                      </button>
                    </div>
                    {raw ? (
                      <pre className="viewer-body">
                        {surface.prompt?.full_prompt || '(비어 있음)'}
                      </pre>
                    ) : (
                      (surface.prompt?.sections ?? []).map((section) => (
                        <details key={section.key} className="prompt-section">
                          <summary>
                            {section.title}
                            {section.dynamic && (
                              <span className="viewer-badge gray">실행 시 주입</span>
                            )}
                          </summary>
                          <div className="inspector-muted">{section.source}</div>
                          <pre className="viewer-body">
                            {section.text || section.template || '(비어 있음)'}
                          </pre>
                        </details>
                      ))
                    )}
                    {!raw && !surface.prompt?.sections?.length && (
                      <div className="viewer-note">표시할 프롬프트 섹션이 없습니다.</div>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
