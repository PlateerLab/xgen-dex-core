/**
 * Selector — xgen 표준 셀렉터를 커넥터 스택(플레인 CSS·무의존)으로 옮긴 것.
 *
 * xgen-frontend `packages/ui/src/inputs/selector.tsx` 의 **공개 API·동작·디자인**을
 * 그대로 미러링한다. 프론트엔드 원본은 Radix Select + shadcn(Popover)+tailwind
 * 기반이라 여기(무 tailwind·무 radix)에 그대로 복사할 수 없어, 같은 계약으로
 * 재구현했다:
 *
 *   · 트리거(셰브론) + 팝오버 목록, 선택 항목 체크표시
 *   · `searchable`: 팝오버 안 검색 입력 + 필터(방향키/Enter/Esc, active 스크롤)
 *   · options / groups(optgroup) / icon / count / size(sm·md·lg)
 *
 * 프론트엔드와 유일한 차이는 팝오버 배치다: radix 포털·충돌회피 대신 트리거
 * 기준 absolute 로 아래에 펼치고 내부 스크롤(max-height)로 처리한다 — 설정
 * 화면처럼 스크롤 컨테이너 안에서 충분하고, 의존성이 0이다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon } from '../brand/icons';
import { filterOptions } from './selector-filter';

export interface SelectorOption {
  value: string;
  label: React.ReactNode;
  /** 검색 필터에 쓸 텍스트. label 이 문자열이 아니면 지정 권장. */
  keywords?: string;
  disabled?: boolean;
  /** 라벨 왼쪽 아이콘 (선택). */
  icon?: React.ReactNode;
  /** 목록에서 "라벨 (N)" 형태로 개수 표시 (선택). 트리거에는 라벨만. */
  count?: number;
}

export interface SelectorGroup {
  label: string;
  options: SelectorOption[];
}

export interface SelectorProps {
  value?: string;
  onChange?: (value: string) => void;
  /** 평면 옵션. `groups` 를 주면 무시된다. */
  options?: SelectorOption[];
  /** 그룹(optgroup) 옵션. 주면 options 대신 사용. */
  groups?: SelectorGroup[];
  placeholder?: string;
  disabled?: boolean;
  /** 팝오버 안 검색 입력 노출 (옵션이 많을 때). */
  searchable?: boolean;
  searchPlaceholder?: string;
  size?: 'sm' | 'md' | 'lg';
  /** 트리거에 붙일 추가 클래스 (예: 폭). */
  className?: string;
  /** 결과 없음 문구 (searchable). */
  emptyText?: string;
  ariaLabel?: string;
  /** QA/문서 계약용 안정 DOM 식별자. */
  uiId?: string;
}

function optionBody(option: SelectorOption): React.ReactNode {
  return (
    <>
      {option.icon != null && <span className="selector-opt-icon">{option.icon}</span>}
      <span className="selector-opt-label">{option.label}</span>
      {option.count != null && <span className="selector-opt-count">({option.count})</span>}
    </>
  );
}

export const Selector: React.FC<SelectorProps> = ({
  value,
  onChange,
  options,
  groups,
  placeholder = '선택',
  disabled = false,
  searchable = false,
  searchPlaceholder = '검색…',
  size = 'md',
  className,
  emptyText = '결과가 없습니다',
  ariaLabel,
  uiId,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 그룹이 있으면 평면화 — 검색 목록은 헤더 없이 단일 리스트로 다룬다.
  const flatOptions = useMemo(
    () => (groups ? groups.flatMap((g) => g.options) : (options ?? [])),
    [groups, options],
  );
  const selected = useMemo(() => flatOptions.find((o) => o.value === value), [flatOptions, value]);
  const filtered = useMemo(() => filterOptions(flatOptions, query), [flatOptions, query]);

  // 열릴 때: 검색 초기화 + 현재 선택으로 active 맞춤 + 검색 입력 포커스.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const idx = flatOptions.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    if (searchable) requestAnimationFrame(() => inputRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 바깥 클릭·Esc 로 닫는다 (radix 포털 대신 수동).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // active 항목이 항상 보이도록 스크롤.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open, filtered.length]);

  const commit = useCallback(
    (v: string) => {
      onChange?.(v);
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const o = filtered[active];
        if (o && !o.disabled) commit(o.value);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    [filtered, active, commit],
  );

  const list = (
    <div className="selector-list" ref={listRef} role="listbox">
      {filtered.length === 0 ? (
        <div className="selector-empty">{emptyText}</div>
      ) : (
        filtered.map((o, i) => {
          const isSelected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={isSelected}
              data-idx={i}
              disabled={o.disabled}
              className={`selector-opt ${isSelected ? 'selected' : ''} ${active === i ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => !o.disabled && commit(o.value)}
            >
              <span className="selector-opt-main">{optionBody(o)}</span>
              {isSelected && <span className="selector-check">✓</span>}
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <div className={`selector size-${size} ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        data-ui-id={uiId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className={`selector-trigger ${selected ? '' : 'placeholder'} ${open ? 'open' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          // 닫힌 상태에서 방향키/Enter 로 바로 열려 방향 이동을 잇는다.
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          } else if (open && !searchable) {
            onKeyDown(e);
          }
        }}
      >
        <span className="selector-value">{selected ? optionBody(selected) : placeholder}</span>
        <ChevronDownIcon size={16} className="selector-chevron" />
      </button>

      {open && (
        <div className="selector-pop" role="dialog">
          {searchable && (
            <div className="selector-search">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          {list}
        </div>
      )}
    </div>
  );
};
