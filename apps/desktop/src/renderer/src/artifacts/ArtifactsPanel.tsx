/**
 * ArtifactsPanel — 사이드바 [아티팩트]. 에이전트들이 만든 화면을 한자리에 모은다.
 *
 * 무엇을 보여 주나: **지금 열리는 것만.** 매니페스트가 틀렸거나 엔트리가 없는
 * 아티팩트는 여기 오지 않는다 — 그것들은 만든 에이전트의 [아티팩트] 탭에서 이유와
 * 함께 본다. 이 패널은 진단하는 자리가 아니라 **여는 자리**다.
 *
 * 어디서 오나: 서버에 "전부 다오" 엔드포인트는 없다(아티팩트는 에이전트 workspace
 * 안의 폴더라 소유자별로만 물어볼 수 있다). 그래서 main 이 XGeny 에이전트들을 훑어
 * 한 번에 돌려준다 — 왕복이 에이전트 수만큼 생기는 일을 렌더러에 두지 않는다.
 *
 * 못 읽은 에이전트가 있으면 숨기지 않고 말한다. 조용히 빠진 목록은 "내 아티팩트가
 * 사라졌다" 로 보이고, 그때 원인은 아무 데도 남지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArtifactSummary } from '@dex/protocol';
import { xgen } from '../bridge';
import { ArtifactIcon, RefreshIcon } from '../brand/icons';

type GalleryItem = ArtifactSummary & { workflowId: string; workflowName: string };

function when(updatedAt: number | null): string {
  if (!updatedAt) return '';
  const d = new Date(updatedAt * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}시간 전`;
  return d.toLocaleDateString();
}

export const ArtifactsPanel: React.FC<{
  /** 아티팩트를 눌렀을 때 — 그 에이전트의 [아티팩트] 탭을 연다. */
  onOpen: (workflowId: string, workflowName: string) => void;
}> = ({ onOpen }) => {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await xgen.artifacts.gallery();
      setItems(res.items);
      setFailed(res.failed);
      setScanned(res.scanned);
      setError(res.error ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.workflowName.toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <>
      <div className="sidebar-title">
        <span className="sidebar-title-text">아티팩트</span>
        <div className="sidebar-title-actions">
          <button
            className="icon-btn sm"
            title="목록 새로고침"
            aria-label="목록 새로고침"
            onClick={() => void refresh()}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <input
          className="input"
          value={query}
          placeholder="아티팩트 · 에이전트 검색"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="agent-list">
        {loading && items.length === 0 && <div className="teams-empty">불러오는 중…</div>}
        {error && <div className="teams-error">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="teams-empty">
            <ArtifactIcon size={30} />
            <p>지금 열리는 아티팩트가 없습니다.</p>
            <p className="sub">
              에이전트에게 화면을 만들어 달라고 하면 여기 모입니다 — 만드는 자리는 대화이고,
              이 목록은 여는 자리입니다.
            </p>
          </div>
        )}

        {shown.map((a) => (
          <button
            key={`${a.workflowId}/${a.slug}`}
            className="agent-item"
            onClick={() => onOpen(a.workflowId, a.workflowName)}
            title={a.description || a.title}
          >
            <span className="conv-icon">
              <ArtifactIcon size={16} />
            </span>
            <span className="agent-body">
              <span className="agent-name">{a.title}</span>
              <span className="agent-meta">
                {a.workflowName}
                {when(a.updated_at) ? ` · ${when(a.updated_at)}` : ''}
              </span>
            </span>
          </button>
        ))}

        {!loading && items.length > 0 && shown.length === 0 && (
          <div className="teams-empty">
            <p>검색과 맞는 아티팩트가 없습니다.</p>
          </div>
        )}

        {failed.length > 0 && (
          <div className="teams-error">
            {failed.length}개 에이전트의 목록을 읽지 못했습니다 ({failed.slice(0, 3).join(', ')}
            {failed.length > 3 ? ' 외' : ''}). 그 에이전트의 아티팩트는 여기 없을 수 있습니다.
          </div>
        )}

        {!loading && !error && scanned > 0 && (
          <div className="artifact-gallery-foot">
            에이전트 {scanned}개에서 {items.length}개 — 지금 열리는 것만 보입니다.
          </div>
        )}
      </div>
    </>
  );
};

export default ArtifactsPanel;
