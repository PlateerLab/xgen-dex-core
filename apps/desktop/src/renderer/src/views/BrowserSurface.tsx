import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrowserPageInfo,
  BrowserSelectionPoint,
  BrowserSelectionPreview,
  BrowserSelectionRect,
  BrowserSelectionResult,
  BrowserSelectionSession,
} from '@dex/protocol/browser';
import { xgen } from '../bridge';
import type { BrowserSurfaceRect } from './BrowserPane';

type ElectronWebview = HTMLElement & {
  getWebContentsId(): number;
  __xgenAttachBound?: boolean;
  __xgenFocusBound?: boolean;
};

const PersistentWebview: React.FC<{
  page: BrowserPageInfo;
  rect?: BrowserSurfaceRect;
  dragging: boolean;
  onFocusPage: (pageId: string) => void;
}> = ({ page, rect, dragging, onFocusPage }) => {
  // src/partition remain creation values. Reflecting every navigation into src
  // would reload SPAs and lose scroll/form state.
  const initial = useRef({ src: page.url, partition: page.partition });
  const style: React.CSSProperties = rect
    ? {
        left: rect.left,
        top: rect.top,
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        visibility: 'visible',
        pointerEvents: dragging ? 'none' : 'auto',
      }
    : {
        left: -10000,
        top: -10000,
        width: 1,
        height: 1,
        visibility: 'hidden',
        pointerEvents: 'none',
      };
  const setRef = (element: ElectronWebview | null): void => {
    if (!element) return;
    const bind = () => {
      try {
        void xgen.browser
          .bindShared(page.pageId, element.getWebContentsId())
          .catch(() => undefined);
      } catch {
        /* attachment can race with a closed tab */
      }
    };
    if (!element.__xgenAttachBound) {
      element.__xgenAttachBound = true;
      element.addEventListener('did-attach', bind, { once: true });
    }
    if (!element.__xgenFocusBound) {
      element.__xgenFocusBound = true;
      element.addEventListener('focus', () => onFocusPage(page.pageId));
    }
    // React can receive the ref after Electron already emitted did-attach.
    // The immediate attempt covers that ordering; the listener covers the inverse.
    bind();
  };
  return React.createElement('webview', {
    ref: setRef,
    className: 'browser-webview',
    src: initial.current.src,
    partition: initial.current.partition,
    // Electron disables popup requests before they reach setWindowOpenHandler
    // unless this attribute is present. The main process still returns `deny`
    // for every request and replays only user-approved URLs as managed tabs.
    allowpopups: 'true',
    webpreferences: 'sandbox=yes,contextIsolation=yes,nodeIntegration=no,webSecurity=yes',
    style,
  });
};

const SelectionOverlay: React.FC<{
  page: BrowserPageInfo;
  rect: BrowserSurfaceRect;
  session: BrowserSelectionSession;
  onComplete: (selection: BrowserSelectionResult) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}> = ({ page, rect, session, onComplete, onCancel, onError }) => {
  const [preview, setPreview] = useState<BrowserSelectionPreview | null>(null);
  const [dragRect, setDragRect] = useState<BrowserSelectionRect | null>(null);
  const [busy, setBusy] = useState(false);
  const dragStart = useRef<BrowserSelectionPoint | null>(null);
  const inspectAt = useRef(0);
  const inspectSequence = useRef(0);

  const pointFor = useCallback(
    (event: React.PointerEvent): BrowserSelectionPoint => ({
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    }),
    [rect.height, rect.left, rect.top, rect.width],
  );

  const cancel = useCallback(() => {
    void xgen.browser.cancelSelection(session.token).catch(() => undefined);
    onCancel();
  }, [onCancel, session.token]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [cancel]);

  useEffect(() => {
    if (page.generation !== session.generation) cancel();
  }, [cancel, page.generation, session.generation]);

  const finish = useCallback(
    async (request: { point?: BrowserSelectionPoint; rect?: BrowserSelectionRect }) => {
      if (busy) return;
      setBusy(true);
      try {
        const selection = await xgen.browser.completeSelection({
          token: session.token,
          ...request,
        });
        onComplete(selection);
      } catch (error) {
        onError(
          error instanceof Error ? error.message : '브라우저 선택 영역을 캡처하지 못했습니다.',
        );
        onCancel();
      } finally {
        setBusy(false);
      }
    },
    [busy, onCancel, onComplete, onError, session.token],
  );

  const pointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const point = pointFor(event);
      if (session.mode === 'region') {
        const start = dragStart.current;
        if (!start) return;
        setDragRect({
          x: Math.min(start.x, point.x),
          y: Math.min(start.y, point.y),
          width: Math.abs(point.x - start.x),
          height: Math.abs(point.y - start.y),
        });
        return;
      }
      const now = Date.now();
      if (now - inspectAt.current < 70) return;
      inspectAt.current = now;
      const sequence = ++inspectSequence.current;
      void xgen.browser
        .inspectSelection({ token: session.token, point })
        .then((next) => {
          if (sequence === inspectSequence.current) setPreview(next);
        })
        .catch((error) => {
          if (sequence !== inspectSequence.current) return;
          onError(error instanceof Error ? error.message : '요소를 확인하지 못했습니다.');
          cancel();
        });
    },
    [cancel, onError, pointFor, session.mode, session.token],
  );

  const pointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || busy) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (session.mode === 'region') {
        const point = pointFor(event);
        dragStart.current = point;
        setDragRect({ ...point, width: 0, height: 0 });
      }
    },
    [busy, pointFor, session.mode],
  );

  const pointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || busy) return;
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (session.mode === 'element') {
        void finish({ point: pointFor(event) });
        return;
      }
      const start = dragStart.current;
      dragStart.current = null;
      if (!start) return;
      const point = pointFor(event);
      const selected = {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      };
      if (selected.width < 4 || selected.height < 4) {
        setDragRect(null);
        onError('캡처할 영역을 조금 더 크게 드래그해 주세요.');
        return;
      }
      setDragRect(selected);
      void finish({ rect: selected });
    },
    [busy, finish, onError, pointFor, session.mode],
  );

  const highlight = session.mode === 'element' ? preview?.rect : dragRect;
  return (
    <div
      className={`browser-selection-overlay mode-${session.mode}${busy ? ' busy' : ''}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerMove={pointerMove}
      onPointerDown={pointerDown}
      onPointerUp={pointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="browser-selection-help">
        {busy
          ? '선택 영역을 준비하는 중…'
          : session.mode === 'element'
            ? '전송할 요소를 클릭하세요 · Esc 취소'
            : '전송할 영역을 드래그하세요 · Esc 취소'}
      </div>
      {highlight && highlight.width > 0 && highlight.height > 0 && (
        <div
          className="browser-selection-highlight"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      )}
      {session.mode === 'element' && preview && (
        <div
          className="browser-selection-label"
          style={{
            left: Math.max(4, Math.min(rect.width - 180, preview.rect.x)),
            top: Math.max(4, preview.rect.y - 25),
          }}
        >
          {preview.tag} · {preview.label || '요소'}
        </div>
      )}
    </div>
  );
};

export const BrowserSurface: React.FC<{
  pages: BrowserPageInfo[];
  rects: Record<string, BrowserSurfaceRect>;
  dragging: boolean;
  selection: BrowserSelectionSession | null;
  onFocusPage: (pageId: string) => void;
  onSelectionComplete: (selection: BrowserSelectionResult) => void;
  onSelectionCancel: () => void;
  onSelectionError: (message: string) => void;
}> = ({
  pages,
  rects,
  dragging,
  selection,
  onFocusPage,
  onSelectionComplete,
  onSelectionCancel,
  onSelectionError,
}) => (
  <div className={`browser-surface-layer ${dragging ? 'dragging' : ''}`} aria-hidden>
    {pages
      .filter((page) => page.mode === 'shared')
      .map((page) => (
        <PersistentWebview
          key={page.pageId}
          page={page}
          rect={rects[page.pageId]}
          dragging={dragging}
          onFocusPage={onFocusPage}
        />
      ))}
    {selection &&
      (() => {
        const page = pages.find((item) => item.pageId === selection.pageId);
        const rect = rects[selection.pageId];
        return page && rect ? (
          <SelectionOverlay
            key={selection.token}
            page={page}
            rect={rect}
            session={selection}
            onComplete={onSelectionComplete}
            onCancel={onSelectionCancel}
            onError={onSelectionError}
          />
        ) : null;
      })()}
  </div>
);
