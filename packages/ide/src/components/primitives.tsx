/** IDE 전체에서 쓰는 작은 부품 — 분할 핸들·아이콘 버튼·컨텍스트 메뉴·대화 상자. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './icons';

/** 브라우저에서만 레이아웃 효과 — 서버 렌더(웹)에서는 그냥 효과(경고 없이). */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import { useFocusReturn, useIde } from './hooks';
import { formatBinding } from '../keys';

// ── 분할 핸들 ─────────────────────────────────────────────────────────

/**
 * 끌어서 크기를 바꾼다. `axis='x'` 면 가로 폭, `'y'` 면 높이. `invert` 는 핸들이 대상의
 * 왼쪽(위쪽)에 있어 끄는 방향과 크기가 반대로 움직일 때.
 */
export function SplitHandle({
  axis,
  value,
  min,
  max,
  invert,
  onChange,
  onDoubleClick,
  label,
}: {
  axis: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (v: number) => void;
  onDoubleClick?: () => void;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ pos: number; value: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos: axis === 'x' ? e.clientX : e.clientY, value };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const delta = (axis === 'x' ? e.clientX : e.clientY) - start.current.pos;
    const next = start.current.value + (invert ? -delta : delta);
    onChange(Math.round(Math.max(min, Math.min(max, next))));
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const dec = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const inc = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const dir = (e.key === inc ? 1 : -1) * (invert ? -1 : 1);
    onChange(Math.max(min, Math.min(max, value + dir * step)));
  };
  return (
    <div
      className={`xide-split xide-split-${axis}${dragging ? ' xide--dragging' : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

// ── 버튼 ──────────────────────────────────────────────────────────────

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  keybinding,
  className,
  badge,
}: {
  icon: IconName;
  label: string;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  keybinding?: string;
  className?: string;
  badge?: number | string;
}) {
  const title = keybinding ? `${label} (${formatBinding(keybinding)})` : label;
  return (
    <button
      type="button"
      className={`xide-ibtn${active ? ' xide--active' : ''}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      {badge != null && badge !== 0 && badge !== '' ? <span className="xide-badge">{badge}</span> : null}
    </button>
  );
}

// ── 컨텍스트 메뉴 ─────────────────────────────────────────────────────

export interface MenuItem {
  id: string;
  label: string;
  keybinding?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

export type MenuEntry = MenuItem | 'separator';

let openMenu: ((v: { x: number; y: number; items: MenuEntry[] } | null) => void) | null = null;

/** 어디서든 메뉴를 띄운다 — IdeView 가 그리는 한 곳(`<MenuHost/>`)에 뜬다. */
export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]): void {
  e.preventDefault?.();
  openMenu?.({ x: e.clientX, y: e.clientY, items });
}

export function MenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  useFocusReturn(!!menu);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    openMenu = (m) => {
      setMenu(m);
      setActive(-1);
      setPos(null);
    };
    return () => {
      openMenu = null;
    };
  }, []);

  useIsoLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth - r.width - 4);
    const top = menu.y + r.height > window.innerHeight - 4 ? Math.max(4, menu.y - r.height) : menu.y;
    setPos({ left: Math.max(4, left), top });
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      setMenu(null);
    };
    const onBlur = () => setMenu(null);
    // 메뉴에 초점이 없어도(띄운 쪽이 초점을 가져갔어도) Esc 는 닫는다. 초점이 메뉴 밖으로 가도 닫는다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('focusin', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('focusin', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [menu]);

  if (!menu) return null;
  const items = menu.items;
  const selectable = items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const run = (it: MenuEntry) => {
    if (it === 'separator' || it.disabled) return;
    setMenu(null);
    it.run();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenu(null);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = selectable.indexOf(active);
      const next = e.key === 'ArrowDown' ? selectable[(at + 1) % selectable.length] : selectable[(at - 1 + selectable.length) % selectable.length];
      setActive(next ?? -1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      run(items[active]);
    }
  };
  return (
    <div
      ref={ref}
      className="xide-menu"
      role="menu"
      tabIndex={-1}
      style={pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={`sep${i}`} className="xide-menu-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={`xide-menu-item${i === active ? ' xide--active' : ''}${it.danger ? ' xide--danger' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(it)}
          >
            <span className="xide-menu-label">{it.label}</span>
            {it.keybinding ? <span className="xide-menu-key">{formatBinding(it.keybinding)}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

// ── 대화 상자 ─────────────────────────────────────────────────────────

export function DialogHost() {
  const dialog = useIde((s) => s.dialog);
  useFocusReturn(!!dialog);
  const [value, setValue] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dialog) return;
    setValue(dialog.input?.value ?? '');
    setFields(Object.fromEntries((dialog.fields ?? []).map((f) => [f.id, f.value])));
    setError(null);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        const sel = dialog.input?.select;
        if (sel) input.setSelectionRange(sel[0], sel[1]);
        else input.select();
      } else {
        const first = boxRef.current?.querySelector<HTMLElement>('input, button.xide--primary, button');
        first?.focus();
      }
    });
  }, [dialog]);

  if (!dialog) return null;
  const finish = (button: string) => {
    if (button !== 'cancel' && dialog.input && dialog.validate) {
      const bad = dialog.validate(value);
      if (bad) {
        setError(bad);
        return;
      }
    }
    dialog.resolve({ button, value, fields });
  };
  const primary = dialog.buttons.find((b) => b.primary) ?? dialog.buttons[0];
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish('cancel');
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      finish(primary.id);
    }
  };
  return (
    <div className="xide-dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && finish('cancel')}>
      <div
        ref={boxRef}
        className="xide-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onKeyDown={onKeyDown}
      >
        <div className="xide-dialog-title">{dialog.title}</div>
        {dialog.message ? <div className="xide-dialog-message">{dialog.message}</div> : null}
        {dialog.input ? (
          <input
            ref={inputRef}
            className={`xide-input${error ? ' xide--invalid' : ''}`}
            value={value}
            placeholder={dialog.input.placeholder}
            type={dialog.input.password ? 'password' : 'text'}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setError(dialog.validate ? dialog.validate(e.target.value) : null);
            }}
          />
        ) : null}
        {dialog.fields?.map((f, i) => (
          <label key={f.id} className="xide-dialog-field">
            <span>{f.label}</span>
            <input
              ref={i === 0 ? inputRef : undefined}
              className="xide-input"
              value={fields[f.id] ?? ''}
              placeholder={f.placeholder}
              type={f.password ? 'password' : 'text'}
              spellCheck={false}
              autoComplete={f.password ? 'new-password' : 'off'}
              onChange={(e) => setFields((cur) => ({ ...cur, [f.id]: e.target.value }))}
            />
          </label>
        ))}
        {error ? <div className="xide-dialog-error">{error}</div> : null}
        {dialog.detail ? <div className="xide-dialog-detail">{dialog.detail}</div> : null}
        <div className="xide-dialog-buttons">
          {dialog.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`xide-btn${b.primary ? ' xide--primary' : ''}${b.danger ? ' xide--danger' : ''}`}
              onClick={() => finish(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 탐색기·검색의 줄 안 입력 ──────────────────────────────────────────

export function InlineInput({
  initial,
  select,
  validate,
  onDone,
  onCancel,
  className,
}: {
  initial: string;
  select?: [number, number];
  validate?: (v: string) => string | null;
  onDone: (v: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (select) el.setSelectionRange(select[0], select[1]);
    else el.select();
  }, [select]);
  const commit = useCallback(() => {
    if (settled.current) return;
    const bad = validate?.(value) ?? null;
    if (bad) {
      setError(bad);
      return;
    }
    settled.current = true;
    if (value.trim() === initial.trim() || !value.trim()) onCancel();
    else onDone(value.trim());
  }, [value, validate, initial, onDone, onCancel]);
  return (
    <span className={`xide-inline-input${className ? ` ${className}` : ''}`}>
      <input
        ref={ref}
        className={`xide-input${error ? ' xide--invalid' : ''}`}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(validate?.(e.target.value) ?? null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            settled.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (settled.current) return;
          if (error || !value.trim()) {
            settled.current = true;
            onCancel();
          } else commit();
        }}
      />
      {error ? <span className="xide-inline-error">{error}</span> : null}
    </span>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="xide-empty">
      {icon ? <Icon name={icon} size={28} /> : null}
      <div>{children}</div>
    </div>
  );
}
