/**
 * 편집기 여백의 변경 표시(VS Code 의 quick diff) — 스테이지(index) 판과 지금 버퍼를 줄 단위로 견준다.
 *
 * VS Code 처럼 기준은 **index** 다: `git add` 하면 그 줄의 표시가 사라진다. 커밋에 없는 새 파일
 * (추적 안 됨)은 표시하지 않는다(탐색기의 U 가 이미 말한다).
 *
 * 앞뒤 같은 줄을 먼저 걷어 내고 가운데만 LCS 로 견준다. 가운데가 너무 크면(파일을 통째로 바꾼
 * 경우) 가운데 전체를 바뀜으로 친다 — 타이핑마다 도는 계산이라 메모리·시간을 묶어 둔다.
 */

export type QuickDiffKind = 'added' | 'modified' | 'deleted';

export interface QuickDiffChange {
  kind: QuickDiffKind;
  /** 지금 버퍼의 줄 번호(1부터). 지운 줄은 그 자리 바로 아래 줄에 표시한다. */
  start: number;
  end: number;
}

/** LCS 표의 칸 수 한도 — 넘으면 가운데를 통째로 바뀜으로 친다. */
const MAX_CELLS = 1_000_000;

type Op = '=' | '-' | '+';

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('=');
      i += 1;
      j += 1;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      ops.push('-');
      i += 1;
    } else {
      ops.push('+');
      j += 1;
    }
  }
  while (i < n) {
    ops.push('-');
    i += 1;
  }
  while (j < m) {
    ops.push('+');
    j += 1;
  }
  return ops;
}

export function lineChanges(base: string[], cur: string[]): QuickDiffChange[] {
  let head = 0;
  while (head < base.length && head < cur.length && base[head] === cur[head]) head += 1;
  let endB = base.length;
  let endC = cur.length;
  while (endB > head && endC > head && base[endB - 1] === cur[endC - 1]) {
    endB -= 1;
    endC -= 1;
  }
  const a = base.slice(head, endB);
  const b = cur.slice(head, endC);
  if (!a.length && !b.length) return [];
  const ops: Op[] =
    a.length * b.length <= MAX_CELLS ? lcsOps(a, b) : [...a.map((): Op => '-'), ...b.map((): Op => '+')];

  const out: QuickDiffChange[] = [];
  let line = head; // 지금 버퍼에서 지나온 줄 수(0부터)
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === '=') {
      line += 1;
      k += 1;
      continue;
    }
    let dels = 0;
    let adds = 0;
    const from = line;
    while (k < ops.length && ops[k] !== '=') {
      if (ops[k] === '-') dels += 1;
      else {
        adds += 1;
        line += 1;
      }
      k += 1;
    }
    if (!adds) {
      // 지운 자리는 그 바로 아래 줄(끝이면 마지막 줄)에 표시한다.
      const at = Math.max(1, Math.min(from + 1, cur.length));
      out.push({ kind: 'deleted', start: at, end: at });
    } else {
      out.push({ kind: dels ? 'modified' : 'added', start: from + 1, end: from + adds });
    }
  }
  return out;
}

/** 줄로 나눈다(줄 끝 종류와 상관없이). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}
