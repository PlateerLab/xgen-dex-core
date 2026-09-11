/**
 * ArtifactsView — 한 에이전트의 [아티팩트] 탭. 만든 화면을 고르고 연다.
 *
 * 웹의 같은 이름 화면과 **같은 계약**을 쓴다(같은 API, 같은 상태, 같은 문구) —
 * 같은 에이전트를 두 곳에서 보므로 한쪽만 다른 말을 하면 안 된다.
 *
 * 아티팩트는 새 저장소가 아니라 에이전트 workspace 의 약속된 폴더
 * (`workspace/artifacts/<slug>/`)다. **만드는 것은 에이전트**고, 파일을 손보는
 * 자리는 [스토리지] 탭이다. 이 화면이 하는 일은 고르고, 열고, 왜 안 열리는지
 * 말해 주는 것 — 그리고 **내리고, 공유하고, 지우는 것**이다.
 *
 * 네 버튼이 하는 일이 서로 다르다
 * --------------------------------
 *   [새 창으로 열기]  웹의 같은 화면을 기본 브라우저로 (사내 링크, 로그인 필요)
 *   [서빙 중지]       내용을 그대로 두고 닫는다 — 다시 올리면 그대로 돌아온다
 *   [공유]            **로그인 없이 열리는 주소**를 하나 낸다
 *   [삭제]            폴더를 지운다 — 되돌릴 수 없다
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
import { ViewerEmpty } from '../views/agent-viewer-shared';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const ArtifactsView: React.FC<{ workflowId: string; workflowName?: string }> = ({
  workflowId,
}) => {
  /** 내리기/공유/삭제가 도는 동안 버튼을 막는다 — 두 번 눌러 두 번 나가지 않게. */
  const [busy, setBusy] = useState(false);
  /**
   * 방금 만든 공개 주소. 서버는 링크를 **켠 응답에만** 실어 준다(목록에 실으면
   * 공유·감독으로 들어온 사람도 링크를 쥔다). 그래서 화면이 잠깐 들고 있다가
   * 보여 준다 — 클립보드가 막혔을 때의 유일한 통로다.
   */
  const [shareUrl, setShareUrl] = useState('');
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
  // 상태의 정본은 **서버 응답**이다. 낙관적 로컬 상태를 두지 않는 이유는, 화면만
  // '중지' 로 보이고 서버는 계속 열어 주는 어긋남이 가장 나쁜 실패이기 때문이다.
  const serving = detail?.serving ?? current?.serving ?? true;
  const shared = detail?.shared ?? current?.shared ?? false;

  // 다른 아티팩트로 옮기면 방금 만든 링크는 이 화면의 것이 아니다.
  useEffect(() => { setShareUrl(''); }, [slug]);

  const act = useCallback(
    async (run: () => Promise<string>) => {
      if (busy) return;
      setBusy(true);
      try {
        const note = await run();
        if (note) setError('');
        await refresh();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  const onToggleServing = useCallback(() => {
    if (!slug) return;
    const next = !serving;
    if (!next && !window.confirm(
      '서빙을 중지할까요?\n\n내용은 지우지 않습니다. 중지하는 동안에는 이 앱에서도 '
      + '웹에서도, 공유 링크로도 열리지 않습니다.',
    )) return;
    void act(async () => {
      await xgen.artifacts.setServing(workflowId, slug, next);
      return 'ok';
    });
  }, [slug, serving, workflowId, act]);

  /**
   * 공유는 **바깥 세상에 문을 내는 일**이다. 그래서 켤 때는 무엇이 공개되고
   * 무엇이 공개되지 *않는지*를 먼저 말하고 확인을 받는다 — 나중에 "이게 밖에서도
   * 보이는 줄 몰랐다" 가 나오면 되돌릴 수 없다(이미 본 사람이 있다).
   */
  const onToggleShare = useCallback(() => {
    if (!slug) return;
    const next = !shared;
    const ok = window.confirm(
      next
        ? '공개 링크를 만들까요?\n\n링크를 아는 사람은 누구나 로그인 없이 이 화면과 '
          + '그 안의 데이터를 봅니다.\n아티팩트가 선언한 API 는 공개 화면에서 동작하지 '
          + '않습니다 — 그 호출은 보는 사람의 권한으로 나가는데 익명에게는 권한이 '
          + '없습니다.\n\n언제든 [공유 중지]로 닫을 수 있습니다.'
        : '공개 링크를 닫을까요?\n\n지금 링크는 즉시 열리지 않습니다. 다시 공개하면 '
          + '새 주소가 발급되므로 이미 나간 링크는 되살아나지 않습니다.',
    );
    if (!ok) return;
    void act(async () => {
      const res = await xgen.artifacts.setShare(workflowId, slug, next);
      if (res.shared && res.url) {
        // 링크는 이 응답에만 들어 있다 — 지금 손에 쥐여 주지 않으면 다시 켜야 받는다.
        try { await navigator.clipboard.writeText(res.url); } catch { /* 막힌 환경 */ }
        setShareUrl(res.url);
      } else {
        setShareUrl('');
      }
      return 'ok';
    });
  }, [slug, shared, workflowId, act]);

  const onDelete = useCallback(() => {
    if (!slug) return;
    const name = current?.title || slug;
    if (!window.confirm(
      `'${name}' 아티팩트를 삭제할까요?\n\n폴더와 그 안의 파일이 모두 지워집니다. `
      + '되돌릴 수 없습니다.\n잠깐 닫아 두려는 것이라면 [서빙 중지]를 쓰세요.',
    )) return;
    void act(async () => {
      await xgen.artifacts.remove(workflowId, slug);
      // 지운 것을 계속 고르고 있으면 안 된다.
      setSlug('');
      setDetail(null);
      shippedRef.current = '';
      return 'ok';
    });
  }, [slug, current, workflowId, act]);

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
              // 왜 못 여는지를 **구분해서** 말한다 — 사람이 내린 것은 버튼 한 번이고
              // 코드가 깨진 것은 에이전트가 고칠 일이다.
              label: !a.serving
                ? `${a.title} (서빙 중지됨)`
                : a.ready
                  ? a.title
                  : `${a.title} (열 수 없음)`,
            }))}
          />
        ) : null}
        <span className="artifacts-count">
          {loading ? '불러오는 중…' : `아티팩트 ${items.length}개`}
        </span>
        {slug && serving ? (
          <button type="button" className="artifacts-action" onClick={() => void xgen.artifacts.openWeb(workflowId, slug)}>
            새 창으로 열기
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="artifacts-action" disabled={busy} onClick={onToggleServing}>
            {serving ? '서빙 중지' : '서빙 시작'}
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="artifacts-action" disabled={busy} onClick={onToggleShare}>
            {shared ? '공유 중지' : '공유'}
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="artifacts-action danger" disabled={busy} onClick={onDelete}>
            삭제
          </button>
        ) : null}
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

      {shared ? (
        <div className="artifacts-share">
          <strong>공개 중</strong>
          <p>링크를 아는 사람은 로그인 없이 이 화면을 봅니다. [공유 중지]로 닫을 수 있습니다.</p>
          {shareUrl ? (
            // 주소는 켠 직후 한 번만 손에 들어온다 — 읽을 수 있게 그대로 보여 준다.
            <code>{shareUrl}</code>
          ) : null}
        </div>
      ) : null}

      {!loading && slug && !serving ? (
        <div className="artifacts-issues">
          <strong>서빙 중지됨</strong>
          <p style={{ margin: '4px 0 0' }}>
            이 아티팩트는 지금 아무에게도 열리지 않습니다. 파일은 그대로 있으니 [서빙 시작]을 누르면 돌아옵니다.
          </p>
        </div>
      ) : null}

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
        <ViewerEmpty title="아직 아티팩트가 없습니다" description="에이전트가 만든 화면이나 결과물을 이곳에서 열어볼 수 있습니다." />
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
