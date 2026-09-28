/**
 * 빠른 열기의 퍼지 일치 — 편집기처럼 글자가 **순서대로** 나오면 맞는다.
 *
 * 점수는 이름(마지막 조각) 안의 일치·연속 일치·단어 시작 일치에 더 준다. `idx` 를 치면
 * `src/index.ts` 가 `docs/indexing-guide.md` 보다 먼저 나와야 한다.
 */

export interface FuzzyMatch {
  score: number;
  /** 일치한 글자 위치(원문 기준) — 강조 표시에 쓴다. */
  positions: number[];
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  return (
    prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ' ||
    (prev === prev.toLowerCase() && cur !== cur.toLowerCase())
  );
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const nameStart = text.lastIndexOf('/') + 1;
  // 이름 안에서 먼저 찾아 본다 — 되면 그쪽 점수가 크다.
  const tryFrom = (start: number): FuzzyMatch | null => {
    const positions: number[] = [];
    let score = 0;
    let ti = start;
    let prev = -2;
    for (const ch of q) {
      const found = lower.indexOf(ch, ti);
      if (found < 0) return null;
      positions.push(found);
      score += 1;
      if (found === prev + 1) score += 5;
      if (isBoundary(text, found)) score += 3;
      if (found >= nameStart) score += 2;
      prev = found;
      ti = found + 1;
    }
    // 짧은 이름·앞쪽 일치를 조금 더 쳐 준다.
    score -= Math.min(20, (text.length - nameStart) / 10);
    return { score, positions };
  };
  const inName = tryFrom(nameStart);
  const whole = tryFrom(0);
  if (inName && whole) return inName.score >= whole.score ? inName : whole;
  return inName ?? whole;
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
  limit = 200,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, key(item));
    if (m) out.push({ item, match: m });
  }
  out.sort((a, b) => b.match.score - a.match.score || key(a.item).length - key(b.item).length);
  return out.slice(0, limit);
}
