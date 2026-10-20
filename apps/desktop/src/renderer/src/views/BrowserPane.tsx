import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveBrowserAddress,
  type BrowserAddressSearchConfig,
  type BrowserHistoryListResult,
  type BrowserHistorySuggestion,
  type BrowserHistoryVisit,
  type BrowserPageInfo,
  type BrowserPopupDecision,
  type BrowserSelectionMode,
  type BrowserSelectionSession,
} from '@dex/protocol/browser';
import { xgen } from '../bridge';
import { useBrowserState } from '../browser-state';
import {
  BackIcon,
  BrowserIcon,
  CloseIcon,
  ForwardIcon,
  HistoryIcon,
  ElementSelectIcon,
  PopupBlockedIcon,
  PlusIcon,
  RefreshIcon,
  RegionSelectIcon,
  StopIcon,
  TrashIcon,
} from '../brand/icons';

export interface BrowserSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EMPTY_HISTORY: BrowserHistoryListResult = { items: [], total: 0 };

function historyTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

export const BrowserPane: React.FC<{
  workflowId: string;
  workflowName: string;
  addressSearch?: BrowserAddressSearchConfig;
  selection: BrowserSelectionSession | null;
  onStartSelection: (page: BrowserPageInfo, mode: BrowserSelectionMode) => void;
  onSurface: (pageId: string, rect: BrowserSurfaceRect | null) => void;
}> = ({ workflowId, workflowName, addressSearch, selection, onStartSelection, onSurface }) => {
  const state = useBrowserState();
  const pages = useMemo(
    () => state.pages.filter((page) => page.workflowId === workflowId && page.mode === 'shared'),
    [state.pages, workflowId],
  );
  const preferred = state.activeByWorkflow[workflowId];
  const active = pages.find((page) => page.pageId === preferred) ?? pages[0] ?? null;
  const [address, setAddress] = useState(active?.url ?? '');
  const [navigationError, setNavigationError] = useState('');
  const [popupExpanded, setPopupExpanded] = useState(false);
  const [popupBusy, setPopupBusy] = useState<BrowserPopupDecision | null>(null);
  const [popupError, setPopupError] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<BrowserHistorySuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<BrowserHistoryListResult>(EMPTY_HISTORY);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState('');
  const [confirmHistoryClear, setConfirmHistoryClear] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const previousPageId = useRef<string | null>(active?.pageId ?? null);
  const suggestionRequest = useRef(0);
  const clearConfirmationTimer = useRef<number | null>(null);
  const popupRequests = useMemo(
    () => state.popupRequests.filter((request) => request.pageId === active?.pageId),
    [active?.pageId, state.popupRequests],
  );
  const popupRequest = popupRequests[0] ?? null;

  useEffect(() => {
    if (!state.enabled || pages.length) return;
    void xgen.browser.ensureShared(workflowId, workflowName);
  }, [state.enabled, pages.length, workflowId, workflowName]);

  useEffect(() => {
    const pageChanged = previousPageId.current !== (active?.pageId ?? null);
    previousPageId.current = active?.pageId ?? null;
    if (pageChanged || !addressFocused) setAddress(active?.url ?? '');
    setNavigationError('');
    setPopupExpanded(false);
    setPopupError('');
  }, [active?.pageId, active?.url, addressFocused]);

  useEffect(() => {
    if (popupRequest) return;
    setPopupExpanded(false);
    setPopupError('');
  }, [popupRequest]);

  useEffect(() => {
    if (historyOpen) {
      if (active) onSurface(active.pageId, null);
      return;
    }
    const element = surfaceRef.current;
    if (!element || !active) return;
    const report = () => {
      const rect = element.getBoundingClientRect();
      onSurface(active.pageId, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      onSurface(active.pageId, null);
    };
  }, [active?.pageId, historyOpen, onSurface]);

  const navigate = useCallback(
    async (action: 'goto' | 'back' | 'forward' | 'reload' | 'stop', url?: string) => {
      if (!active) return;
      setNavigationError('');
      try {
        await xgen.browser.navigate({ pageId: active.pageId, action, url });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setNavigationError(detail || '페이지를 열지 못했습니다.');
      }
    },
    [active],
  );

  const openAddress = useCallback(
    (url: string) => {
      setAddress(url);
      setSuggestionsOpen(false);
      setSuggestionIndex(-1);
      setHistoryOpen(false);
      addressInputRef.current?.blur();
      void navigate('goto', url);
    },
    [navigate],
  );

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      setHistory(await xgen.browser.historyList({ offset: 0, limit: 200 }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '방문 기록을 불러오지 못했습니다.');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!addressFocused || historyOpen || !state.enabled) {
      setSuggestionsOpen(false);
      setSuggestionIndex(-1);
      return;
    }
    const sequence = ++suggestionRequest.current;
    const timer = window.setTimeout(() => {
      void xgen.browser
        .historySuggestions({ query: address, limit: 8 })
        .then((items) => {
          if (sequence !== suggestionRequest.current) return;
          setSuggestions(items);
          setSuggestionsOpen(items.length > 0);
          setSuggestionIndex(-1);
        })
        .catch(() => {
          if (sequence !== suggestionRequest.current) return;
          setSuggestions([]);
          setSuggestionsOpen(false);
          setSuggestionIndex(-1);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [address, addressFocused, historyOpen, state.enabled]);

  useEffect(
    () => () => {
      if (clearConfirmationTimer.current !== null) {
        window.clearTimeout(clearConfirmationTimer.current);
      }
    },
    [],
  );

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      const next = !open;
      if (next) void loadHistory();
      return next;
    });
    setSuggestionsOpen(false);
    setSuggestionIndex(-1);
    setConfirmHistoryClear(false);
  }, [loadHistory]);

  const removeHistoryVisit = useCallback(
    async (visit: BrowserHistoryVisit) => {
      if (historyBusy) return;
      setHistoryBusy(visit.visitId);
      setHistoryError('');
      try {
        await xgen.browser.historyRemove({ visitId: visit.visitId });
        await loadHistory();
      } catch (error) {
        setHistoryError(
          error instanceof Error ? error.message : '방문 기록을 삭제하지 못했습니다.',
        );
      } finally {
        setHistoryBusy('');
      }
    },
    [historyBusy, loadHistory],
  );

  const clearHistory = useCallback(async () => {
    if (!confirmHistoryClear) {
      setConfirmHistoryClear(true);
      if (clearConfirmationTimer.current !== null) {
        window.clearTimeout(clearConfirmationTimer.current);
      }
      clearConfirmationTimer.current = window.setTimeout(() => {
        clearConfirmationTimer.current = null;
        setConfirmHistoryClear(false);
      }, 4_000);
      return;
    }
    if (clearConfirmationTimer.current !== null) {
      window.clearTimeout(clearConfirmationTimer.current);
      clearConfirmationTimer.current = null;
    }
    setHistoryBusy('clear');
    setHistoryError('');
    try {
      await xgen.browser.historyClear();
      setHistory(EMPTY_HISTORY);
      setSuggestions([]);
      setSuggestionsOpen(false);
      setConfirmHistoryClear(false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '방문 기록을 삭제하지 못했습니다.');
    } finally {
      setHistoryBusy('');
    }
  }, [confirmHistoryClear]);

  const addPage = useCallback(() => {
    void xgen.browser
      .create({ workflowId, workflowName, mode: 'shared' })
      .then((page) => xgen.browser.activate(page.pageId));
  }, [workflowId, workflowName]);

  const closePage = useCallback(
    async (page: BrowserPageInfo) => {
      await xgen.browser.close(page.pageId);
      if (pages.length === 1) await xgen.browser.ensureShared(workflowId, workflowName);
    },
    [pages.length, workflowId, workflowName],
  );

  const resolvePopup = useCallback(
    async (decision: BrowserPopupDecision) => {
      if (!popupRequest || popupBusy) return;
      setPopupBusy(decision);
      setPopupError('');
      try {
        const handled = await xgen.browser.resolvePopup({
          requestId: popupRequest.requestId,
          decision,
        });
        if (!handled) setPopupError('팝업 요청이 만료되었거나 페이지가 변경되었습니다.');
        setPopupExpanded(false);
      } catch (error) {
        setPopupError(error instanceof Error ? error.message : String(error));
      } finally {
        setPopupBusy(null);
      }
    },
    [popupBusy, popupRequest],
  );

  return (
    <div className="browser-pane">
      <div className="browser-page-tabs" role="tablist" aria-label="웹 페이지">
        {pages.map((page) => (
          <button
            key={page.pageId}
            role="tab"
            aria-selected={page.pageId === active?.pageId}
            className={`browser-page-tab ${page.pageId === active?.pageId ? 'active' : ''}`}
            onClick={() => void xgen.browser.activate(page.pageId)}
            title={page.title || page.url}
          >
            <BrowserIcon size={12} />
            <span>{page.title || '새 탭'}</span>
            {page.loading === 'loading' && <i className="browser-loading-dot" />}
            <span
              className="browser-page-close"
              role="button"
              aria-label="웹 페이지 닫기"
              onClick={(event) => {
                event.stopPropagation();
                void closePage(page);
              }}
            >
              <CloseIcon size={11} />
            </span>
          </button>
        ))}
        <button
          className="browser-page-add"
          title="새 웹 페이지"
          aria-label="새 웹 페이지"
          onClick={addPage}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const selected = suggestionsOpen ? suggestions[suggestionIndex] : undefined;
          if (selected) {
            openAddress(selected.url);
            return;
          }
          const target = resolveBrowserAddress(address, addressSearch);
          if (!target) {
            setNavigationError(
              addressSearch?.enabled
                ? '올바른 http/https 주소 또는 검색어를 입력해 주세요.'
                : '올바른 http/https 주소를 입력해 주세요. 주소창 검색은 설정에서 켤 수 있습니다.',
            );
            return;
          }
          setSuggestionsOpen(false);
          setSuggestionIndex(-1);
          addressInputRef.current?.blur();
          void navigate('goto', target);
        }}
      >
        <button
          type="button"
          disabled={!active?.canGoBack}
          aria-label="뒤로"
          onClick={() => void navigate('back')}
        >
          <BackIcon size={15} />
        </button>
        <button
          type="button"
          disabled={!active?.canGoForward}
          aria-label="앞으로"
          onClick={() => void navigate('forward')}
        >
          <ForwardIcon size={15} />
        </button>
        <button
          type="button"
          aria-label={active?.loading === 'loading' ? '중지' : '새로고침'}
          onClick={() => void navigate(active?.loading === 'loading' ? 'stop' : 'reload')}
        >
          {active?.loading === 'loading' ? <StopIcon size={13} /> : <RefreshIcon size={15} />}
        </button>
        <div className="browser-address-shell">
          <input
            ref={addressInputRef}
            value={address}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => {
              setAddressFocused(false);
              setSuggestionsOpen(false);
              setSuggestionIndex(-1);
            }}
            onChange={(event) => {
              setAddress(event.target.value);
              setNavigationError('');
              setSuggestions([]);
              setSuggestionsOpen(false);
              setSuggestionIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && suggestions.length) {
                event.preventDefault();
                setSuggestionsOpen(true);
                setSuggestionIndex((index) => Math.min(suggestions.length - 1, index + 1));
              } else if (event.key === 'ArrowUp' && suggestionsOpen) {
                event.preventDefault();
                setSuggestionIndex((index) => Math.max(-1, index - 1));
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setSuggestionsOpen(false);
                setSuggestionIndex(-1);
              }
            }}
            role="combobox"
            aria-label="주소"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            aria-controls="browser-address-suggestions"
            aria-activedescendant={
              suggestionIndex >= 0 ? `browser-address-suggestion-${suggestionIndex}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder={addressSearch?.enabled ? 'URL 또는 검색어 입력' : 'URL 입력'}
          />
          {suggestionsOpen && (
            <div
              id="browser-address-suggestions"
              className="browser-address-suggestions"
              role="listbox"
              aria-label="방문 기록 자동완성"
            >
              {suggestions.map((suggestion, index) => (
                <button
                  id={`browser-address-suggestion-${index}`}
                  key={suggestion.placeId}
                  type="button"
                  role="option"
                  aria-selected={suggestionIndex === index}
                  className={`browser-address-suggestion ${suggestionIndex === index ? 'active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSuggestionIndex(index)}
                  onClick={() => openAddress(suggestion.url)}
                >
                  <HistoryIcon size={14} />
                  <span className="browser-address-suggestion-copy">
                    <strong>{suggestion.title || suggestion.url}</strong>
                    <small>{suggestion.url}</small>
                  </span>
                  {suggestion.visitCount > 1 && (
                    <span className="browser-address-visit-count">{suggestion.visitCount}회</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className={historyOpen ? 'active' : ''}
          disabled={!state.enabled}
          aria-label={historyOpen ? '방문 기록 닫기' : '방문 기록 열기'}
          title="방문 기록"
          onClick={toggleHistory}
        >
          <HistoryIcon size={15} />
        </button>
        <span className="browser-toolbar-divider" aria-hidden />
        <button
          type="button"
          className={
            selection &&
            active &&
            selection.pageId === active.pageId &&
            selection.mode === 'element'
              ? 'active'
              : ''
          }
          disabled={!active || active.loading === 'loading'}
          aria-label="요소를 채팅 컨텍스트로 선택"
          title="요소 선택 후 채팅에 첨부"
          onClick={() => active && onStartSelection(active, 'element')}
        >
          <ElementSelectIcon size={15} />
        </button>
        <button
          type="button"
          className={
            selection && active && selection.pageId === active.pageId && selection.mode === 'region'
              ? 'active'
              : ''
          }
          disabled={!active || active.loading === 'loading'}
          aria-label="영역을 채팅 컨텍스트로 선택"
          title="영역을 드래그하여 채팅에 첨부"
          onClick={() => active && onStartSelection(active, 'region')}
        >
          <RegionSelectIcon size={15} />
        </button>
      </form>
      {popupRequest && (
        <div className="browser-popup-notice" role="alert">
          <button
            type="button"
            className="browser-popup-summary"
            aria-expanded={popupExpanded}
            onClick={() => setPopupExpanded((expanded) => !expanded)}
          >
            <PopupBlockedIcon size={15} />
            <span>
              <strong>{popupRequest.openerOrigin}</strong>에서 팝업을 차단했습니다.
              {popupRequests.length > 1 ? ` (${popupRequests.length}개)` : ''}
            </span>
            <span className="browser-popup-configure">{popupExpanded ? '닫기' : '설정'}</span>
          </button>
          {popupExpanded && (
            <div className="browser-popup-detail">
              <div className="browser-popup-target" title={popupRequest.targetDisplayUrl}>
                대상: {popupRequest.targetDisplayUrl}
              </div>
              <div className="browser-popup-actions">
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('allow_always')}
                >
                  항상 허용
                </button>
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('allow_session')}
                >
                  이번 세션만
                </button>
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('block')}
                >
                  계속 차단
                </button>
              </div>
              {popupError && <div className="browser-popup-error">{popupError}</div>}
            </div>
          )}
        </div>
      )}
      {navigationError && <div className="browser-error">{navigationError}</div>}
      {active?.error && <div className="browser-error">{active.error}</div>}
      {historyOpen ? (
        <section className="browser-history" aria-label="방문 기록">
          <header className="browser-history-header">
            <div>
              <strong>방문 기록</strong>
              <span>
                {history.total > history.items.length
                  ? `최근 ${history.items.length}개 · 전체 ${history.total}개`
                  : `${history.total}개`}
              </span>
            </div>
            <button
              type="button"
              className={confirmHistoryClear ? 'danger' : ''}
              disabled={history.total === 0 || !!historyBusy}
              onClick={() => void clearHistory()}
            >
              <TrashIcon size={13} />
              {confirmHistoryClear ? '한 번 더 눌러 전체 삭제' : '전체 삭제'}
            </button>
          </header>
          {historyError && <div className="browser-history-message error">{historyError}</div>}
          {historyLoading ? (
            <div className="browser-history-message">방문 기록을 불러오는 중…</div>
          ) : history.items.length === 0 ? (
            <div className="browser-history-message">저장된 방문 기록이 없습니다.</div>
          ) : (
            <div className="browser-history-list">
              {history.items.map((visit) => (
                <div className="browser-history-row" key={visit.visitId}>
                  <button
                    type="button"
                    className="browser-history-link"
                    onClick={() => openAddress(visit.url)}
                    title={visit.url}
                  >
                    <HistoryIcon size={14} />
                    <span className="browser-history-copy">
                      <strong>{visit.title || visit.url}</strong>
                      <small>{visit.url}</small>
                    </span>
                    <time dateTime={new Date(visit.visitedAt).toISOString()}>
                      {historyTime(visit.visitedAt)}
                    </time>
                  </button>
                  <button
                    type="button"
                    className="browser-history-remove"
                    disabled={!!historyBusy}
                    aria-label={`${visit.title || visit.url} 방문 기록 삭제`}
                    title="이 방문 기록 삭제"
                    onClick={() => void removeHistoryVisit(visit)}
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <div ref={surfaceRef} className="browser-surface-anchor">
          {!state.enabled && (
            <div className="browser-empty">설정에서 브라우저 접근을 켜 주세요.</div>
          )}
          {state.enabled && !active && (
            <div className="browser-empty">브라우저 페이지를 준비하는 중…</div>
          )}
        </div>
      )}
    </div>
  );
};
