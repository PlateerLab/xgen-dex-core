/**
 * ExplorerPanel — 사이드바 [탐색기] 뷰.
 *
 *     [XgenCloud]            ← 가상 드라이브 = 클라우드 루트 (서버 스트리밍)
 *     [<에이전트 이름>]        ← 로컬 동기화 폴더 (sandbox 워크스페이스와 동기화)
 *
 * 클라우드는 백엔드 IPC(workspace.list — 마운트가 죽어도 동작), 에이전트는
 * 로컬 실파일(sync.list)을 읽는다. 디렉터리는 펼칠 때 지연 로드하고, 다시
 * 읽는 동안 **이전 목록을 그대로 보여준다**.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { teamsAttachmentRejectReason } from '@dex/protocol';
import { ShareToTeamsModal } from './ShareToTeams';
import type { LocalSyncStatusLike, WorkspaceStatusLike } from '../../../preload/index';
import {
  childPath,
  formatSize,
  sectionsFor,
  sortEntries,
  syncedAgo,
  type ExplorerEntry,
  type ExplorerSection,
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
  UploadIcon,
} from '../brand/icons';

interface DirState {
  /** null = 아직 한 번도 못 읽음. 로드 중에도 이전 목록을 유지한다. */
  entries: ExplorerEntry[] | null;
  loading: boolean;
}

/** 캐시 키 — 클라우드와 에이전트 트리가 절대 섞이지 않게 네임스페이스를 붙인다. */
const cloudKey = (path: string) => `cloud:${path}`;
const agentKey = (workflowId: string, rel: string) => `agent:${workflowId}:${rel}`;

export const ExplorerPanel: React.FC<{
  onOpenSettings: () => void;
  /** 로그인 사용자 표시 이름 — 파일을 Teams 로 공유할 때 낙관적 렌더에 쓴다. */
  myName: string;
}> = ({ onOpenSettings, myName }) => {
  /** Teams 로 공유하려고 고른 파일의 드라이브 경로. null 이면 모달이 닫혀 있다. */
  const [sharePath, setSharePath] = useState<{ path: string; name: string; size: number } | null>(
    null,
  );
  const [status, setStatus] = useState<WorkspaceStatusLike | null>(null);
  const [sync, setSync] = useState<LocalSyncStatusLike | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디렉터리 캐시는 ref + 수동 리렌더 — 로드가 겹칠 때 상태 업데이트 함수 안에서
  // IO 를 시작하는 꼴(불순한 updater)을 피하는 가장 단순한 구조다.
  const cacheRef = useRef(new Map<string, DirState>());
  const seqRef = useRef(new Map<string, number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    void xgen.workspace
      .status()
      .then(setStatus)
      .catch(() => undefined);
    return xgen.workspace.onStatus(setStatus);
  }, []);

  useEffect(() => {
    void xgen.sync
      .status()
      .then(setSync)
      .catch(() => undefined);
    return xgen.sync.onStatus(setSync);
  }, []);

  /** key 로 디렉터리를 읽는다 — 클라우드는 드라이브 백엔드, 에이전트는 로컬 fs. */
  const fetchDir = useCallback(
    async (section: ExplorerSection, rel: string): Promise<ExplorerEntry[]> => {
      if (section.kind === 'cloud') return xgen.workspace.list(rel);
      return xgen.sync.list(section.workflowId!, rel);
    },
    [],
  );

  const keyOf = useCallback(
    (section: ExplorerSection, rel: string) =>
      section.kind === 'cloud' ? cloudKey(rel) : agentKey(section.workflowId!, rel),
    [],
  );

  const loadDir = useCallback(
    async (section: ExplorerSection, rel: string, force = false) => {
      const key = keyOf(section, rel);
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
        next = sortEntries(await fetchDir(section, rel));
      } catch {
        next = cur?.entries ?? [];
      }
      if (seqRef.current.get(key) !== seq) return;
      cacheRef.current.set(key, { entries: next, loading: false });
      bump();
    },
    [fetchDir, keyOf],
  );

  const sections = sectionsFor(sync?.agents ?? null);

  // 펼쳐져 있는 섹션 루트는 항상 읽혀 있어야 한다 — 상태 변화(동기화 대상
  // 추가/제거, 최초 로드)로 섹션이 생기면 여기서 따라 읽는다.
  useEffect(() => {
    for (const s of sections) {
      if (!collapsed.has(s.id)) void loadDir(s, s.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sync, collapsed]);

  const toggleSection = (s: ExplorerSection) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
  };

  const toggleDir = (section: ExplorerSection, rel: string) => {
    const key = keyOf(section, rel);
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

  /** 서버 캐시·동기화를 갱신하고, 열어 둔 모든 폴더를 다시 읽는다. */
  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      await Promise.allSettled([xgen.workspace.refresh(), xgen.sync.now()]);
    } catch {
      /* 실패해도 로컬 다시 읽기는 진행한다 */
    }
    await Promise.all(
      sections.map(async (s) => {
        const prefix = s.kind === 'cloud' ? 'cloud:' : `agent:${s.workflowId}:`;
        const keys = [...cacheRef.current.keys()].filter((k) => k.startsWith(prefix));
        await Promise.all(keys.map((k) => loadDir(s, k.slice(prefix.length), true)));
      }),
    );
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDir, sync, status]);

  const openInOs = (section: ExplorerSection, rel: string) => {
    if (section.kind === 'cloud') void xgen.workspace.openPath(rel);
    else void xgen.sync.openPath(section.workflowId!, rel);
  };

  const canOpenInOs = (section: ExplorerSection) => section.kind === 'agent' || !!status?.mounted;

  const renderDir = (section: ExplorerSection, rel: string, depth: number): React.ReactNode => {
    const st = cacheRef.current.get(keyOf(section, rel));
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
      const key = keyOf(section, p);
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
              onDoubleClick={() => canOpenInOs(section) && openInOs(section, p)}
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
          onDoubleClick={() => canOpenInOs(section) && openInOs(section, p)}
          title={canOpenInOs(section) ? `${e.name} — 두 번 눌러 열기` : e.name}
        >
          <span className="tree-chevron" />
          <span className="tree-icon">
            <DocIcon size={14} />
          </span>
          <span className="tree-name">{e.name}</span>
          {e.size > 0 && <span className="tree-size">{formatSize(e.size)}</span>}
          {/* 에이전트 산출물을 Teams 방으로 — 탐색기가 [Agent]와 [Teams] 사이의
              세 번째 문이다. 올릴 수 없는 형식이면 버튼조차 띄우지 않는다.

              **클라우드(가상 드라이브) 섹션에서만** 띄운다. 두 섹션의 rel 은 서로
              다른 경로 공간이다 — cloud 는 드라이브 루트 기준(공유 IPC 가 받는 값),
              agent 는 로컬 동기화 폴더 기준(`xgen.sync`)이다. 구분 없이 넘기면
              엉뚱한 파일을 가리키거나 "워크스페이스 안의 파일만" 오류가 난다.
              동기화 폴더 파일 공유는 후속 과제. */}
          {section.kind === 'cloud' && teamsAttachmentRejectReason(e.name, e.size) === null && (
            <button
              className="tree-share"
              title="이 파일을 Teams 대화방에 공유"
              aria-label="Teams로 공유"
              onClick={(ev) => {
                ev.stopPropagation();
                setSharePath({ path: p, name: e.name, size: e.size });
              }}
            >
              <ShareIcon size={12} />
            </button>
          )}
        </div>
      );
    });
  };

  // 드라이브(클라우드)가 아예 서빙되지 않는 상태 — 클라우드 섹션에 사유를 보인다.
  const cloudBlocked = status && (!status.enabled || !status.supported);

  // 클라우드가 잠긴 사유 — RAG 통제(승인 대기/거절)가 storageOff 보다 먼저다.
  const cloudLockMessage = !status
    ? null
    : status.cloudApproval === 'pending'
      ? '클라우드 연결이 관리자 승인 대기중입니다. 승인되면 자동으로 열립니다.'
      : status.cloudApproval === 'rejected'
        ? status.cloudApprovalDetail || '클라우드 연결이 관리자에 의해 거절되었습니다.'
        : (status.storageOff ?? null);

  const renderCloudBody = (s: ExplorerSection): React.ReactNode => {
    if (!status) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: 26 }}>
          드라이브 상태 확인 중…
        </div>
      );
    }
    if (cloudBlocked) {
      return (
        <div className="explorer-notice">
          {!status.supported ? (
            <>
              <p>{status.reason ?? '이 플랫폼에서는 드라이브를 지원하지 않습니다.'}</p>
              {status.hint && <p className="muted small">{status.hint}</p>}
            </>
          ) : (
            <>
              <p>XGEN 워크스페이스 드라이브가 꺼져 있습니다.</p>
              <button
                className="primary-sm"
                onClick={() => void xgen.workspace.setEnabled(true).then(setStatus)}
              >
                드라이브 켜기
              </button>
            </>
          )}
        </div>
      );
    }
    if (cloudLockMessage) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: 26, whiteSpace: 'normal' }}>
          {cloudLockMessage}
        </div>
      );
    }
    return (
      <>
        {status.error && (
          <div className="explorer-notice error-tone">
            <p>{status.error}</p>
            <button
              className="primary-sm"
              onClick={() => void xgen.workspace.remount().then(setStatus)}
            >
              다시 연결
            </button>
          </div>
        )}
        {renderDir(s, s.path, 1)}
      </>
    );
  };

  // 동기화가 꺼져 있는 이유 → 에이전트 영역 안내.
  const syncNotice =
    sync && !sync.enabled
      ? sync.reason === 'disabled'
        ? '에이전트 워크스페이스를 이 PC 로 동기화하려면 [설정 > 로컬 도구]에서 로컬 도구 접근을 켜세요.'
        : sync.reason === 'no-root'
          ? '에이전트 워크스페이스를 둘 [기본 작업 폴더]를 [설정 > 로컬 도구]에서 지정하세요.'
          : null
      : null;

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">탐색기</span>
        <span className="sidebar-title-actions">
          {status?.mounted && (
            <button
              className="icon-btn sm"
              title="드라이브를 OS 파일 관리자로 열기"
              onClick={() => void xgen.workspace.open()}
            >
              <UploadIcon size={14} />
            </button>
          )}
          <button
            className={`icon-btn sm ${busy ? 'spin' : ''}`}
            title="새로고침 (드라이브 + 동기화)"
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
          const st = cacheRef.current.get(keyOf(s, s.path));
          const loadingDot = s.kind === 'agent' ? s.syncing : st?.loading;
          return (
            <div key={s.id} className="explorer-section">
              <button
                className="section-head"
                onClick={() => toggleSection(s)}
                onDoubleClick={() => s.kind === 'agent' && openInOs(s, '')}
                title={s.kind === 'agent' ? (s.dir ?? s.title) : s.title}
              >
                <span className={`tree-chevron ${isCollapsed ? '' : 'open'}`}>
                  <ChevronRightIcon size={13} />
                </span>
                <span className="section-icon">
                  {s.kind === 'cloud' ? <CloudIcon size={14} /> : <BotIcon size={14} />}
                </span>
                <span className="section-name">{s.title}</span>
                {s.kind === 'agent' && s.lastError && (
                  <span className="section-err" title={s.lastError}>
                    !
                  </span>
                )}
                {loadingDot && <span className="section-loading" />}
              </button>
              {!isCollapsed && (
                <div className="section-body">
                  {s.kind === 'cloud' ? renderCloudBody(s) : renderDir(s, s.path, 1)}
                </div>
              )}
            </div>
          );
        })}

        {syncNotice && (
          <div className="explorer-notice">
            <p>{syncNotice}</p>
            <button className="primary-sm" onClick={onOpenSettings}>
              설정 열기
            </button>
          </div>
        )}
        {sync?.enabled && sync.agents.length === 0 && (
          <div className="explorer-notice">
            <p>
              연결된 에이전트가 없습니다. [설정 &gt; 스토리지]에서 에이전트를 연결하면
              워크스페이스가 이 PC 로 동기화됩니다.
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
        <span className={`mount-dot ${status?.mounted ? 'on' : ''}`} />
        {status?.mounted && status.path ? (
          <span className="path-ellipsis" title={`드라이브: ${status.path}`}>
            {status.path}
          </span>
        ) : (
          <span className="muted">드라이브 꺼짐</span>
        )}
        {sync?.enabled && sync.root && (
          <>
            <span className="foot-sep" />
            <span
              className="path-ellipsis"
              title={`에이전트 동기화 폴더: ${sync.root}${
                sync.agents.some((a) => a.lastSyncAt)
                  ? ` · ${syncedAgo(Math.max(...sync.agents.map((a) => a.lastSyncAt ?? 0)), Date.now())}`
                  : ''
              }`}
            >
              {sync.root}
            </span>
          </>
        )}
      </div>
    </div>
  );
};
