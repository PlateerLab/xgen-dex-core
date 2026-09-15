/**
 * 작업 과정 표시 **모드** — 채팅 입력창 도구 줄 오른쪽의 [작업 과정 켜짐 ⌄].
 *
 * 예전에는 답마다 [간단히]/[과정 보기] 가 붙어 있어서, 스크롤에 가려지거나 과정이 없는 답만 보이면
 * 다시 켤 곳이 없었다. 표시 방식은 대화 하나가 아니라 사용자의 보기 설정이므로 입력창의 모드로 둔다
 * (2026-09-16 사용자 요청 "대화에 있는 게 아니라 모드로 있어야 하는 거 아님?"). 고른 값은 모든 대화에
 * 적용되고 앱을 다시 켜도 유지된다(useProcessView).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from '../brand/icons';
import { useProcessView } from './ProcessTimeline';

const MODES = [
  { on: true, key: 'on', name: '작업 과정 보기', desc: '진행 단계와 도구 호출·결과를 타임라인으로 보여 줍니다' },
  { on: false, key: 'off', name: '답만 보기', desc: '진행 중에는 도구 이름만, 끝나면 답만 보여 줍니다' },
] as const;

const CheckMark: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const ProcessModeSelect: React.FC = () => {
  const [on, , setOn] = useProcessView();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="composer-mode-wrap" ref={wrapRef}>
      <button
        type="button"
        className="composer-mode"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="작업 과정 표시 방식 — 모든 대화에 적용"
      >
        <span>작업 과정</span>
        <span className="composer-mode-value">{on ? '켜짐' : '꺼짐'}</span>
        <span className="composer-mode-chevron" aria-hidden>
          <ChevronDownIcon size={14} />
        </span>
      </button>
      {open && (
        <div className="composer-mode-menu" role="menu" aria-label="작업 과정 표시">
          <div className="composer-mode-menu-title">작업 과정 표시 · 모든 대화에 적용</div>
          {MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              role="menuitemradio"
              aria-checked={on === mode.on}
              data-mode={mode.key}
              className="composer-mode-option"
              onClick={() => {
                setOn(mode.on);
                setOpen(false);
              }}
            >
              <span className="composer-mode-option-name">{mode.name}</span>
              <span className="composer-mode-option-check" aria-hidden>
                {on === mode.on && <CheckMark />}
              </span>
              <span className="composer-mode-option-desc">{mode.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
