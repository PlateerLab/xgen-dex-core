/**
 * 호출어 — 계속 듣기를 켜 두어도 호출어("헤이 엑스젠")를 들은 말만 조작·채팅으로 넘긴다(설정 voiceWake).
 * 발표·회의처럼 사람에게 하는 말이 섞이는 자리에서, 그 말로 화면을 누르거나 채팅을 보내지 않게 하려는 것이다.
 *
 * 인식기는 호출어를 매번 조금씩 다르게 적는다(10/16 XGEN STT 실측: "헤이 엑스젠", "헤이 엑젠", "해이 엑스젠",
 * "헤이엑스젠", "Hey XGEN", "Hey Gen", 뒷말과 붙은 "엑스젠이 폴더의"). 그래서 한글은 자모로 풀고 띄어쓰기·
 * 문장부호를 뺀 뒤, 말 어디서든 호출어와 편집 거리가 길이의 20% 이하인 구간을 찾는다.
 */

/** 호출어 기본값 — 설정에서 쉼표로 여러 개를 적는다(인식기가 영어로 적는 경우까지). */
export const DEFAULT_WAKE_WORDS = '헤이 엑스젠, Hey XGEN';
/** 호출어만 말하고 멈췄을 때 다음 말을 호출어 없이 받아 주는 시간. 한 번 받으면 닫힌다. */
export const WAKE_WINDOW_MS = 8_000;
/** 이보다 짧은 호출어(자모 수)는 쓰지 않는다 — 흔한 말에 걸린다. */
const MIN_SYMBOLS = 4;
const MAX_ERROR_RATE = 0.2;

type Symbols = { sym: string[]; src: number[] };

/** 글자를 비교 단위로 — 한글 음절은 초성·중성·종성, 영문·숫자는 소문자 한 글자. 나머지(공백·문장부호)는 뺀다. */
function symbolize(text: string): Symbols {
  const sym: string[] = [];
  const src: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const s = c - 0xac00;
      const f = s % 28;
      sym.push(`I${Math.floor(s / 588)}`, `M${Math.floor((s % 588) / 28)}`);
      src.push(i, i);
      if (f) {
        sym.push(`F${f}`);
        src.push(i);
      }
    } else if (/[\p{L}\p{N}]/u.test(text[i])) {
      sym.push(text[i].toLowerCase());
      src.push(i);
    }
  }
  return { sym, src };
}

/** 설정 글 → 호출어 목록(쉼표·줄바꿈으로 나눔). 너무 짧은 것은 뺀다. */
export function parseWakeWords(setting: string | undefined): string[] {
  return (setting ?? DEFAULT_WAKE_WORDS)
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter((w) => symbolize(w).sym.length >= MIN_SYMBOLS);
}

export type WakeMatch = { start: number; end: number; distance: number };

/** 말에서 호출어 구간(글자 위치, end 는 그 다음 글자)을 찾는다. 여러 호출어 중 가장 가까운 것. */
export function findWake(text: string, words: string[]): WakeMatch | null {
  const t = symbolize(text);
  let best: WakeMatch | null = null;
  for (const w of words) {
    const p = symbolize(w).sym;
    const m = p.length;
    const n = t.sym.length;
    if (m < MIN_SYMBOLS || n === 0) continue;
    const allowed = Math.floor(m * MAX_ERROR_RATE);
    // 말 어디서 시작해도 되는 편집 거리(semi-global). start 는 그 구간이 시작한 자모 위치.
    let prev = new Array<number>(n + 1).fill(0);
    let prevStart = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = new Array<number>(n + 1);
      const curStart = new Array<number>(n + 1);
      cur[0] = i;
      curStart[0] = 0;
      for (let j = 1; j <= n; j++) {
        const sub = prev[j - 1] + (p[i - 1] === t.sym[j - 1] ? 0 : 1);
        const del = prev[j] + 1; // 호출어 자모를 못 들음
        const ins = cur[j - 1] + 1; // 말에 자모가 더 있음
        if (sub <= del && sub <= ins) [cur[j], curStart[j]] = [sub, prevStart[j - 1]];
        else if (del <= ins) [cur[j], curStart[j]] = [del, prevStart[j]];
        else [cur[j], curStart[j]] = [ins, curStart[j - 1]];
      }
      prev = cur;
      prevStart = curStart;
    }
    for (let j = 1; j <= n; j++) {
      const d = prev[j];
      if (d > allowed || (best && d >= best.distance)) continue;
      best = { start: t.src[prevStart[j]] ?? 0, end: t.src[j - 1] + 1, distance: d };
    }
  }
  return best;
}

/** 글자 위치 end 뒤의 말 — 호출어 뒤에 남은 문장부호·공백은 뗀다. */
export const restAfter = (text: string, end: number): string =>
  text.slice(end).replace(/^[\s.,!?。…~]+/, '');

/** 호출어 뒤의 말. 호출어가 없으면 null. */
export function afterWake(text: string, words: string[]): string | null {
  const m = findWake(text, words);
  return m ? restAfter(text, m.end) : null;
}
