/**
 * Agent inspector. Persisted subtab keys remain compatible with saved layouts.
 *
 * 2026-10-15: [개요] 오른쪽에 [워크플로우] 탭: 웹 캔버스 편집기를 그대로 띄운다(AgentWorkflowCanvas). 캔버스는
 * 이제 에이전트 상세의 하위 화면이다. Geny 가 아닌 에이전트(Agent Xgen · 일반 워크플로우)는 탭이 [개요 /
 * 워크플로우] 둘이다(메모리 · 작업 · 도구 · 앱 · 스토리지 · 실행 기록은 Agent Geny 의 것). Geny 인지는 저장된
 * 워크플로우의 노드로 정한다. 이름은 머리의 이름을 두 번 눌러 바꾼다(주인만, 고정본 제외). 웹 에이전트 상세와 같다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { BackIcon, BotIcon, CopyIcon } from '../brand/icons';
import { FileTree, type IdeFileEntry } from '@dex/ide';
import { useResolvedTheme } from '../ide/ide-sessions';
import { FileViewerPane, agentFileSource } from './FileViewerPane';
import type { AgentViewerSub } from './workspace-layout';
import { AppsView } from '../apps/AppsView';
import { AgentOverview } from './AgentOverview';
import { WorkflowOverview } from './WorkflowOverview';
import { AgentWorkflowCanvas } from './AgentWorkflowCanvas';
import { workflowHasGeny } from '@dex/protocol/agent-workflow';
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
  /**
   * ← : 이 상세를 연 탭(대개 채팅)으로 돌아간다(2026-10-19). 연 탭이 남아 있을 때만 주어지고, 없으면
   * 머리에 ← 가 없다. 상세 탭은 닫지 않는다(탭의 X 가 닫는다).
   */
  onReturn?: () => void;
  /** ← 의 이름(툴팁 · 읽어 주기). 연 탭이 채팅이면 '채팅으로'. */
  returnLabel?: string;
  /** 로그인한 사람. 주인이면 머리의 이름을 두 번 눌러 바꿀 수 있다. */
  currentUserId?: string | number | null;
  /** 이름을 바꿨다: 탭 제목 등 같은 에이전트를 가리키는 곳을 새 이름으로. */
  onRenamed?: (name: string) => void;
}

const SUBS: [AgentViewerSub, string][] = [
  ['basic', '개요'],
  ['workflow', '워크플로우'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['apps', '앱'],
  ['storage', '스토리지'],
  ['fulllog', '실행 기록'],
];
/** Geny 가 아닌 에이전트에도 있는 탭. */
const GENERAL_SUBS: ReadonlySet<AgentViewerSub> = new Set(['basic', 'workflow']);

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
  onReturn,
  returnLabel = '돌아가기',
  currentUserId,
  onRenamed,
}) => {
  const [fallbackNavigation] = useState(createAgentViewerState);
  const [sub, setSub] = useState<AgentViewerSub>(initialSub ?? 'basic');
  // 저장된 워크플로우: Geny 인지(탭), Geny 가 아닐 때의 [개요], 주인 · 고정본(이름 바꾸기)을 여기서 정한다.
  // 못 읽으면 예전처럼 Geny 로 본다(탭이 사라지는 것보다 낫다).
  const workflow = useLoader(() => xgen.agentData.workflow(workflowId), [workflowId]);
  const geny = workflow.data ? workflowHasGeny(workflow.data) : true;
  const subs = useMemo(() => SUBS.filter(([key]) => geny || GENERAL_SUBS.has(key)), [geny]);
  const shown: AgentViewerSub = geny || GENERAL_SUBS.has(sub) ? sub : 'basic';
  // 캔버스는 한 번 연 뒤로는 하위 탭을 옮겨도 지우지 않고 숨긴다. 지우면 저장하지 않은 편집이 사라진다.
  const [canvasOpened, setCanvasOpened] = useState(shown === 'workflow');
  useEffect(() => {
    if (shown === 'workflow') setCanvasOpened(true);
  }, [shown]);
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
  // ── 이름 바꾸기: 머리의 이름을 두 번 누르면 입력칸. Enter · 칸 밖은 저장, Esc 는 그만둔다.
  const [name, setName] = useState(workflowName || '');
  useEffect(() => {
    if (workflowName) setName(workflowName);
  }, [workflowName]);
  const displayName = name || workflow.data?.workflowName || '에이전트';
  const renamable =
    !!workflow.data &&
    !workflow.data.isFrozen &&
    currentUserId != null &&
    workflow.data.ownerUserId === String(currentUserId);
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const startRename = () => {
    if (!renamable || busyRef.current) return;
    cancelledRef.current = false;
    setRenameError('');
    setDraft(displayName);
  };
  const cancelRename = useCallback(() => {
    cancelledRef.current = true;
    setDraft(null);
    setRenameError('');
  }, []);
  const commitRename = async () => {
    if (draft === null || busyRef.current || cancelledRef.current) return;
    const next = draft.trim();
    if (!next || next === displayName) {
      cancelRename();
      return;
    }
    busyRef.current = true;
    setRenaming(true);
    try {
      const saved = await xgen.agents.rename(workflowId, next);
      cancelledRef.current = true;
      setDraft(null);
      setName(saved.workflowName || next);
      onRenamed?.(saved.workflowName || next);
    } catch (error) {
      const text = errText(error);
      setRenameError(
        text.includes('같은 이름')
          ? '같은 이름의 에이전트가 이미 있습니다.'
          : text.includes('고정된')
            ? '고정된 Agent 는 이름을 바꿀 수 없습니다.'
            : '이름을 바꾸지 못했습니다.',
      );
    } finally {
      busyRef.current = false;
      setRenaming(false);
    }
  };
  // 저장에 실패하면 칸이 남는다. 잠겼다 풀리며 잃은 초점을 돌려줘 바로 고치거나 Esc 로 그만두게 한다.
  useEffect(() => {
    if (!renaming && draft !== null) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);

  return (
    <AgentViewerStateContext.Provider value={state}>
      <div className="agent-viewer">
        {/* 한 줄 헤더 — [아이콘 이름] ──────── [탭]. 닫기(X)는 탭에 이미 있으므로 생략. */}
        <div className="viewer-header">
          <div className="viewer-title">
            {onReturn && (
              <button
                type="button"
                className="viewer-back"
                onClick={onReturn}
                title={returnLabel}
                aria-label={returnLabel}
              >
                <BackIcon size={16} />
              </button>
            )}
            <BotIcon size={16} />
            {draft !== null ? (
              <input
                ref={inputRef}
                className="viewer-title-input"
                autoFocus
                value={draft}
                disabled={renaming}
                aria-label="에이전트 이름"
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  // 한글 조합 중의 Enter 는 글자를 끝내는 것이지 저장이 아니다.
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <strong
                className={renamable ? 'viewer-title-renamable' : undefined}
                onDoubleClick={renamable ? startRename : undefined}
                title={renamable ? '두 번 눌러 이름 바꾸기' : undefined}
              >
                {displayName}
              </strong>
            )}
            {renameError && (
              <span className="viewer-title-error" role="alert">
                {renameError}
              </span>
            )}
          </div>
          <div className="viewer-subtabs" role="tablist">
            {subs.map(([s, label]) => (
              <button
                key={s}
                role="tab"
                aria-selected={shown === s}
                className={`viewer-subtab ${shown === s ? 'active' : ''}`}
                onClick={() => navigate(s)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="viewer-content">
          {canvasOpened && (
            <div className={`agent-canvas-pane${shown === 'workflow' ? '' : ' hidden'}`}>
              <AgentWorkflowCanvas
                workflowId={workflowId}
                workflowName={name}
                ownerUserId={workflow.data?.ownerUserId ?? null}
                active={shown === 'workflow'}
              />
            </div>
          )}
          {shown === 'basic' &&
            (workflow.loading && !workflow.data ? (
              <ViewerEmpty title="에이전트를 불러오는 중…" loading />
            ) : workflow.data && !geny ? (
              <WorkflowOverview
                workflow={workflow.data}
                loading={workflow.loading}
                onReload={workflow.reload}
                onNavigate={navigate}
              />
            ) : (
              <AgentOverview
                workflowId={workflowId}
                onNavigate={navigateFromOverview}
                onOpenTrace={openTrace}
              />
            ))}
          {shown === 'fulllog' && <AgentExecutionView workflowId={workflowId} />}
          {shown === 'memory' && <AgentMemoryView workflowId={workflowId} />}
          {shown === 'tasks' && <TasksView workflowId={workflowId} />}
          {shown === 'tools' && <AgentToolsView workflowId={workflowId} />}
          {shown === 'apps' && (
            <AppsView
              workflowId={workflowId}
              workflowName={workflowName}
              focusSlug={initialApp}
              onSlugChange={onAppChange}
            />
          )}
          {shown === 'storage' && <StorageView workflowId={workflowId} workflowName={workflowName} />}
        </div>
      </div>
    </AgentViewerStateContext.Provider>
  );
};
