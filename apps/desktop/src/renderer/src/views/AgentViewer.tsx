/** Read-only agent inspector. Persisted subtab keys remain compatible with saved layouts. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { BotIcon, CopyIcon, FolderIcon, FolderOpenIcon, DocIcon } from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';
import { ArtifactsView } from '../artifacts/ArtifactsView';
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
import type { Task, Job, JobRun, WsNode } from '@dex/protocol';

interface Props {
  workflowId: string;
  workflowName?: string;
  initialSub?: AgentViewerSub;
  navigation?: AgentViewerState;
  onSubChange?: (sub: AgentViewerSub) => void;
  /** 닫기 — 지금은 탭 X 가 담당하므로 미사용(호환용 optional). */
  onClose?: () => void;
}

const SUBS: [AgentViewerSub, string][] = [
  ['basic', '개요'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['artifacts', '아티팩트'],
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
          {sub === 'artifacts' && (
            <ArtifactsView workflowId={workflowId} workflowName={workflowName} />
          )}
          {sub === 'storage' && <StorageView workflowId={workflowId} />}
        </div>
      </div>
    </AgentViewerStateContext.Provider>
  );
};
