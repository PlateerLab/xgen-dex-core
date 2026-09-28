/**
 * 단축키 — `Mod` 는 맥에서 Cmd, 그 밖에서 Ctrl. 두 번 누르는 조합(`Mod+K S`)도 받는다.
 *
 * 편집기 안(Monaco)의 단축키는 Monaco 가 처리한다. 여기는 IDE 전체의 것(저장·빠른 열기·
 * 패널 토글)이고, 편집기가 먼저 먹지 않도록 Monaco 에도 같은 명령을 건다(IdeView).
 */

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export interface KeyStroke {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseStroke(spec: string): KeyStroke {
  const parts = spec.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const set = new Set(parts.map((p) => p.toLowerCase()));
  return { mod: set.has('mod'), shift: set.has('shift'), alt: set.has('alt'), key: key.toLowerCase() };
}

export function parseBinding(spec: string): KeyStroke[] {
  return spec.split(' ').filter(Boolean).map(parseStroke);
}

/** 이벤트의 키 이름 — 배열이 바뀌어도(한글 입력 상태) 물리 키로 맞춘다. */
export function eventKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const code = e.code || '';
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Backquote') return '`';
  if (code === 'Backslash') return '\\';
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Equal') return '=';
  if (code === 'Minus') return '-';
  return (e.key || '').toLowerCase();
}

export function matchesStroke(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  s: KeyStroke,
  mac = isMac,
): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  return (
    mod === s.mod && !otherMod && e.shiftKey === s.shift && e.altKey === s.alt && eventKey(e) === s.key
  );
}

/** 화면에 보일 표기 — `Mod+Shift+P` → `Ctrl+Shift+P` / `⇧⌘P`. */
export function formatBinding(spec: string, mac = isMac): string {
  return parseBinding(spec)
    .map((s) => {
      const key = s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1);
      if (mac) return `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${key}`;
      return [s.mod ? 'Ctrl' : '', s.shift ? 'Shift' : '', s.alt ? 'Alt' : '', key].filter(Boolean).join('+');
    })
    .join(' ');
}

/**
 * 조합 판정기 — 첫 타가 맞으면 다음 타를 기다린다(1.5초).
 * `feed` 는 끝까지 맞으면 그 바인딩을, 기다리는 중이면 `'pending'` 을, 아니면 null 을 준다.
 */
export class ChordMatcher<T extends string> {
  private pending: { binding: T; strokes: KeyStroke[] }[] | null = null;
  private pendingAt = 0;
  private readonly table: { binding: T; strokes: KeyStroke[] }[];

  constructor(bindings: Record<T, string>, private readonly mac = isMac) {
    this.table = (Object.keys(bindings) as T[]).map((b) => ({ binding: b, strokes: parseBinding(bindings[b]) }));
  }

  feed(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): T | 'pending' | null {
    if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return this.pending ? 'pending' : null;
    const now = Date.now();
    if (this.pending && now - this.pendingAt < 1500) {
      const hit = this.pending.find((p) => matchesStroke(e, p.strokes[1], this.mac));
      this.pending = null;
      if (hit) return hit.binding;
      return null;
    }
    this.pending = null;
    for (const row of this.table) {
      if (row.strokes.length === 1 && matchesStroke(e, row.strokes[0], this.mac)) return row.binding;
    }
    const starts = this.table.filter((r) => r.strokes.length === 2 && matchesStroke(e, r.strokes[0], this.mac));
    if (starts.length) {
      this.pending = starts;
      this.pendingAt = now;
      return 'pending';
    }
    return null;
  }
}
