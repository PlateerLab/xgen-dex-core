/**
 * AppsView — 한 에이전트의 [앱] 탭. 만든 화면을 고르고 연다.
 *
 * 웹의 같은 이름 화면과 **같은 계약**을 쓴다(같은 API, 같은 상태, 같은 문구) —
 * 같은 에이전트를 두 곳에서 보므로 한쪽만 다른 말을 하면 안 된다.
 *
 * 앱은 새 저장소가 아니라 에이전트 workspace 의 약속된 폴더
 * (`workspace/artifacts/<slug>/`)다. **만드는 것은 에이전트**고, 파일을 손보는
 * 자리는 [스토리지] 탭이다. 이 화면이 하는 일은 고르고, 열고, 왜 안 열리는지
 * 말해 주는 것 — 그리고 **내리고, 공유하고, 지우는 것**이다.
 *
 * 네 버튼이 하는 일이 서로 다르다
 * --------------------------------
 *   [새 창으로 열기]  웹의 같은 화면을 기본 브라우저로 (사내 링크, 로그인 필요)
 *   [배포 중지]       내용을 그대로 두고 닫는다 — [배포]를 누르면 그대로 돌아온다
 *   [공유]            **로그인 없이 열리는 주소**를 하나 낸다
 *   [삭제]            폴더를 지운다 — 되돌릴 수 없다
 *
 * 상태는 누르는 즉시 바뀌어 보여야 한다
 * --------------------------------------
 * 예전에는 토글 뒤 목록만 다시 읽고 상세는 그대로 두었다. 상태를 상세에서 먼저 읽었으므로
 * 버튼 이름·공개 배너·프레임이 옛 상세에 묶여 [배포 중지]를 눌러도 화면이 그대로였다.
 * 이제는 토글 응답(서버의 답)을 목록과 상세에 **곧바로** 입히고, `pull` 을 올려 상세를 다시
 * 읽는다. 배포를 멈춘 앱은 상세를 읽지 않고 프레임을 걷는다(서버가 404 를 주는데, 그건
 * 오류가 아니라 멈춘 상태다). 다른 화면(웹, [앱] 탭)에서 바꾼 것은 workspace 소켓과 창 안의
 * 소식으로 듣는다(app-sync.ts).
 *
 * 실행은 이 컴포넌트가 하지 않는다. 격리 프레임(AppFrame)이 한다 — 이유는
 * 그 파일에 적혀 있다(이 창에는 window.xgen 이 있다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_SHARE_TEXT, type AppDetail, type AppSummary } from '@dex/protocol';
import { xgen } from '../bridge';
import { RefreshIcon } from '../brand/icons';
import { Selector } from '../views/Selector';
import { AppFrame } from './AppFrame';
import { AppSiteFrame } from './AppSiteFrame';
import { ShareAppModal } from './ShareAppModal';
import { ViewerEmpty } from '../views/agent-viewer-shared';
import { APP_CONFIRM, withServing, withShare } from './app-gallery-model';
import { announceAppChange, useAppChanges } from './app-sync';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const AppsView: React.FC<{
  workflowId: string;
  workflowName?: string;
  /** 고를 앱(폴더 이름) — [앱] 탭의 [열기] 가 넘긴다. 값이 바뀌면 그 앱으로 옮긴다. */
  focusSlug?: string;
  /** 고른 앱이 바뀌었다 — 뷰어 탭이 적어 두었다가 다시 열 때 같은 앱을 연다. */
  onSlugChange?: (slug: string) => void;
}> = ({ workflowId, focusSlug, onSlugChange }) => {
  /** 내리기/공유/삭제가 도는 동안 버튼을 막는다 — 두 번 눌러 두 번 나가지 않게. */
  const [busy, setBusy] = useState(false);
  /** 공유 창(범위·링크·중지). 링크는 주인에게만 오므로 창이 열 때 서버에서 받는다. */
  const [shareOpen, setShareOpen] = useState(false);
  const [items, setItems] = useState<AppSummary[]>([]);
  const [slug, setSlug] = useState(focusSlug ?? '');
  /** 마지막으로 읽은 상세 — 화면은 아래의 `detail`(고른 앱의 것만)을 쓴다. */
  const [loaded, setLoaded] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 소스가 바뀔 때마다 올라가 프레임을 새로 세운다. */
  const [revision, setRevision] = useState(0);
  /**
   * 상세를 다시 읽으라는 신호(값에는 뜻이 없다). 상세를 읽는 곳은 아래 effect 하나뿐이고,
   * 목록을 다시 읽었거나 상태를 바꾼 쪽은 이것만 올린다 — 여러 곳이 상세를 읽으면 늦게 온
   * 응답이 이긴다.
   */
  const [pull, setPull] = useState(0);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** 이 화면 자신 — 자기가 알린 소식은 다시 듣지 않는다. */
  const self = useRef({}).current;
  /** 목록 읽기 차례 — 겹쳐 읽으면 마지막에 **보낸** 것만 반영한다. */
  const listSeq = useRef(0);

  /** 마지막으로 프레임에 실어 보낸 바이트 — 같으면 다시 세우지 않는다. */
  const shippedRef = useRef('');

  // [앱] 탭의 [열기] 가 다른 앱을 가리키면 그리로 옮긴다.
  useEffect(() => {
    if (focusSlug) setSlug(focusSlug);
  }, [focusSlug]);

  // 고른 것을 뷰어 탭에 적어 둔다.
  const reportRef = useRef(onSlugChange);
  reportRef.current = onSlugChange;
  useEffect(() => {
    if (slug) reportRef.current?.(slug);
  }, [slug]);

  const refresh = useCallback(
    async (silent = false) => {
      const seq = ++listSeq.current;
      if (!silent) setLoading(true);
      try {
        const res = await xgen.apps.list(workflowId);
        if (seq !== listSeq.current) return;
        itemsRef.current = res.apps;
        setItems(res.apps);
        const want =
          slugRef.current && res.apps.some((a) => a.slug === slugRef.current)
            ? slugRef.current
            : (res.apps.find((a) => a.ready)?.slug ?? res.apps[0]?.slug ?? '');
        setSlug(want);
        setPull((n) => n + 1);
        setError('');
      } catch (e) {
        if (seq === listSeq.current) setError(errText(e));
      } finally {
        if (seq === listSeq.current) setLoading(false);
      }
    },
    [workflowId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 다른 곳(웹, [앱] 탭, 에이전트)이 바꾸면 조용히 다시 읽는다.
  useAppChanges([workflowId], () => void refresh(true), { self });

  useEffect(() => {
    const target = itemsRef.current.find((a) => a.slug === slug);
    if (!target || !target.serving) {
      // 목록에 없거나(아직 안 읽었거나 지워졌다) 배포를 멈춘 앱 — 서버가 소스를 주지 않는다.
      // 읽으면 404 가 오는데 그건 오류가 아니라 멈춘 상태다. 프레임을 걷는다.
      setLoaded(null);
      shippedRef.current = '';
      return;
    }
    let alive = true;
    void xgen.apps
      .get(workflowId, slug)
      .then((d) => {
        if (!alive) return;
        // 바이트가 그대로면 프레임을 다시 세우지 않는다 — 열려 있던 화면의 상태
        // (스크롤·입력)를 이유 없이 날리지 않기 위해서다.
        const stamp = `${d.slug} ${d.source} ${JSON.stringify(d.files)}`;
        setLoaded(d);
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
  }, [workflowId, slug, pull]);

  const current = items.find((a) => a.slug === slug) ?? null;
  // 다른 앱으로 옮긴 직후에는 앞 앱의 상세가 남아 있다 — 고른 앱의 것만 쓴다.
  const detail = loaded && loaded.slug === slug ? loaded : null;
  const issues = detail?.issues ?? current?.issues ?? [];
  // 상태의 정본은 **서버 응답**이다. 낙관적 로컬 상태를 두지 않는 이유는, 화면만
  // '중지' 로 보이고 서버는 계속 열어 주는 어긋남이 가장 나쁜 실패이기 때문이다.
  // 목록 항목을 먼저 본다 — 토글 응답을 곧바로 입히는 곳이고, 배포를 멈춘 앱은 상세를
  // 읽지 않으므로 상세 쪽은 옛 값을 들고 있을 수 있다.
  const serving = current?.serving ?? detail?.serving ?? true;
  const shared = current?.shared ?? detail?.shared ?? false;

  const shareAudience = current?.share_audience || detail?.share_audience || '';

  // 다른 앱으로 옮기면 열려 있던 공유 창은 이 앱의 것이 아니다.
  useEffect(() => {
    setShareOpen(false);
  }, [slug]);

  const act = useCallback(
    async (run: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await run();
        setError('');
        // 나란히 떠 있는 [앱] 탭에 알리고, 목록도 서버에서 다시 읽는다.
        announceAppChange(workflowId, self);
        await refresh(true);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workflowId, self],
  );

  const onToggleServing = useCallback(() => {
    if (!slug) return;
    const next = !serving;
    if (!next && !window.confirm(APP_CONFIRM.undeploy)) return;
    const target = slug;
    void act(async () => {
      const res = await xgen.apps.setServing(workflowId, target, next);
      // 서버의 답을 곧바로 입힌다 — 버튼·배너·프레임이 다음 목록을 기다리지 않는다.
      setItems((list) => list.map((a) => (a.slug === target ? withServing(a, res) : a)));
      setLoaded((d) => (d && d.slug === target ? withServing(d, res) : d));
      setPull((n) => n + 1);
    });
  }, [slug, serving, workflowId, act]);

  /** 공유 창이 바꾼 것을 곧바로 입히고(버튼·배너가 다음 목록을 기다리지 않는다) 목록을 다시 읽는다. */
  const onShareChanged = useCallback(
    (target: string, res: Parameters<typeof withShare>[1]) => {
      setItems((list) => list.map((a) => (a.slug === target ? withShare(a, res) : a)));
      setLoaded((d) => (d && d.slug === target ? withShare(d, res) : d));
      announceAppChange(workflowId, self);
      void refresh(true);
    },
    [workflowId, self, refresh],
  );

  const onDelete = useCallback(() => {
    if (!slug) return;
    const name = current?.title || slug;
    // 이름 뒤에 조사를 바로 붙이면 받침에 따라 을/를 이 갈린다. 명사 하나를
    // 사이에 두면 이름이 무엇이든 문장이 맞는다.
    if (!window.confirm(`'${name}' 앱을 삭제할까요?\n되돌릴 수 없습니다.`)) return;
    const target = slug;
    void act(async () => {
      await xgen.apps.remove(workflowId, target);
      // 지운 것을 계속 고르고 있으면 안 된다.
      setSlug('');
      setLoaded(null);
      shippedRef.current = '';
    });
  }, [slug, current, workflowId, act]);

  return (
    <div className="apps-view">
      <div className="apps-bar">
        {items.length > 0 ? (
          // 앱 공용 Selector — 네이티브 <select> 는 이 창의 다른 컨트롤과 생김새가
          // 달라 혼자 튄다(플랫폼 기본 위젯이라 테마도 안 따른다).
          <Selector
            className="apps-picker"
            value={slug}
            onChange={setSlug}
            size="sm"
            ariaLabel="앱 선택"
            searchable={items.length > 8}
            searchPlaceholder="앱 검색"
            options={items.map((a) => ({
              value: a.slug,
              // 왜 못 여는지를 **구분해서** 말한다 — 사람이 내린 것은 버튼 한 번이고
              // 코드가 깨진 것은 에이전트가 고칠 일이다.
              label: !a.serving
                ? `${a.title} (배포 중지됨)`
                : a.ready
                  ? a.title
                  : `${a.title} (열 수 없음)`,
            }))}
          />
        ) : null}
        <span className="apps-count">
          {loading ? '불러오는 중…' : `앱 ${items.length}개`}
        </span>
        {slug && serving ? (
          <button type="button" className="apps-action" onClick={() => void xgen.apps.openWeb(workflowId, slug)}>
            새 창으로 열기
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="apps-action" disabled={busy} onClick={onToggleServing}>
            {serving ? '배포 중지' : '배포'}
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="apps-action" disabled={busy} onClick={() => setShareOpen(true)}>
            {shared ? APP_SHARE_TEXT.shareSettings : '공유'}
          </button>
        ) : null}
        {slug ? (
          <button type="button" className="apps-action danger" disabled={busy} onClick={onDelete}>
            삭제
          </button>
        ) : null}
        <button
          type="button"
          className="apps-refresh"
          onClick={() => void refresh()}
          title="새로고침"
          aria-label="새로고침"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {error ? <div className="viewer-note err">불러오지 못했습니다: {error}</div> : null}

      {/* 배포를 멈춘 앱은 공개 링크도 닫혀 있다 — 그때 "공개 중" 이라고 말하면 거짓이다. */}
      {shared && serving ? (
        <div className="apps-share">
          <strong>공개 중</strong>
          <p>
            {shareAudience === 'users'
              ? 'XGEN 에 로그인한 사람은 링크로 이 화면을 봅니다. [공유 설정]에서 범위를 바꾸거나 공유를 중지합니다.'
              : '링크를 아는 사람은 로그인 없이 이 화면을 봅니다. [공유 설정]에서 범위를 바꾸거나 공유를 중지합니다.'}
          </p>
        </div>
      ) : null}

      {!loading && slug && !serving ? (
        <div className="apps-issues">
          <strong>배포 중지됨</strong>
          <p style={{ margin: '4px 0 0' }}>
            이 앱은 지금 아무에게도 열리지 않습니다. 파일은 그대로 있으니 [배포]를 누르면 돌아옵니다.
          </p>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="apps-issues">
          <strong>앱 진단</strong>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!loading && items.length === 0 && !error ? (
        <ViewerEmpty title="아직 앱이 없습니다" description="에이전트가 만든 화면이나 결과물을 이곳에서 열어볼 수 있습니다." />
      ) : null}

      {detail?.ready && serving ? (
        <div className="apps-stage">
          {detail.kind === 'project' || detail.kind === 'service' ? (
            // 사이트(파일)든 에이전트가 띄운 앱이든 서버가 주소를 낸다 — main 이
            // 자격을 붙여 받아 오고 여기서는 띄우기만 한다.
            <AppSiteFrame
              url={detail.app_url}
              title={detail.title}
              reloadKey={revision}
            />
          ) : (
            <AppFrame app={detail} reloadKey={revision} />
          )}
        </div>
      ) : null}

      {shareOpen && slug ? (
        <ShareAppModal
          app={{
            workflow_id: workflowId,
            slug,
            title: current?.title || slug,
            shared,
            ready: serving && (detail?.ready ?? current?.ready ?? false),
          }}
          onClose={() => setShareOpen(false)}
          onChanged={(res) => onShareChanged(slug, res)}
        />
      ) : null}
    </div>
  );
};

export default AppsView;
