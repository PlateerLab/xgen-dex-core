/**
 * ExplorerPanel — 사이드바 [탐색기] 뷰.
 *
 *     [파일 저장소]            ← 사용자의 파일 저장소
 *     [<에이전트 이름>]        ← 각 에이전트의 워크스페이스 (**전부** 보인다)
 *
 * 서버에 있는 것을 그대로 보여 준다 — 이 PC 에 내려받아 두지 않는다. 파일을
 * 누르면 콘텐츠 영역의 뷰어 탭으로 연다. 디렉터리는 펼칠 때 지연 로드하고,
 * 다시 읽는 동안 **이전 목록을 그대로 보여준다**.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { teamsAttachmentRejectReason } from '@dex/protocol';
import { ShareToTeamsModal } from './ShareToTeams';
import {
  childPath,
  entriesAt,
  formatSize,
  sectionsFor,
  sortEntries,
  type ExplorerAgent,
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
  /** 마지막 읽기가 실패했으면 그 이유 — 이전 목록이 있으면 그대로 둔다. */
  error?: string;
}

const dirKey = (workflowId: string, rel: string) => `${workflowId}:${rel}`;

export const ExplorerPanel: React.FC<{
  /** 로그인 사용자 표시 이름 — 파일을 Teams 로 공유할 때 낙관적 렌더에 쓴다. */
  myName: string;
  /** 파일 클릭 → 콘텐츠 영역 뷰어 탭. */
  onOpenFile?: (
    sectionKind: 'cloud' | 'agent',
    workflowId: string,
    rel: string,
    name: string,
  ) => void;
}> = ({ myName, onOpenFile }) => {
  /** Teams 로 공유하려고 고른 파일의 저장소 경로. null 이면 모달이 닫혀 있다. */
  const [sharePath, setSharePath] = useState<{ path: string; name: string; size: number } | null>(
    null,
  );
  const [agents, setAgents] = useState<ExplorerAgent[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디렉터리 캐시는 ref + 수동 리렌더 — 로드가 겹칠 때 상태 업데이트 함수 안에서
  // IO 를 시작하는 꼴(불순한 updater)을 피하는 가장 단순한 구조다.
  const cacheRef = useRef(new Map<string, DirState>());
  // 에이전트 섹션의 서버 평면 트리 캐시 — 한 번 받아 모든 하위 디렉터리를 썬다.
  const remoteRef = useRef(new Map<string, RemoteNodeLike[]>());
  const seqRef = useRef(new Map<string, number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const loadAgents = useCallback(async () => {
    try {
      setAgents(await xgen.storage.agents());
    } catch {
      /* 목록을 못 읽으면 이전 목록을 둔다 — 새로고침으로 다시 시도한다 */
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  /** 섹션+상대경로 → 직계 자식. 파일 저장소는 폴더 단위로, 에이전트는 평면 목록에서. */
  const fetchDir = useCallback(
    async (section: ExplorerSection, rel: string, force = false): Promise<ExplorerEntry[]> => {
      if (section.kind === 'cloud') {
        const r = await xgen.storage.cloudList(rel);
        if (!r.ok) throw new Error(r.error || '목록을 불러오지 못했습니다');
        return r.entries;
      }
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
      let next: DirState;
      try {
        next = { entries: sortEntries(await fetchDir(section, rel, force)), loading: false };
      } catch (e) {
        next = { entries: cur?.entries ?? [], loading: false, error: (e as Error).message };
      }
      if (seqRef.current.get(key) !== seq) return;
      cacheRef.current.set(key, next);
      bump();
    },
    [fetchDir],
  );

  const sections = sectionsFor(agents);

  // 펼쳐져 있는 섹션 루트는 항상 읽혀 있어야 한다 — 에이전트 목록이 갱신돼
  // 섹션이 생기면 여기서 따라 읽는다.
  useEffect(() => {
    for (const s of sections) {
      if (!collapsed.has(s.id)) void loadDir(s, '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, collapsed]);

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

  /** 에이전트 목록을 갱신하고, 열어 둔 모든 폴더를 서버에서 다시 읽는다. */
  const refreshAll = useCallback(async () => {
    setBusy(true);
    await loadAgents();
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
  }, [loadAgents, loadDir, agents]);

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
        <div className="tree-row muted" style={{ paddingLeft: depth * 14 + 26 }} title={st.error}>
          {st.error ? '불러오지 못했습니다' : '비어 있음'}
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
          onClick={() => {
            setSelected(key);
            onOpenFile?.(section.kind, section.workflowId, p, e.name);
          }}
          onKeyDown={(ev) => {
            if (ev.key !== 'Enter') return;
            setSelected(key);
            onOpenFile?.(section.kind, section.workflowId, p, e.name);
          }}
          title={e.name}
        >
          <span className="tree-chevron" />
          <span className="tree-icon">
            <DocIcon size={14} />
          </span>
          <span className="tree-name">{e.name}</span>
          {e.size > 0 && <span className="tree-size">{formatSize(e.size)}</span>}
          {/* 파일 저장소의 파일을 Teams 방으로 — 바이트는 메인이 서버에서 받는다. */}
          {section.kind === 'cloud' && teamsAttachmentRejectReason(e.name, e.size) === null && (
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

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">탐색기</span>
        <span className="sidebar-title-actions">
          <button
            className={`icon-btn sm ${busy ? 'spin' : ''}`}
            title="새로고침"
            onClick={() => void refreshAll()}
            disabled={busy}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="explorer-body">
        {sections.map((s) => {
          const isCollapsed = collapsed.has(s.id);
          const st = cacheRef.current.get(dirKey(s.workflowId, ''));
          return (
            <div key={s.id} className="explorer-section">
              <button className="section-head" onClick={() => toggleSection(s)} title={s.title}>
                <span className={`tree-chevron ${isCollapsed ? '' : 'open'}`}>
                  <ChevronRightIcon size={13} />
                </span>
                <span className="section-icon">
                  {s.kind === 'cloud' ? <CloudIcon size={14} /> : <BotIcon size={14} />}
                </span>
                <span className="section-name">{s.title}</span>
                {st?.error && (
                  <span className="section-err" title={st.error}>
                    !
                  </span>
                )}
                {st?.loading && <span className="section-loading" />}
              </button>
              {!isCollapsed && <div className="section-body">{renderDir(s, '', 1)}</div>}
            </div>
          );
        })}
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
    </div>
  );
};
