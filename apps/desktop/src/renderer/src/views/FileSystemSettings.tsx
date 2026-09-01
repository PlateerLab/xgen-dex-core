/**
 * FileSystemSettings — [설정 > 파일 시스템] 탭 본문.
 *
 * 철학: 서버에서는 어차피 전부 정상 실행된다 — 이 탭의 두 토글은 그것을
 * **이 PC 의 실제 폴더로 볼 수 있느냐**만 정한다 (기본 둘 다 OFF).
 *
 *   [XGen 클라우드 연결]     <dataRoot>/cloud            ↔ 내 클라우드 저장소
 *   [Agent Workspace 연결]  <dataRoot>/agent_workspace/ ↔ 모든 에이전트 워크스페이스
 *
 * 가상 드라이브·에이전트 개별 연결(cloud links)은 폐기됐다 — 에이전트는
 * 기본적으로 자기 워크스페이스를 알고, 클라우드는 클라우드일 뿐이다.
 */
import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { FileSystemStatusLike, SyncProgressLike } from '../../../preload/index';
import { syncedAgo } from './explorer-model';

/** apply 단계의 파일 단위 진행 막대 — 개별 프로그레스의 시각 표시. */
const ProgressBar: React.FC<{ done: number; total: number }> = ({ done, total }) => (
  <span
    style={{
      display: 'inline-block',
      width: 90,
      height: 4,
      borderRadius: 2,
      background: 'var(--border)',
      overflow: 'hidden',
      verticalAlign: 'middle',
    }}
  >
    <span
      style={{
        display: 'block',
        height: '100%',
        width: `${total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}%`,
        background: 'var(--primary)',
        transition: 'width 200ms ease',
      }}
    />
  </span>
);

export const FileSystemSettings: React.FC<{ embedded?: boolean }> = () => {
  const [status, setStatus] = useState<FileSystemStatusLike | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void xgen.fileSystem
      .status()
      .then(setStatus)
      .catch(() => undefined);
    return xgen.fileSystem.onStatus(setStatus);
  }, []);

  const run = async (key: string, fn: () => Promise<FileSystemStatusLike | null>) => {
    setBusy(key);
    try {
      const s = await fn();
      if (s) setStatus(s);
    } finally {
      setBusy(null);
    }
  };

  const copyDiag = async () => {
    const r = await xgen.fileSystem.diagCopy();
    if (r.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  if (!status) return <div className="small muted">상태 확인 중…</div>;

  const cloud = status.cloud;
  const agents = status.agents;
  const syncedAgents = agents.list.filter((a) => a.synced);
  // 큐 요약 — 전체가 아니라 "지금 무엇이 돌고, 몇 개가 줄 서 있는지"를 보여준다.
  const syncingCount = agents.list.filter((a) => a.state === 'syncing').length;
  const queuedCount = agents.list.filter((a) => a.state === 'queued').length;
  const doneCount = syncedAgents.filter(
    (a) => a.state === 'idle' && a.lastSyncAt && !a.lastError,
  ).length;

  const stateLine = (t: {
    state: 'idle' | 'queued' | 'syncing';
    queuePosition?: number;
    progress?: SyncProgressLike;
    lastError?: string;
    lastSyncAt?: number;
  }): React.ReactNode => {
    if (t.state === 'syncing') {
      const p = t.progress;
      if (p && p.total > 0 && (p.phase === 'apply' || p.phase === 'scan')) {
        const done = Math.min(p.done, p.total);
        return (
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span>
              동기화 중 — {p.phase === 'apply' ? '파일' : '검사'} {done}/{p.total}
            </span>
            <ProgressBar done={done} total={p.total} />
          </span>
        );
      }
      if (p?.phase === 'scan') return '동기화 중 — 폴더 검사…';
      return '동기화 중 — 변경 확인…';
    }
    if (t.state === 'queued') {
      return t.queuePosition ? `대기열 ${t.queuePosition}번째` : '대기열 등록됨';
    }
    if (t.lastError) return <span className="error">오류: {t.lastError}</span>;
    if (t.lastSyncAt) return syncedAgo(t.lastSyncAt, Date.now());
    return '대기 중';
  };

  return (
    <>
      <p className="small muted">
        XGen 저장소를 이 PC 의 <b>실제 폴더</b>로 동기화합니다. 에이전트와 클라우드는
        서버에서 항상 정상 동작하고 있고, 아래 토글은 그것을 로컬 파일로 볼 수 있느냐만
        정합니다. 파일의 원본은 항상 서버에 있습니다.
      </p>

      {!status.loggedIn && (
        <p className="small muted">로그인하면 동기화를 켤 수 있습니다.</p>
      )}

      {/* ── XGen 클라우드 연결 ── */}
      <div className="mcp-form" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>XGen 클라우드 연결</div>
            <div className="small muted" style={{ marginTop: 2 }}>
              내 클라우드 저장소를 <code>{cloud.dir}</code> 폴더로 동기화합니다.
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={cloud.enabled}
              disabled={!status.loggedIn || busy === 'cloud'}
              onChange={(e) =>
                void run('cloud', () => xgen.fileSystem.setCloudSync(e.target.checked))
              }
            />
            <span className="track" />
          </label>
        </div>
        {cloud.enabled && (
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <span className="small muted">{stateLine(cloud)}</span>
            <span className="row" style={{ gap: 10 }}>
              <button className="link" onClick={() => void xgen.fileSystem.openRoot('cloud')}>
                폴더 열기
              </button>
              <button
                className="link"
                disabled={busy === 'cloud-sync'}
                onClick={() =>
                  void run('cloud-sync', () => xgen.fileSystem.syncNow(cloud.owner ?? undefined))
                }
              >
                지금 동기화
              </button>
            </span>
          </div>
        )}
      </div>

      {/* ── Agent Workspace 연결 ── */}
      <div className="mcp-form" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Agent Workspace 연결</div>
            <div className="small muted" style={{ marginTop: 2 }}>
              모든 에이전트의 워크스페이스를 <code>{agents.root}</code> 아래 에이전트별
              폴더로 동기화합니다.
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={agents.enabled}
              disabled={!status.loggedIn || busy === 'agents'}
              onChange={(e) =>
                void run('agents', () => xgen.fileSystem.setAgentSync(e.target.checked))
              }
            />
            <span className="track" />
          </label>
        </div>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span className="small muted">
            에이전트 {agents.list.length}개
            {agents.enabled
              ? ` · 동기화 중 ${syncingCount} · 대기 ${queuedCount} · 완료 ${doneCount}`
              : ' — 연결이 꺼져 있습니다 (서버에서만 실행)'}
          </span>
          <span className="row" style={{ gap: 10 }}>
            <button
              className="link"
              disabled={busy === 'refresh'}
              onClick={() => void run('refresh', () => xgen.fileSystem.refreshAgents())}
            >
              새로고침
            </button>
            {agents.enabled && (
              <>
                <button className="link" onClick={() => void xgen.fileSystem.openRoot('agents')}>
                  폴더 열기
                </button>
                <button
                  className="link"
                  disabled={busy === 'agents-sync'}
                  onClick={() => void run('agents-sync', () => xgen.fileSystem.syncNow())}
                >
                  지금 동기화
                </button>
              </>
            )}
          </span>
        </div>

        {agents.list.length > 0 && (
          <div className="mcp-list" style={{ marginTop: 8 }}>
            {agents.list.map((a) => (
              <div key={a.workflowId} className="mcp-item">
                <div className="mcp-item-body">
                  <div className="mcp-item-name" title={a.dir ?? a.label}>
                    {a.label}
                  </div>
                  <div className="small muted">
                    {a.synced ? stateLine(a) : '서버에서만 실행 — 로컬 폴더 없음'}
                  </div>
                </div>
                {a.synced && a.dir && (
                  <div className="mcp-item-actions">
                    <button
                      className="link"
                      onClick={() => void xgen.fileSystem.openPath(a.workflowId)}
                    >
                      열기
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="link" onClick={() => void copyDiag()}>
          {copied ? '복사됨' : '진단 로그 복사'}
        </button>
      </div>
    </>
  );
};
