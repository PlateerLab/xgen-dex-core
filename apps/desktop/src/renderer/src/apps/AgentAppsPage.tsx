/**
 * AgentAppsPage — 메인 영역의 [앱] 탭. 웹 [Agent APP] 화면과 같은 두 칸이다.
 *
 *   내 앱       내 에이전트 전부가 만든 앱 — 열고, 공개 링크를 켜고 끄고, 배포를 켜고 끈다
 *   앱 스토어   공개 링크로 공유된 앱(누가 만들었든) — 공개 링크로 연다
 *
 * 웹 화면을 그대로 가져다 쓰지 못한다. 이 창에는 웹의 부품(@xgen/ui·Tailwind)이 없고, CSP 가
 * 렌더러의 네트워크를 막는다. 그래서 같은 엔드포인트를 main 을 거쳐 부르고(apps.mine·store),
 * 화면은 이 앱의 부품과 클래스로 다시 그렸다. 문구와 판정은 app-gallery-model 에서 가져와
 * 에이전트 [앱] 하위 탭과 같은 말을 한다.
 *
 * [열기]는 그 에이전트 뷰어의 [앱] 하위 탭에서 그 앱을 골라 연다 — 같은 화면을 두 벌 만들지
 * 않고, 고친 것이 어디 사는지도 함께 보인다. 스토어의 앱은 남의 에이전트일 수 있어 공개
 * 링크(로그인 없이 열리는 주소)로 기본 브라우저에서 연다.
 *
 * 미리보기는 그리지 않는다. 카드마다 살아 있는 프레임을 띄우면 앱 수만큼 서버 일이 생긴다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStoreListResult, AppStoreScope, MyApp, MyAppsResult, StoreApp } from '@dex/protocol';
import { copyText, xgen } from '../bridge';
import { AppIcon, BrowserIcon, CodeIcon, MoreIcon, RefreshIcon } from '../brand/icons';
import { Selector } from '../views/Selector';
import { ViewerEmpty } from '../views/agent-viewer-shared';
import { useModalDismiss } from '../views/use-modal-dismiss';
import {
  APP_CONFIRM,
  agentFilterOptions,
  appKey,
  appKindLabel,
  appStatus,
  filterMyApps,
  formatWhen,
  myAppsSummary,
  pageCount,
  patchMyApp,
  storeSummary,
  validAgentFilter,
  withServing,
  withShare,
} from './app-gallery-model';
import { announceAppChange, useAppChanges } from './app-sync';

type TabId = 'mine' | 'store';

const PAGE_SIZE = 24;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 탭을 떠났다 돌아와도 보던 칸·거름·쪽을 잃지 않게 기억한다. 다른 탭을 보는 동안 이 화면은
 * 내려가기 때문이다. [앱] 탭은 하나뿐이라 모듈에 하나 둔다. **데이터는 기억하지 않는다** —
 * 돌아오면 서버에서 다시 읽는다(그사이 계정이 바뀌었을 수도 있다).
 */
const remembered = {
  tab: 'mine' as TabId,
  agent: '',
  query: '',
  scope: 'all' as AppStoreScope,
  storeQuery: '',
  page: 1,
};

const KindGlyph: React.FC<{ kind: string }> = ({ kind }) =>
  kind === 'project' ? <BrowserIcon size={18} /> : kind === 'component' ? <CodeIcon size={18} /> : <AppIcon size={18} />;

export const AgentAppsPage: React.FC<{
  /** [열기]·[에이전트에서 보기] — 그 에이전트 뷰어의 [앱] 하위 탭을 그 앱으로 연다. */
  onOpenApp: (workflowId: string, workflowName: string, slug: string) => void;
}> = ({ onOpenApp }) => {
  const [tab, setTab] = useState<TabId>(remembered.tab);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** 이 화면 자신 — 자기가 알린 소식은 다시 듣지 않는다. */
  const self = useRef({}).current;

  // ── 내 앱 ──
  const [mine, setMine] = useState<MyAppsResult | null>(null);
  const [mineLoading, setMineLoading] = useState(true);
  const [mineError, setMineError] = useState('');
  const [agent, setAgent] = useState(remembered.agent);
  const [query, setQuery] = useState(remembered.query);
  /** 도는 중인 토글의 앱 키 — 한 번에 하나만 보낸다(두 번 눌러 두 번 나가지 않게). */
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [shareLink, setShareLink] = useState<{ title: string; url: string; copied: boolean } | null>(null);
  const [detail, setDetail] = useState<MyApp | null>(null);
  const [menu, setMenu] = useState('');
  const mineSeq = useRef(0);

  // ── 앱 스토어 ──
  const [store, setStore] = useState<AppStoreListResult | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [scope, setScope] = useState<AppStoreScope>(remembered.scope);
  const [storeQuery, setStoreQuery] = useState(remembered.storeQuery);
  /** 검색어는 치는 동안 매번 보내지 않는다 — 멈추고 조금 뒤에 보낸다. */
  const [storeSearch, setStoreSearch] = useState(remembered.storeQuery.trim());
  const [page, setPage] = useState(remembered.page);
  const storeSeq = useRef(0);

  useEffect(() => {
    Object.assign(remembered, { tab, agent, query, scope, storeQuery, page });
  }, [tab, agent, query, scope, storeQuery, page]);

  const loadMine = useCallback(async (silent = false) => {
    const seq = ++mineSeq.current;
    if (!silent) setMineLoading(true);
    try {
      const res = await xgen.apps.mine();
      if (seq !== mineSeq.current) return;
      setMine(res);
      setAgent((cur) => validAgentFilter(res, cur));
      setMineError('');
    } catch (e) {
      if (seq === mineSeq.current) setMineError(errText(e));
    } finally {
      if (seq === mineSeq.current) setMineLoading(false);
    }
  }, []);

  const loadStore = useCallback(
    async (silent = false) => {
      const seq = ++storeSeq.current;
      if (!silent) setStoreLoading(true);
      try {
        const res = await xgen.apps.store({ search: storeSearch, scope, page, pageSize: PAGE_SIZE });
        if (seq !== storeSeq.current) return;
        setStore(res);
        setStoreError('');
        // 앞쪽 앱이 빠져 이 쪽이 비었으면(공유를 끈 앱 등) 마지막 쪽으로 물러난다.
        const last = pageCount(res.total, PAGE_SIZE);
        if (page > last) setPage(last);
      } catch (e) {
        if (seq === storeSeq.current) setStoreError(errText(e));
      } finally {
        if (seq === storeSeq.current) setStoreLoading(false);
      }
    },
    [storeSearch, scope, page],
  );

  // [내 앱]은 처음에 한 번 읽는다 — 어느 칸을 보든 소켓을 들을 에이전트 목록이 여기서 온다.
  // 칸을 옮겨 돌아오면 다시 읽는다(있던 것은 두고 조용히).
  const hasMine = useRef(false);
  hasMine.current = mine !== null;
  useEffect(() => {
    if (tab === 'mine' || !hasMine.current) void loadMine(hasMine.current);
  }, [tab, loadMine]);

  // 검색어가 실제로 바뀌었을 때만 첫 쪽으로 — 탭에 돌아와 기억한 쪽을 잃지 않게.
  useEffect(() => {
    const next = storeQuery.trim();
    if (next === storeSearch) return;
    const h = setTimeout(() => {
      setStoreSearch(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(h);
  }, [storeQuery, storeSearch]);

  useEffect(() => {
    if (tab === 'store') void loadStore();
  }, [tab, loadStore]);

  // 다른 곳(웹, 에이전트 [앱] 하위 탭, 에이전트 자신)이 바꾸면 보고 있는 칸을 조용히 다시 읽는다.
  const watchIds = useMemo(() => (mine?.agents ?? []).map((a) => a.workflow_id), [mine]);
  useAppChanges(
    watchIds,
    () => {
      if (tabRef.current === 'mine') void loadMine(true);
      else void loadStore(true);
    },
    { self, anyAgent: true },
  );

  const refresh = () => {
    if (tab === 'mine') void loadMine();
    else void loadStore();
  };

  // ── 토글 ──
  /**
   * 토글 하나. 서버의 답을 그 카드에 곧바로 입히고(추측이 아니다), 목록을 다시 읽는다.
   * 나란히 떠 있는 에이전트 [앱] 하위 탭에도 알린다.
   */
  const runToggle = async (app: MyApp, run: () => Promise<(a: MyApp) => MyApp>) => {
    if (busy) return;
    setBusy(appKey(app));
    setActionError('');
    try {
      const patch = await run();
      setMine((cur) => (cur ? patchMyApp(cur, app.workflow_id, app.slug, patch) : cur));
      setDetail((cur) => (cur && appKey(cur) === appKey(app) ? patch(cur) : cur));
      announceAppChange(app.workflow_id, self);
      await loadMine(true);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const toggleShare = (app: MyApp) => {
    const next = !app.shared;
    if (!window.confirm(next ? APP_CONFIRM.share : APP_CONFIRM.unshare)) return;
    void runToggle(app, async () => {
      const res = await xgen.apps.setShare(app.workflow_id, app.slug, next);
      if (res.shared && res.url) {
        // 링크는 이 응답에만 들어 있다 — 지금 손에 쥐여 주지 않으면 다시 켜야 받는다.
        const copied = await copyText(res.url);
        setShareLink({ title: app.title, url: res.url, copied });
      }
      return (a) => withShare(a, res);
    });
  };

  const toggleServing = (app: MyApp) => {
    const next = !app.serving;
    // 배포는 바로 한다. 멈추는 것만 묻는다 — 앱과 공개 링크가 함께 닫힌다.
    if (!next && !window.confirm(APP_CONFIRM.undeploy)) return;
    void runToggle(app, async () => {
      const res = await xgen.apps.setServing(app.workflow_id, app.slug, next);
      return (a) => withServing(a, res);
    });
  };

  const openStoreApp = async (app: StoreApp) => {
    try {
      await xgen.apps.openPublic(app.path);
      setActionError('');
    } catch (e) {
      setActionError(errText(e));
    }
  };

  // ── 그리기 ──
  const agentOptions = useMemo(() => agentFilterOptions(mine), [mine]);
  const rows = useMemo(() => filterMyApps(mine?.apps ?? [], agent, query), [mine, agent, query]);
  const pages = pageCount(store?.total ?? 0, PAGE_SIZE);

  const renderMine = () => {
    if (mineError && !mine) {
      return <ViewerEmpty error title="앱 목록을 불러오지 못했습니다" description={mineError} onRetry={() => void loadMine()} />;
    }
    if (!mine) return <div className="viewer-note">불러오는 중…</div>;
    if (mine.apps.length === 0) {
      return (
        <ViewerEmpty
          title="에이전트가 만든 앱이 없습니다"
          description="에이전트에게 앱을 만들어 달라고 하면 여기에 모입니다."
        />
      );
    }
    if (rows.length === 0) return <ViewerEmpty title="검색 결과가 없습니다" />;
    return (
      <div className="app-gallery-grid">
        {rows.map((app) => {
          const key = appKey(app);
          const pending = busy === key;
          const status = appStatus(app);
          return (
            <div key={key} className="app-card">
              <div className="app-card-head">
                <span className="app-card-glyph" aria-hidden>
                  <KindGlyph kind={app.kind} />
                </span>
                <div className="app-card-names">
                  <strong className="app-card-title" title={app.title}>
                    {app.title}
                  </strong>
                  <span className="app-card-agent" title={app.workflow_name}>
                    {app.workflow_name}
                  </span>
                </div>
                <div className="app-card-menu-wrap">
                  <button
                    type="button"
                    className="app-card-more"
                    title="더 보기"
                    aria-label="더 보기"
                    aria-expanded={menu === key}
                    onClick={() => setMenu((cur) => (cur === key ? '' : key))}
                  >
                    <MoreIcon size={16} />
                  </button>
                  {menu === key ? (
                    <>
                      <div className="teams-menu-scrim" onClick={() => setMenu('')} />
                      <div className="teams-menu app-card-menu" role="menu">
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenu('');
                            setDetail(app);
                          }}
                        >
                          상세 정보
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenu('');
                            onOpenApp(app.workflow_id, app.workflow_name, app.slug);
                          }}
                        >
                          에이전트에서 보기
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="app-card-badges">
                <span className="app-badge">{appKindLabel(app.kind)}</span>
                {/* 도는 동안에는 상태를 말하지 않는다 — 곧 다시 읽는 목록이 답한다. */}
                {pending ? null : <span className={`app-badge ${status.key}`}>{status.label}</span>}
                {app.shared && app.serving ? <span className="app-badge shared">공개 중</span> : null}
              </div>
              <p className="app-card-desc" title={app.description || undefined}>
                {app.description}
              </p>
              <div className="app-card-actions">
                <button
                  type="button"
                  className="apps-action strong"
                  disabled={!app.ready}
                  onClick={() => onOpenApp(app.workflow_id, app.workflow_name, app.slug)}
                >
                  열기
                </button>
                <button
                  type="button"
                  className="apps-action"
                  disabled={!!busy || (!app.shared && !app.ready)}
                  onClick={() => toggleShare(app)}
                >
                  {app.shared ? '공유 중지' : '공유'}
                </button>
                <button
                  type="button"
                  className="apps-action"
                  disabled={!!busy}
                  onClick={() => toggleServing(app)}
                >
                  {app.serving ? '배포 중지' : '배포'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderStore = () => {
    if (storeError && !store) {
      return <ViewerEmpty error title="앱 스토어를 불러오지 못했습니다" description={storeError} onRetry={() => void loadStore()} />;
    }
    if (!store) return <div className="viewer-note">불러오는 중…</div>;
    if (store.items.length === 0) {
      return storeSearch ? (
        <ViewerEmpty title="검색 결과가 없습니다" />
      ) : (
        <ViewerEmpty title="공유된 앱이 없습니다" description="[내 앱]에서 공유한 앱이 여기에 모입니다." />
      );
    }
    return (
      <>
        <div className="app-gallery-grid">
          {store.items.map((app) => {
            const shared = formatWhen(app.shared_at);
            return (
              <div key={appKey(app)} className="app-card">
                <div className="app-card-head">
                  <span className="app-card-glyph" aria-hidden>
                    <KindGlyph kind={app.kind} />
                  </span>
                  <div className="app-card-names">
                    <strong className="app-card-title" title={app.title}>
                      {app.title}
                    </strong>
                    <span className="app-card-agent" title={app.workflow_name}>
                      {app.owner_name || '알 수 없는 사용자'}
                      {app.workflow_name ? ` · ${app.workflow_name}` : ''}
                    </span>
                  </div>
                </div>
                <div className="app-card-badges">
                  <span className="app-badge">{appKindLabel(app.kind)}</span>
                  {app.mine ? <span className="app-badge shared">내 앱</span> : null}
                  {shared ? <span className="app-card-when">공유 {shared}</span> : null}
                </div>
                <p className="app-card-desc" title={app.description || undefined}>
                  {app.description}
                </p>
                <div className="app-card-actions">
                  <button type="button" className="apps-action strong" onClick={() => void openStoreApp(app)}>
                    열기
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {pages > 1 ? (
          <div className="app-gallery-pager">
            <button type="button" className="apps-action" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              이전
            </button>
            <span className="apps-count">
              {page} / {pages}
            </span>
            <button type="button" className="apps-action" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
              다음
            </button>
          </div>
        ) : null}
      </>
    );
  };

  const loading = tab === 'mine' ? mineLoading : storeLoading;

  return (
    <div className="app-gallery">
      <div className="viewer-header">
        <div className="viewer-title">
          <AppIcon size={16} />
          <strong>앱</strong>
        </div>
        <div className="viewer-subtabs" role="tablist">
          {(
            [
              ['mine', '내 앱'],
              ['store', '앱 스토어'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`viewer-subtab ${tab === id ? 'active' : ''}`}
              onClick={() => {
                setMenu('');
                setActionError('');
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="apps-bar">
        {tab === 'mine' ? (
          <>
            <Selector
              className="app-gallery-filter"
              size="sm"
              value={agent}
              onChange={setAgent}
              options={agentOptions}
              ariaLabel="에이전트"
              searchable={agentOptions.length > 8}
              searchPlaceholder="에이전트 검색"
            />
            <input
              className="input app-gallery-search"
              value={query}
              placeholder="앱 검색"
              aria-label="앱 검색"
              onChange={(e) => setQuery(e.target.value)}
            />
            {mine ? <span className="apps-count">{myAppsSummary(mine)}</span> : null}
          </>
        ) : (
          <>
            <Selector
              className="app-gallery-filter"
              size="sm"
              value={scope}
              onChange={(v) => {
                setScope(v === 'mine' ? 'mine' : 'all');
                setPage(1);
              }}
              options={[
                { value: 'all', label: '전체' },
                { value: 'mine', label: '내가 공유한 앱' },
              ]}
              ariaLabel="보기 범위"
            />
            <input
              className="input app-gallery-search"
              value={storeQuery}
              placeholder="앱 검색"
              aria-label="앱 검색"
              onChange={(e) => setStoreQuery(e.target.value)}
            />
            {store ? <span className="apps-count">{storeSummary(store.total)}</span> : null}
          </>
        )}
        <button
          type="button"
          className="apps-refresh"
          onClick={refresh}
          disabled={loading}
          title="새로고침"
          aria-label="새로고침"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {tab === 'mine' && mine && mine.failed.length > 0 ? (
        <div className="apps-issues" role="status">
          {mine.failed.length}개 에이전트의 앱을 읽지 못했습니다: {mine.failed.join(', ')}
        </div>
      ) : null}
      {actionError ? <div className="viewer-note err">처리하지 못했습니다: {actionError}</div> : null}
      {tab === 'mine' && mineError && mine ? (
        <div className="viewer-note err">다시 불러오지 못했습니다: {mineError}</div>
      ) : null}
      {tab === 'store' && storeError && store ? (
        <div className="viewer-note err">다시 불러오지 못했습니다: {storeError}</div>
      ) : null}

      <div className="app-gallery-body">{tab === 'mine' ? renderMine() : renderStore()}</div>

      {detail ? (
        <AppDetailModal
          app={detail}
          onClose={() => setDetail(null)}
          onOpen={() => {
            setDetail(null);
            onOpenApp(detail.workflow_id, detail.workflow_name, detail.slug);
          }}
        />
      ) : null}
      {shareLink ? <ShareLinkModal link={shareLink} onClose={() => setShareLink(null)} /> : null}
    </div>
  );
};

/** [상세 정보] — 카드에는 이름·상태·버튼만 두고 나머지는 여기. */
const AppDetailModal: React.FC<{ app: MyApp; onClose: () => void; onOpen: () => void }> = ({
  app,
  onClose,
  onOpen,
}) => {
  useModalDismiss(onClose);
  const status = appStatus(app);
  const rows: Array<[string, React.ReactNode]> = [
    ['종류', appKindLabel(app.kind)],
    ['에이전트', app.workflow_name || '-'],
    ['폴더', <code key="folder">{app.slug}</code>],
    ['상태', status.label],
    ['공개', app.shared && app.serving ? `공개 중 · ${formatWhen(app.shared_at) || '-'}` : '-'],
    ['수정', formatWhen(app.updated_at) || '-'],
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={app.title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{app.title}</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        {app.description ? <p className="app-detail-desc">{app.description}</p> : null}
        <dl className="app-detail-grid">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {app.issues.length ? (
          <div className="apps-issues app-detail-issues">
            <strong>앱 진단</strong>
            <ul>
              {app.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            닫기
          </button>
          <button className="primary" onClick={onOpen}>
            에이전트에서 보기
          </button>
        </div>
      </div>
    </div>
  );
};

/** 방금 만든 공개 링크 — 클립보드가 막힌 환경에서도 읽고 옮길 수 있게. */
const ShareLinkModal: React.FC<{
  link: { title: string; url: string; copied: boolean };
  onClose: () => void;
}> = ({ link, onClose }) => {
  useModalDismiss(onClose);
  const [copied, setCopied] = useState(link.copied);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="공개 링크" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>공개 링크</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="app-detail-desc">
          {copied
            ? `'${link.title}' 앱의 공개 링크를 만들고 복사했습니다.`
            : `'${link.title}' 앱의 공개 링크를 만들었습니다.`}
        </p>
        <input readOnly value={link.url} aria-label="공개 링크" onFocus={(e) => e.currentTarget.select()} />
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            닫기
          </button>
          <button
            className="primary"
            onClick={() => {
              void copyText(link.url).then((ok) => setCopied(ok));
            }}
          >
            복사
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentAppsPage;
