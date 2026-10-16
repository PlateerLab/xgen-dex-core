/**
 * 숫자 칸에 넣을 말의 숫자만 — 빠른 조작 입력용.
 *
 * 가격·수량 칸은 숫자 아닌 글자가 섞이면 통째로 거부한다(10/16 BO 상품 등록: "정상가 20000원 입력해줘" → 칸은
 * 0 그대로, "20000" 은 들어감). 말로는 단위를 붙이고, 받아쓰기는 큰 수를 "2만 원" 처럼 한글 자릿수로 적기도 한다.
 */

const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1_000 };
const LARGE: Record<string, number> = { 만: 1e4, 억: 1e8 };

/**
 * "20000원" → "20000", "2만 원" → "20000", "1만 8천원" → "18000", "20,000" → "20000", "15%" → "15".
 * 숫자로 시작해 숫자·한글 자릿수 뒤에 단위 말(4글자까지)만 있을 때만 — 아니거나 바꿀 것이 없으면 null.
 */
export function plainNumber(text: string): string | null {
  const t = text.trim();
  // 띄어쓰기는 한글 자릿수 둘레만("1만 8천") — "10 20" 은 한 수가 아니다.
  const m = t.match(/^(\d[\d,.]*(?:\s*[십백천만억]\s*[\d,.]*)*)\s*([\p{L}%]{0,4})$/u);
  if (!m) return null;
  const digits = m[1].replace(/[,\s]/g, '');
  let total = 0;
  let section = 0;
  let cur: number | null = null;
  let used = 0;
  for (const tok of digits.matchAll(/(\d+(?:\.\d+)?)|([십백천])|([만억])/g)) {
    if (tok.index !== used) return null;
    used += tok[0].length;
    if (tok[1]) {
      if (cur !== null) return null;
      cur = Number(tok[1]);
    } else if (tok[2]) {
      section += (cur ?? 1) * SMALL[tok[2]];
      cur = null;
    } else {
      if (!section && cur === null) return null;
      total += (section + (cur ?? 0)) * LARGE[tok[3]];
      section = 0;
      cur = null;
    }
  }
  if (used !== digits.length) return null;
  const out = String(Number((total + section + (cur ?? 0)).toFixed(6)));
  return out === t ? null : out;
}
