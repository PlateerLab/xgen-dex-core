/**
 * 숫자 칸에 넣을 말의 숫자만 — 빠른 조작 입력용.
 *
 * 가격·수량 칸은 숫자 아닌 글자가 섞이면 통째로 거부한다(10/16 BO 상품 등록: "정상가 20000원 입력해줘" → 칸은
 * 0 그대로, "20000" 은 들어감). 말로는 단위를 붙이고, 받아쓰기는 큰 수를 "2만 원"·"이만 원"·"만 팔천 원" 처럼
 * 한글 자릿수·한글 숫자로 적기도 한다.
 */

const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1_000 };
const LARGE: Record<string, number> = { 만: 1e4, 억: 1e8 };
const DIGIT: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const NUMBER_CHAR = /[\d,.\s일이삼사오육칠팔구십백천만억]/u;
// 고유어 수 — 받아쓰기는 "10개" 를 "열 개" 로도 적는다(10/16 BO 안전재고수량). 홀로 쓰거나 다른 말이 붙으면 다른
// 말과 겹쳐("네", "세요", "열어") 셈 단위 말이 뒤따를 때만 수로 읽는다.
const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const NATIVE_ONES: Record<string, number> = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 넷: 4, 네: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const COUNTERS = '개|명|분|사람|장|권|마리|대|번|살|병|벌|켤레|송이|잔|통|줄|가지|박스|상자|봉|팩|세트|묶음|알|판|곳|칸|시간|달|주';
const NATIVE = new RegExp(`^(${Object.keys(NATIVE_TENS).join('|')})?\\s*(${Object.keys(NATIVE_ONES).join('|')})?\\s*(${COUNTERS})$`, 'u');
const UNIT = new RegExp(`^(?:${COUNTERS}|원|달러|퍼센트|%|kg|g|ml|l|cm|mm|m)$`, 'iu');

/** 수 뒤에 오는 단위 말인가("개", "원", "장") — 조사는 뗀 어절로 묻는다. */
export function isUnitWord(word: string): boolean {
  return UNIT.test(word.trim());
}

/** "열 개" → 10, "스물다섯 장" → 25 — 고유어 수 뒤에 셈 단위 말이 있을 때만. 아니면 null. */
function nativeNumber(s: string): number | null {
  const m = NATIVE.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? NATIVE_TENS[m[1]] : 0) + (m[2] ? NATIVE_ONES[m[2]] : 0);
}

/** 숫자 부분을 값으로 — 아니면 null. 띄어쓰기는 한글 자릿수 둘레만("1만 8천") — "10 20" 은 한 수가 아니다. */
function parseNumber(s: string): number | null {
  if (!/^[\d일이삼사오육칠팔구십백천만억]/u.test(s) || /[\d.,]\s+[\d.,]/.test(s)) return null;
  // 한글 숫자는 자릿수와 함께일 때만 — "삼" 하나는 숫자 말이 아닐 수 있다("삼성").
  if (/[일이삼사오육칠팔구]/u.test(s) && !/[십백천만억]/u.test(s)) return null;
  const digits = s.replace(/[,\s]/g, '');
  let total = 0;
  let section = 0;
  let cur: number | null = null;
  let used = 0;
  // 자릿수는 큰 것부터 — "1만 2만"·"3천 2천" 은 한 수가 아니다.
  let lastSmall = Infinity;
  let lastLarge = Infinity;
  for (const tok of digits.matchAll(/(\d+(?:\.\d+)?)|([일이삼사오육칠팔구])|([십백천])|([만억])/gu)) {
    if (tok.index !== used) return null;
    used += tok[0].length;
    if (tok[1] || tok[2]) {
      if (cur !== null) return null;
      cur = tok[1] ? Number(tok[1]) : DIGIT[tok[2]];
    } else if (tok[3]) {
      if (SMALL[tok[3]] >= lastSmall) return null;
      lastSmall = SMALL[tok[3]];
      section += (cur ?? 1) * SMALL[tok[3]];
      cur = null;
    } else {
      // 맨 앞의 "만" 은 1만("만 팔천 원"), 그 밖에 앞 수 없는 큰 자릿수("1만만")는 아니다.
      if (!section && cur === null && (total || used !== tok[0].length)) return null;
      if (LARGE[tok[4]] >= lastLarge) return null;
      lastLarge = LARGE[tok[4]];
      lastSmall = Infinity;
      total += (section + (cur ?? (section ? 0 : 1))) * LARGE[tok[4]];
      section = 0;
      cur = null;
    }
  }
  if (used !== digits.length) return null;
  return Number((total + section + (cur ?? 0)).toFixed(6));
}

/**
 * "20000원" → "20000", "2만 원" → "20000", "이만 원" → "20000", "만 팔천 원" → "18000", "20,000" → "20000",
 * "15%" → "15", "열 개" → "10". 숫자 말 뒤에 단위 말(4글자까지)만 있을 때만 — 아니거나 바꿀 것이 없으면 null.
 */
export function plainNumber(text: string): string | null {
  const t = text.trim();
  const native = nativeNumber(t);
  if (native !== null) return String(native);
  let end = 0;
  while (end < t.length && NUMBER_CHAR.test(t[end])) end++;
  // 한글 숫자가 단위 말 앞글자이기도 하다("5일" 의 '일') — 숫자 부분을 길게부터 줄여 가며 본다. 자릿수로 시작하는
  // 말은 단위로 보지 않는다("1만 2만" 을 1만 2 + '만' 으로 읽지 않게).
  for (let cut = end; cut > 0; cut--) {
    if (!/^(?![십백천만억])[\p{L}%]{0,4}$/u.test(t.slice(cut).trim())) continue;
    const n = parseNumber(t.slice(0, cut).trim());
    if (n === null) continue;
    const out = String(n);
    return out === t ? null : out;
  }
  return null;
}
