/**
 * ArtifactsView — 한 에이전트의 [아티팩트] 탭. 만든 화면을 고르고 연다.
 *
 * 웹의 같은 이름 화면과 **같은 계약**을 쓴다(같은 API, 같은 상태, 같은 문구) —
 * 같은 에이전트를 두 곳에서 보므로 한쪽만 다른 말을 하면 안 된다.
 *
 * 아티팩트는 새 저장소가 아니라 에이전트 workspace 의 약속된 폴더
 * (`workspace/artifacts/<slug>/`)다. 그래서 여기서 만들거나 지우지 않는다 —
 * 만드는 것은 에이전트고, 파일을 손보는 자리는 [스토리지] 탭이다. 이 화면이 하는
 * 일은 **고르고, 열고, 왜 안 열리는지 말해 주는 것** 셋이다.
 *
 * 실행은 이 컴포넌트가 하지 않는다. 격리 프레임(ArtifactFrame)이 한다 — 이유는
 * 그 파일에 적혀 있다(이 창에는 window.xgen 이 있다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactDetail, ArtifactSummary } from '@dex/protocol';
import { xgen } from '../bridge';
import { RefreshIcon } from '../brand/icons';
import { Selector } from '../views/Selector';
import { ArtifactFrame } from './ArtifactFrame';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const ArtifactsView: React.FC<{ workflowId: string; workflowName?: string }> = ({
  workflowId,
}) => {
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [slug, setSlug] = useState('');
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 소스가 바뀔 때마다 올라가 프레임을 새로 세운다. */
  const [revision, setRevision] = useState(0);
  const slugRef = useRef('');
  slugRef.current = slug;

  /** 마지막으로 프레임에 실어 보낸 바이트 — 같으면 다시 세우지 않는다. */
  const shippedRef = useRef('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await xgen.artifacts.list(workflowId);
      setItems(res.artifacts);
      const want =
        slugRef.current && res.artifacts.some((a) => a.slug === slugRef.current)
          ? slugRef.current
          : (res.artifacts.find((a) => a.ready)?.slug ?? res.artifacts[0]?.slug ?? '');
      setSlug(want);
      setError('');
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!slug) {
      setDetail(null);
      return;
    }
    let alive = true;
    void xgen.artifacts
      .get(workflowId, slug)
      .then((d) => {
        if (!alive) return;
        // 바이트가 그대로면 프레임을 다시 세우지 않는다 — 열려 있던 화면의 상태
        // (스크롤·입력)를 이유 없이 날리지 않기 위해서다.
        const stamp = `${d.slug} ${d.source} ${JSON.stringify(d.files)}`;
        setDetail(d);
        if (stamp !== shippedRef.current) {
          shippedRef.current = stamp;
          setRevision((r) => r + 1);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [workflowId, slug]);

  const current = items.find((a) => a.slug === slug) ?? null;
  const issues = detail?.issues ?? current?.issues ?? [];

  return (
    <div className="artifacts-view">
      <div className="artifacts-bar">
        {items.length > 0 ? (
          // 앱 공용 Selector — 네이티브 <select> 는 이 창의 다른 컨트롤과 생김새가
          // 달라 혼자 튄다(플랫폼 기본 위젯이라 테마도 안 따른다).
          <Selector
            className="artifacts-picker"
            value={slug}
            onChange={setSlug}
            size="sm"
            ariaLabel="아티팩트 선택"
            searchable={items.length > 8}
            searchPlaceholder="아티팩트 검색"
            options={items.map((a) => ({
              value: a.slug,
              label: a.ready ? a.title : `${a.title} (열 수 없음)`,
            }))}
          />
        ) : null}
        <span className="artifacts-count">
          {loading ? '불러오는 중…' : `아티팩트 ${items.length}개`}
        </span>
        <button
          type="button"
          className="artifacts-refresh"
          onClick={() => void refresh()}
          title="새로고침"
          aria-label="새로고침"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {error ? <div className="viewer-note err">불러오지 못했습니다: {error}</div> : null}

      {issues.length > 0 ? (
        <div className="artifacts-issues">
          <strong>아티팩트 진단</strong>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!loading && items.length === 0 && !error ? (
        <div className="viewer-note">
          아직 아티팩트가 없습니다. 에이전트에게 화면을 만들어 달라고 하면
          workspace/artifacts/ 아래에 만들고, 여기서 열립니다.
        </div>
      ) : null}

      {detail?.ready ? (
        <div className="artifacts-stage">
          <ArtifactFrame artifact={detail} reloadKey={revision} />
        </div>
      ) : null}
    </div>
  );
};

export default ArtifactsView;
