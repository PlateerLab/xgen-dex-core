/**
 * 툴팁 — 아이콘만 있는 단추에 마우스를 올리거나(초점을 두면) 이름이 뜬다.
 *
 * 브라우저 기본 `title` 은 늦게 뜨고 앱 모양과 다르다. 이 부품은 앱 색·글꼴로, 단추 위(자리가
 * 없으면 아래)에 붙어 뜬다. 문서 끝(body)에 그려서 스크롤 칸·잘림(overflow) 밖으로도 보인다.
 * 단추의 접근성 이름은 `aria-label` 로 따로 준다(툴팁은 눈으로 보는 것).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 350;

export const Tooltip: React.FC<{
  /** 뜨는 글 — 비면 툴팁이 없다. */
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}> = ({ label, children, side = 'top', className }) => {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
    setPos(null);
  }, []);
  const show = useCallback(() => {
    if (!label) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }, [label]);

  useEffect(() => hide, [hide]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  // 자리를 잰다 — 위에 자리가 없으면 아래, 창 밖으로 나가지 않게 가로를 당긴다.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const below = side === 'bottom' || a.top - b.height - 8 < 4;
    const left = Math.min(Math.max(4, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - 4);
    const top = below ? a.bottom + 6 : a.top - b.height - 6;
    setPos({ left, top, below });
  }, [open, side, label]);

  return (
    <span
      ref={anchor}
      className={`dex-tip-anchor${className ? ` ${className}` : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onMouseDown={hide}
    >
      {children}
      {open && label
        ? createPortal(
            <div
              ref={bubble}
              className={`dex-tip${pos?.below ? ' below' : ''}`}
              role="tooltip"
              style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
};
