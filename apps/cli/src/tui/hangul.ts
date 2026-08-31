/**
 * 두벌식 한글 조합기.
 *
 * 예전에는 터미널의 IME 에 맡겼다 — 조합 중인 글자는 터미널이 커서 자리에 그리고,
 * 완성된 글자만 우리에게 왔다. 잘 되는 조합도 있지만 **터미널마다 다르고**, SSH 나
 * tmux 를 거치면 아예 안 오는 경우가 흔하다. 우리 쪽에서는 고칠 수가 없는 자리다.
 *
 * 그래서 조합을 여기서 한다. `r k s` 라는 세 번의 키 입력을 `ㄱ → 가 → 간` 으로
 * 만드는 일이다. 터미널이 무엇을 하든, SSH 너머든, 한글이 같은 방식으로 들어간다.
 *
 * 자판은 표준 두벌식이다. 겹받침이 갈라지는 자리(`간` + `ㅏ` → `가` + `나`)와
 * 백스페이스가 글자를 되짚는 자리(`한` → `하` → `ㅎ`)가 이 파일의 핵심이다.
 */

/** 초성 19자. 인덱스가 유니코드 계산에 그대로 쓰인다. */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
/** 중성 21자. */
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
/** 종성 28자. 0번은 받침 없음이라 자리를 비워 둔다. */
const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

const SYLLABLE_BASE = 0xac00;

/**
 * 두벌식 자판. 표준대로 **자음 19 + 모음 21** 이 아니라, 키를 눌러 나오는 낱자만
 * 적는다 — ㄲㄸㅃㅆㅉㅒㅖ 는 시프트로, 나머지 대문자는 소문자와 같은 낱자다.
 */
const KEYS: Record<string, string> = {
  r: 'ㄱ', R: 'ㄲ', s: 'ㄴ', e: 'ㄷ', E: 'ㄸ', f: 'ㄹ', a: 'ㅁ', q: 'ㅂ', Q: 'ㅃ',
  t: 'ㅅ', T: 'ㅆ', d: 'ㅇ', w: 'ㅈ', W: 'ㅉ', c: 'ㅊ', z: 'ㅋ', x: 'ㅌ', v: 'ㅍ', g: 'ㅎ',
  k: 'ㅏ', o: 'ㅐ', i: 'ㅑ', O: 'ㅒ', j: 'ㅓ', p: 'ㅔ', u: 'ㅕ', P: 'ㅖ',
  h: 'ㅗ', y: 'ㅛ', n: 'ㅜ', b: 'ㅠ', m: 'ㅡ', l: 'ㅣ',
};

/** 모음 두 개가 하나로 합쳐지는 자리. */
const VOWEL_PAIRS: Record<string, string> = {
  'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ',
  'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ',
  'ㅡㅣ': 'ㅢ',
};

/** 겹받침. */
const FINAL_PAIRS: Record<string, string> = {
  'ㄱㅅ': 'ㄳ',
  'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ',
  'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ', 'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ',
  'ㅂㅅ': 'ㅄ',
};

/** 합쳐진 낱자를 도로 둘로 가른다. 갈라지는 자리에서 쓴다. */
const SPLIT: Record<string, [string, string]> = Object.fromEntries(
  [...Object.entries(VOWEL_PAIRS), ...Object.entries(FINAL_PAIRS)].map(([pair, joined]) => [
    joined,
    [pair[0]!, pair[1]!] as [string, string],
  ]),
);

/**
 * 조합 중인 글자 하나.
 *
 * 아직 완성되지 않았으므로 값에 넣지 않고 따로 들고 있는다 — 다음 키가 무엇이냐에
 * 따라 `가` 가 `각` 이 될 수도, `가` 로 끝나고 새 글자가 시작될 수도 있다.
 */
export interface Composition {
  cho?: string;
  jung?: string;
  jong?: string;
}

export const EMPTY: Composition = {};

/** 이 키가 한글 낱자인가. 아니면 조합기를 거치지 않고 그대로 들어간다. */
export function jamoOf(key: string): string | undefined {
  if (KEYS[key]) return KEYS[key];
  // 시프트를 눌러도 같은 낱자인 대문자들 — 실제 IME 와 같게 소문자로 본다.
  const lower = key.toLowerCase();
  return lower === key ? undefined : KEYS[lower];
}

function isVowel(jamo: string): boolean {
  return JUNG.includes(jamo) || jamo === 'ㅗ' || jamo === 'ㅜ' || jamo === 'ㅡ';
}

/** 받침으로 설 수 있는 자음인가. ㄸㅃㅉ 은 못 선다. */
function canBeFinal(jamo: string): boolean {
  return JONG.indexOf(jamo) > 0;
}

/** 조합 중인 상태를 눈에 보이는 글자로. 아직 아무것도 없으면 빈 문자열. */
export function display(state: Composition): string {
  const { cho, jung, jong } = state;
  if (cho && jung) {
    const l = CHO.indexOf(cho);
    const v = JUNG.indexOf(jung);
    const t = jong ? JONG.indexOf(jong) : 0;
    if (l >= 0 && v >= 0 && t >= 0) {
      return String.fromCharCode(SYLLABLE_BASE + (l * 21 + v) * 28 + t);
    }
  }
  // 아직 한 낱자뿐이면 그 낱자를 그대로 보여 준다 — `ㄱ` 을 누른 순간부터 보여야
  // 무엇이 들어가고 있는지 알 수 있다.
  return cho ?? jung ?? '';
}

export interface FeedResult {
  /** 확정되어 값에 들어갈 글자. 없을 수도, 한 글자일 수도 있다. */
  commit: string;
  /** 아직 조합 중인 상태. */
  state: Composition;
}

/**
 * 낱자 하나를 넣는다.
 *
 * 돌려주는 `commit` 은 **이번에 확정된** 글자다. 조합 중인 글자는 `state` 에 남아
 * 다음 키를 기다린다.
 */
export function feed(state: Composition, jamo: string): FeedResult {
  const { cho, jung, jong } = state;

  if (isVowel(jamo)) {
    // 받침이 있는데 모음이 오면 그 받침은 이 글자의 것이 아니었다. 앞 글자에서
    // 떼어 내 새 글자의 첫소리로 넘긴다: `간` + `ㅏ` → `가` + `나`.
    if (cho && jung && jong) {
      const parts = SPLIT[jong];
      const moved = parts ? parts[1] : jong;
      const kept = parts ? parts[0] : undefined;
      return {
        commit: display({ cho, jung, jong: kept }),
        state: { cho: moved, jung: jamo },
      };
    }
    if (cho && jung) {
      const merged = VOWEL_PAIRS[jung + jamo];
      if (merged) return { commit: '', state: { cho, jung: merged } };
      return { commit: display(state), state: { jung: jamo } };
    }
    if (cho) return { commit: '', state: { cho, jung: jamo } };
    if (jung) {
      const merged = VOWEL_PAIRS[jung + jamo];
      if (merged) return { commit: '', state: { jung: merged } };
      return { commit: jung, state: { jung: jamo } };
    }
    return { commit: '', state: { jung: jamo } };
  }

  // 자음
  if (cho && jung) {
    if (!jong) {
      if (canBeFinal(jamo)) return { commit: '', state: { cho, jung, jong: jamo } };
      return { commit: display(state), state: { cho: jamo } };
    }
    const merged = FINAL_PAIRS[jong + jamo];
    if (merged) return { commit: '', state: { cho, jung, jong: merged } };
    return { commit: display(state), state: { cho: jamo } };
  }
  if (cho) {
    // 자음이 잇달아 오면 앞 자음은 홀로 남는다 — `ㄱㄴ` 처럼 낱자로 친 경우다.
    return { commit: cho, state: { cho: jamo } };
  }
  if (jung) return { commit: jung, state: { cho: jamo } };
  return { commit: '', state: { cho: jamo } };
}

export interface BackResult {
  state: Composition;
  /** 조합기가 처리했는가. 아니면 부르는 쪽이 값에서 한 글자를 지워야 한다. */
  handled: boolean;
}

/**
 * 조합 중인 글자를 한 단계 되짚는다: `한` → `하` → `ㅎ` → (없음).
 *
 * 완성된 글자를 통째로 지우는 IME 도 있지만, 되짚는 쪽이 오타를 고치기 쉽다.
 */
export function back(state: Composition): BackResult {
  const { cho, jung, jong } = state;
  if (jong) {
    const parts = SPLIT[jong];
    return { state: { cho, jung, jong: parts ? parts[0] : undefined }, handled: true };
  }
  if (jung) {
    const parts = SPLIT[jung];
    return { state: { cho, jung: parts ? parts[0] : undefined }, handled: true };
  }
  if (cho) return { state: EMPTY, handled: true };
  return { state: EMPTY, handled: false };
}

/** 조합을 끝내고 남은 글자를 확정한다. 다른 키로 넘어가거나 전송할 때 부른다. */
export function flush(state: Composition): { commit: string; state: Composition } {
  return { commit: display(state), state: EMPTY };
}

/**
 * 문자열 하나를 통째로 조합한다. 시험과 붙여넣기에 쓴다.
 *
 * `'rkstk'` → `'간사'` 처럼, 키를 순서대로 눌렀을 때 나오는 결과.
 */
export function compose(keys: string): string {
  let state: Composition = EMPTY;
  let text = '';
  for (const key of keys) {
    const jamo = jamoOf(key);
    if (!jamo) {
      text += flush(state).commit + key;
      state = EMPTY;
      continue;
    }
    const result = feed(state, jamo);
    text += result.commit;
    state = result.state;
  }
  return text + flush(state).commit;
}
