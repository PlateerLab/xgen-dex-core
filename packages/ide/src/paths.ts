/** workspace 기준 경로 — 앞뒤 `/` 없이, 구분자는 `/`. 빈 문자열이 루트다. */

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of String(path ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

export function join(...segments: string[]): string {
  return normalize(segments.filter((s) => s !== '').join('/'));
}

export function dirname(path: string): string {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalize(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 확장자(점 없이, 소문자). `.bashrc` 처럼 점으로 시작하는 이름은 확장자가 없다. */
export function extname(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** `child` 가 `parent` 와 같거나 그 아래인가. */
export function isWithin(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return p === '' || c === p || c.startsWith(p + '/');
}

/** `parent` 아래에서 `name` 이 겹치지 않는 이름 — `a.txt` → `a copy.txt` → `a copy 2.txt`. */
export function uniqueCopyName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = `${stem} copy${ext}`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem} copy ${n}${ext}`;
  return candidate;
}

/** 새 이름으로 쓸 수 있는가 — 쓸 수 없으면 사유(화면 문구). */
export function invalidName(name: string): string | null {
  const n = name.trim();
  if (!n) return '이름을 입력하세요';
  if (n === '.' || n === '..') return '이 이름은 쓸 수 없습니다';
  if (/[\\\0]/.test(n)) return '이름에 쓸 수 없는 문자가 있습니다';
  if (n.startsWith('/') || n.endsWith('/')) return '이름 앞뒤에 / 를 쓸 수 없습니다';
  if (n.split('/').some((s) => !s || s === '.' || s === '..')) return '경로가 올바르지 않습니다';
  return null;
}
