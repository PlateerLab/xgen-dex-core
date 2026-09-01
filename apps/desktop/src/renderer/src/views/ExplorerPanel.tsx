/**
 * ExplorerPanel — 사이드바 [탐색기] 뷰.
 *
 *     [XgenCloud]            ← 사용자의 클라우드 저장소
 *     [<에이전트 이름>]        ← 각 에이전트의 자기 워크스페이스 (**전부 보인다**)
 *
 * 에이전트는 연결 여부와 무관하게 항상 나열된다 — 동기화가 꺼져 있으면
 * 서버 트리를 읽기 전용으로 보여주고(agentData.workspaceTree), [설정 >
 * 파일 시스템]에서 연결을 켜면 로컬 실파일(fileSystem.list)로 바뀐다.
 * 디렉터리는 펼칠 때 지연 로드하고, 다시 읽는 동안 **이전 목록을 그대로
 * 보여준다**.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { teamsAttachmentRejectReason } from '@dex/protocol';
import { ShareToTeamsModal } from './ShareToTeams';
import type { FileSystemStatusLike } from '../../../preload/index';
import {
  childPath,
  entriesAt,
  formatSize,
  sectionsFor,
  sortEntries,
  syncedAgo,
  type ExplorerEntry,
  type ExplorerSection,
  type RemoteNodeLike,
} from './explorer-model';
import {
  BotIcon,
  ChevronRightIcon,
  CloudIcon,
  DocIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshIcon,
  ShareIcon,
} from '../brand/icons';

interface DirState {
  /** null = 아직 한 번도 못 읽음. 로드 중에도 이전 목록을 유지한다. */
  entries: ExplorerEntry[] | null;
  loading: boolean;
}

const dirKey = (workflowId: string, rel: string) => `${workflowId}:${rel}`;

export const ExplorerPanel: React.FC<{
  onOpenSettings: () => void;
  /** 로그인 사용자 표시 이름 — 파일을 Teams 로 공유할 때 낙관적 렌더에 쓴다. */
  myName: string;
}> = ({ onOpenSettings, myName }) => {
  /** Teams 로 공유하려고 고른 파일의 클라우드 경로. null 이면 모달이 닫혀 있다. */
  const [sharePath, setSharePath] = useState<{ path: string; name: string; size: number } | null>(
    null,
  );
  const [status, setStatus] = useState<FileSystemStatusLike | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디렉터리 캐시는 ref + 수동 리렌더 — 로드가 겹칠 때 상태 업데이트 함수 안에서
  // IO 를 시작하는 꼴(불순한 updater)을 피하는 가장 단순한 구조다.
  const cacheRef = useRef(new Map<string, DirState>());
  // 비동기화 섹션의 서버 평면 트리 캐시 — 한 번 받아 모든 하위 디렉터리를 썬다.
  const remoteRef = useRef(new Map<string, RemoteNodeLike[]>());
  const seqRef = useRef(new Map<string, number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    void xgen.fileSystem
      .status()
      .then(setStatus)
      .catch(() => undefined);
    return xgen.fileSystem.onStatus(setStatus);
  }, []);

  /** 섹션+상대경로 → 직계 자식. 동기화 여부에 따라 로컬/서버를 읽는다. */
  const fetchDir = useCallback(
    async (section: ExplorerSection, rel: string, force = false): Promise<ExplorerEntry[]> => {
      if (section.synced) return xgen.fileSystem.list(section.workflowId, rel);
      let nodes = remoteRef.current.get(section.workflowId);
      if (!nodes || force) {
        const r = await xgen.agentData.workspaceTree(section.workflowId);
        nodes = (r?.files ?? []) as RemoteNodeLike[];
        remoteRef.current.set(section.workflowId, nodes);
      }
      return entriesAt(nodes, rel);
    },
    [],
  );

  const loadDir = useCallback(
    async (section: ExplorerSection, rel: string, force = false) => {
      const key = dirKey(section.workflowId, rel);
      const cur = cacheRef.current.get(key);
      if (cur?.loading) return;
      if (cur?.entries && !force) return;
      // 추월당한 응답이 최신 목록을 덮지 않게 키마다 순번을 센다.
      const seq = (seqRef.current.get(key) ?? 0) + 1;
      seqRef.current.set(key, seq);
      cacheRef.current.set(key, { entries: cur?.entries ?? null, loading: true });
      bump();
      let next: ExplorerEntry[] | null = null;
      try {
        next = sortEntries(await fetchDir(section, rel, force));
      } catch {
        next = cur?.entries ?? [];
      }
      if (seqRef.current.get(key) !== seq) return;
      cacheRef.current.set(key, { entries: next, loading: false });
      bump();
    },
    [fetchDir],
  );

  const sections = sectionsFor(status);

  // 펼쳐져 있는 섹션 루트는 항상 읽혀 있어야 한다 — 상태 변화(동기화 토글,
  // 에이전트 목록 갱신)로 섹션이 생기면 여기서 따라 읽는다.
  useEffect(() => {
    for (const s of sections) {
      if (!collapsed.has(s.id)) void loadDir(s, '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, collapsed]);

  const toggleSection = (s: ExplorerSection) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
  };

  const toggleDir = (section: ExplorerSection, rel: string) => {
    const key = dirKey(section.workflowId, rel);
    setSelected(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        void loadDir(section, rel);
      }
      return next;
    });
  };

  /** 동기화·에이전트 목록을 갱신하고, 열어 둔 모든 폴더를 다시 읽는다. */
  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      await Promise.allSettled([xgen.fileSystem.refreshAgents(), xgen.fileSystem.syncNow()]);
    } catch {
      /* 실패해도 다시 읽기는 진행한다 */
    }
    remoteRef.current.clear();
    await Promise.all(
      sections.map(async (s) => {
        const prefix = `${s.workflowId}:`;
        const keys = [...cacheRef.current.keys()].filter((k) => k.startsWith(prefix));
        await Promise.all(keys.map((k) => loadDir(s, k.slice(prefix.length), true)));
      }),
    );
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDir, status]);

  const openInOs = (section: ExplorerSection, rel: string) => {
    if (section.synced) void xgen.fileSystem.openPath(section.workflowId, rel);
  };

  const renderDir = (section: ExplorerSection, rel: string, depth: number): React.ReactNode => {
    const st = cacheRef.current.get(dirKey(section.workflowId, rel));
    if (!st || (!st.entries && st.loading)) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: depth * 14 + 26 }}>
          불러오는 중…
        </div>
      );
    }
    if (!st.entries) return null;
    if (st.entries.length === 0) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: depth * 14 + 26 }}>
          비어 있음
        </div>
      );
    }
    return st.entries.map((e) => {
      const p = childPath(rel, e.name);
      const key = dirKey(section.workflowId, p);
      if (e.isDir) {
        const open = expanded.has(key);
        return (
          <React.Fragment key={key}>
            <div
              className={`tree-row ${selected === key ? 'selected' : ''}`}
              style={{ paddingLeft: depth * 14 + 8 }}
              role="button"
              tabIndex={0}
              onClick={() => toggleDir(section, p)}
              onKeyDown={(ev) => ev.key === 'Enter' && toggleDir(section, p)}
              onDoubleClick={() => openInOs(section, p)}
              title={e.name}
            >
              <span className={`tree-chevron ${open ? 'open' : ''}`}>
                <ChevronRightIcon size={13} />
              </span>
              <span className="tree-icon">
                {open ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
              </span>
              <span className="tree-name">{e.name}</span>
            </div>
            {open && renderDir(section, p, depth + 1)}
          </React.Fragment>
        );
      }
      return (
        <div
          key={key}
          className={`tree-row ${selected === key ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 14 + 8 }}
          role="button"
          tabIndex={0}
          onClick={() => setSelected(key)}
          onDoubleClick={() => openInOs(section, p)}
          title={section.synced ? `${e.name} — 두 번 눌러 열기` : e.name}
        >
          <span className="tree-chevron" />
          <span className="tree-icon">
            <DocIcon size={14} />
          </span>
          <span className="tree-name">{e.name}</span>
          {e.size > 0 && <span className="tree-size">{formatSize(e.size)}</span>}
          {/* 파일을 Teams 방으로 — 클라우드가 **로컬 동기화 중일 때만**
              (공유 IPC 가 클라우드 동기화 폴더의 실파일을 읽는다). */}
          {section.kind === 'cloud' &&
            section.synced &&
            teamsAttachmentRejectReason(e.name, e.size) === null && (
              <button
                className="tree-share"
                title="이 파일을 Teams 대화방에 공유"
                aria-label="Teams로 공유"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSharePath({ path: `/${p}`, name: e.name, size: e.size });
                }}
              >
                <ShareIcon size={12} />
              </button>
            )}
        </div>
      );
    });
  };

  const anySyncOff = status && (!status.cloud.enabled || !status.agents.enabled);

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">탐색기</span>
        <span className="sidebar-title-actions">
          <button
            className={`icon-btn sm ${busy ? 'spin' : ''}`}
            title="새로고침 (에이전트 목록 + 동기화)"
            onClick={() => void refreshAll()}
            disabled={busy}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="explorer-body">
        {!status?.loggedIn && (
          <div className="explorer-notice">
            <p>로그인하면 클라우드와 에이전트 워크스페이스가 여기에 보입니다.</p>
          </div>
        )}
        {sections.map((s) => {
          const isCollapsed = collapsed.has(s.id);
          const st = cacheRef.current.get(dirKey(s.workflowId, ''));
          const loadingDot = s.syncing || st?.loading;
          return (
            <div key={s.id} className="explorer-section">
              <button
                className="section-head"
                onClick={() => toggleSection(s)}
                onDoubleClick={() => s.synced && openInOs(s, '')}
                title={s.synced && s.dir ? s.dir : `${s.title} (서버 보기 — 동기화 꺼짐)`}
              >
                <span className={`tree-chevron ${isCollapsed ? '' : 'open'}`}>
                  <ChevronRightIcon size={13} />
                </span>
                <span className="section-icon">
                  {s.kind === 'cloud' ? <CloudIcon size={14} /> : <BotIcon size={14} />}
                </span>
                <span className="section-name">{s.title}</span>
                {!s.synced && (
                  <span className="section-badge muted" title="서버 보기 — 로컬 동기화 꺼짐">
                    서버
                  </span>
                )}
                {s.lastError && (
                  <span className="section-err" title={s.lastError}>
                    !
                  </span>
                )}
                {loadingDot && <span className="section-loading" />}
              </button>
              {!isCollapsed && <div className="section-body">{renderDir(s, '', 1)}</div>}
            </div>
          );
        })}

        {status?.loggedIn && anySyncOff && (
          <div className="explorer-notice">
            <p>
              [설정 &gt; 파일 시스템]에서 XGen 클라우드 / Agent Workspace 연결을 켜면
              해당 저장소가 이 PC 의 폴더로 동기화됩니다.
            </p>
            <button className="primary-sm" onClick={onOpenSettings}>
              설정 열기
            </button>
          </div>
        )}
      </div>

      {sharePath && (
        <ShareToTeamsModal
          title="파일을 Teams로 공유"
          body={`${sharePath.name} 파일을 공유합니다.`}
          myName={myName}
          shareRef={{ kind: 'file', label: sharePath.name }}
          file={{ drivePath: sharePath.path, name: sharePath.name, size: sharePath.size }}
          onClose={() => setSharePath(null)}
        />
      )}

      <div className="explorer-foot">
        <span
          className={`mount-dot ${status && (status.cloud.enabled || status.agents.enabled) ? 'on' : ''}`}
        />
        {status ? (
          <span className="path-ellipsis" title={`데이터 루트: ${status.dataRoot}`}>
            {status.dataRoot}
            {(() => {
              const times = [
                status.cloud.lastSyncAt ?? 0,
                ...status.agents.list.map((a) => a.lastSyncAt ?? 0),
              ];
              const latest = Math.max(...times);
              return latest ? ` · ${syncedAgo(latest, Date.now())}` : '';
            })()}
          </span>
        ) : (
          <span className="muted">상태 확인 중…</span>
        )}
      </div>
    </div>
  );
};
