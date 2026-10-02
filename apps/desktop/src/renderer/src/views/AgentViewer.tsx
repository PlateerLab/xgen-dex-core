/** Read-only agent inspector. Persisted subtab keys remain compatible with saved layouts. */
import React, { useEffect, useMemo, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { BotIcon, CopyIcon } from '../brand/icons';
import { FileTree, type IdeFileEntry } from '@dex/ide';
import { useResolvedTheme } from '../ide/ide-sessions';
import { FileViewerPane, agentFileSource } from './FileViewerPane';
import type { AgentViewerSub } from './workspace-layout';
import { AppsView } from '../apps/AppsView';
import { AgentOverview } from './AgentOverview';
import { AgentExecutionView } from './AgentExecutionView';
import { AgentToolsView } from './AgentToolsView';
import { AgentMemoryView } from './AgentMemoryView';
import { errText, fmtWhen, useLoader, StateNote, ViewerEmpty } from './agent-viewer-shared';
import {
  AgentViewerStateContext,
  createAgentViewerState,
  useViewerState,
  useViewerScroll,
  type AgentViewerState,
} from './agent-viewer-state';
import type { Task, Job, JobRun } from '@dex/protocol';

interface Props {
  workflowId: string;
  workflowName?: string;
  initialSub?: AgentViewerSub;
  /** [앱] 하위 탭에서 고를 앱(폴더 이름) — [앱] 탭의 [열기] 가 넘긴다. */
  initialApp?: string;
  navigation?: AgentViewerState;
  onSubChange?: (sub: AgentViewerSub) => void;
  /** [앱] 하위 탭에서 고른 앱이 바뀌었다 — 탭이 적어 두었다가 다시 열 때 쓴다. */
  onAppChange?: (slug: string) => void;
  /** 닫기 — 지금은 탭 X 가 담당하므로 미사용(호환용 optional). */
  onClose?: () => void;
}

const SUBS: [AgentViewerSub, string][] = [
  ['basic', '개요'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['apps', '앱'],
  ['storage', '스토리지'],
  ['fulllog', '실행 기록'],
];

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

/**
 * [스토리지] — 왼쪽은 IDE 탐색기와 **같은 모양**(@dex/ide FileTree), 오른쪽은 [파일 저장소]·탐색기 탭과 **같은
 * 뷰어**(FileViewerPane). 예전에는 이 탭만 따로 만든 단순 목록과 글/그림 미리보기였다 — 문서·PDF·md·표는
 * "미리보기할 수 없는 파일" 로 끝났다(2026-10-02 사용자 보고).
 */
const StorageView: React.FC<{ workflowId: string; workflowName?: string }> = ({ workflowId, workflowName }) => {
  const list = useLoader(() => xgen.agentData.workspaceTree(workflowId), [workflowId]);
  const [sel, setSel] = useViewerState<string | null>('storage.selected', null);
  const theme = useResolvedTheme();
  const entries = useMemo<IdeFileEntry[]>(
    () =>
      (list.data?.files ?? []).map((f) => ({
        path: f.path,
        isDir: f.is_dir,
        size: f.size ?? undefined,
        modifiedAt: f.modified_at ?? undefined,
        originName: f.origin_name ?? undefined,
      })),
    [list.data],
  );
  const selected = sel ? (list.data?.files ?? []).find((f) => f.path === sel && !f.is_dir) : undefined;
  // 파일이 바뀌면(에이전트가 다시 썼다) 열쇠가 달라져 다시 읽는다.
  const sourceKey = selected ? `agent:${workflowId}:${selected.path}:${selected.modified_at ?? ''}:${selected.size ?? ''}` : '';
  const source = useMemo(
    () => (selected ? agentFileSource(workflowId, selected.path) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKey],
  );

  return (
    <div className="storage-split">
      <div className="storage-tree">
        <FileTree
          rootName={workflowName || '스토리지'}
          entries={entries}
          activePath={selected?.path ?? null}
          onOpen={(path) => setSel(path)}
          loading={list.loading && !list.data}
          error={list.error ? '파일을 불러오지 못했습니다.' : null}
          onRefresh={list.reload}
          emptyText="아직 저장된 파일이 없습니다."
          theme={theme}
          initialDepth={1}
        />
      </div>
      <div className="storage-detail">
        {selected && source ? (
          <FileViewerPane
            key={sourceKey}
            fileName={selected.name || selected.path.split('/').pop() || selected.path}
            rel={selected.path}
            source={source}
            sourceKey={sourceKey}
          />
        ) : (
          <div className="viewer-note storage-empty">파일을 고르면 미리보기합니다.</div>
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
  initialApp,
  navigation,
  onSubChange,
  onAppChange,
}) => {
  const [fallbackNavigation] = useState(createAgentViewerState);
  const [sub, setSub] = useState<AgentViewerSub>(initialSub ?? 'basic');
  useEffect(() => {
    setSub(initialSub ?? 'basic');
  }, [initialSub]);
  const state = navigation ?? fallbackNavigation;
  const navigate = (target: AgentViewerSub) => {
    setSub(target);
    onSubChange?.(target);
  };
  const navigateFromOverview = (target: AgentViewerSub) => {
    if (target === 'tools') state.values.set('tools.tab', 'connected');
    navigate(target);
  };
  const openTrace = (traceId: string) => {
    state.values.set('log.page', 1);
    state.values.set('log.query', '');
    state.values.set('log.status', 'all');
    state.values.set(`log.open:${traceId}`, true);
    state.values.set('log.focusedTrace', traceId);
    state.scroll.set('log.scroll:1', 0);
    navigate('fulllog');
  };
  return (
    <AgentViewerStateContext.Provider value={state}>
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
                onClick={() => navigate(s)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="viewer-content">
          {sub === 'basic' && (
            <AgentOverview
              workflowId={workflowId}
              onNavigate={navigateFromOverview}
              onOpenTrace={openTrace}
            />
          )}
          {sub === 'fulllog' && <AgentExecutionView workflowId={workflowId} />}
          {sub === 'memory' && <AgentMemoryView workflowId={workflowId} />}
          {sub === 'tasks' && <TasksView workflowId={workflowId} />}
          {sub === 'tools' && <AgentToolsView workflowId={workflowId} />}
          {sub === 'apps' && (
            <AppsView
              workflowId={workflowId}
              workflowName={workflowName}
              focusSlug={initialApp}
              onSlugChange={onAppChange}
            />
          )}
          {sub === 'storage' && <StorageView workflowId={workflowId} workflowName={workflowName} />}
        </div>
      </div>
    </AgentViewerStateContext.Provider>
  );
};
