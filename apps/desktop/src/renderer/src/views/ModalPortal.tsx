import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

let overlay: Window | null = null;
let ready: Promise<void>;
let stopWaiting: (() => void) | undefined;
let users = 0;

export function ModalPortal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}): ReactNode {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!overlay || overlay.closed) {
      overlay = window.open(new URL('modal.html', document.baseURI).href, 'xgen-modal-overlay');
      if (!overlay) throw new Error('모달 표시 창을 열지 못했습니다.');
      const opened = overlay;
      // Mount only into the committed document, after its own script reports ready.
      ready = new Promise((resolve) => {
        const onReady = (event: MessageEvent): void => {
          if (event.source !== opened || event.data !== 'xgen-modal-ready') return;
          stopWaiting?.();
          const doc = opened.document;
          const base = doc.createElement('base');
          base.href = document.baseURI;
          doc.head.append(base);
          document.querySelectorAll('style, link[rel="stylesheet"]').forEach((style) => {
            doc.head.append(style.cloneNode(true));
          });
          doc.documentElement.lang = document.documentElement.lang;
          doc.body.style.setProperty('background', 'transparent', 'important');
          // Existing Escape handlers live in the opener document.
          doc.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const forwarded = new KeyboardEvent('keydown', {
              key: event.key,
              bubbles: true,
              cancelable: true,
              isComposing: event.isComposing,
            });
            if (!document.dispatchEvent(forwarded)) event.preventDefault();
          });
          resolve();
        };
        window.addEventListener('message', onReady);
        stopWaiting = () => window.removeEventListener('message', onReady);
      });
    }
    const current = overlay;
    let cancelled = false;
    let closing = false;
    let container: HTMLElement | undefined;
    let observer: MutationObserver | undefined;
    const close = (): void => {
      closing = true;
      latestClose.current();
    };
    users += 1;
    void ready.then(() => {
      if (cancelled || current.closed) return;
      current.addEventListener('beforeunload', close);
      const syncTheme = (): void => {
        const theme = document.documentElement.getAttribute('data-theme');
        if (theme) current.document.documentElement.setAttribute('data-theme', theme);
        else current.document.documentElement.removeAttribute('data-theme');
      };
      syncTheme();
      observer = new MutationObserver(syncTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      container = current.document.createElement('div');
      current.document.body.append(container);
      setTarget(container);
      current.focus();
    });
    return () => {
      cancelled = true;
      if (!current.closed) current.removeEventListener('beforeunload', close);
      observer?.disconnect();
      container?.remove();
      users -= 1;
      if (users === 0) {
        stopWaiting?.();
        if (!closing && !current.closed) current.close();
        overlay = null;
        if (focused instanceof HTMLElement && focused.tagName !== 'WEBVIEW' && focused.isConnected)
          focused.focus();
      }
    };
  }, []);
  return target ? createPortal(children, target) : null;
}
