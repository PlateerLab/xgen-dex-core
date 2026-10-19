/**
 * 고속 조작 (실험) — 단순한 브라우저 조작 요청을 서버 LLM 을 거치지 않고
 * 데스크탑에서 끝낸다.
 *
 * 흐름:
 *   1. classify — "지금 페이지에서 클릭·열기·입력 하나로 끝나는 직접 명령인가"
 *      판별, 동작 종류(click / type / type_submit), 입력할 글자를 한 요청에
 *      묻는다. 스냅샷이 필요 없어 스냅샷과 동시에 보낸다. 판별이 아니면 서버로.
 *      입력할 글자는 따옴표 안 문구가 있으면 그것을, 없으면 지시문의 어절
 *      후보 중에서 결정 모델이 고른다.
 *   2. pickElement — 스냅샷 @eN 목록을 25개씩 묶어 묶음마다 하나씩 고르고,
 *      승자끼리 한 번 더 고른다 ("무조건 하나 고르기": 이미 조작이 필요하다고
 *      판별했으므로 '해당 없음' 선택지는 주지 않는다).
 *
 * 결정 모델은 글자를 생성하지 않고 선택지 확률만 읽는 서버다
 * (`POST /v1/systemone {state, questions}` → `{answers}`). 요소 질문의 문구와
 * state 형식은 학습 데이터와 글자 하나까지 같아야 정확도가 유지된다.
 */

import { isUnitWord, plainNumber } from './fast-act-number';
import {
  MAX_LINES,
  PICK_Q13,
  READY_OPTS,
  READY_Q,
  buildScreen,
  screen,
  stateWith,
  windowsOf,
  type Screen13,
} from './fast-act-e13';

export type ElementRef = { role: string; name?: string };
export type ElementRefs = Record<string, ElementRef>;

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ChoiceAnswer = {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};
export type DecisionRequest = { state: string; questions: Record<string, ChoiceQuestion> };
export type DecisionPost = (body: DecisionRequest) => Promise<Record<string, ChoiceAnswer>>;

/** 학습 때 쓴 묶음 크기 — 선택지를 글자(A~Z)로 읽으므로 26개가 한계다. */
export const CHUNK = 25;

const PICK_INSTR =
  "Which page element should be acted on (clicked or typed into) to carry out the user's instruction?";

/**
 * 판별은 문구가 다른 두 질문의 '예' 확률 평균으로 한다 — 한 질문만 쓰면 반말·
 * 목적형 표현("~로 가", "~보여줘")을 놓치는 쪽으로 치우친다. 판별 질문은
 * 학습한 적 없는 형태라 확신도가 보정돼 있지 않다.
 */
const GATE_QUESTIONS: Record<string, { q: ChoiceQuestion; yes: string }> = {
  gate_single: {
    q: {
      type: 'choice',
      instructions:
        "Does the user's message ask to go to, open, show, click, or type into one thing on the current page (a single navigation or input), rather than asking a question, requesting a summary or written text, or a multi-step task?",
      criteria: {
        yes: 'yes, a single navigation, click, or input',
        no: 'no, a question, writing, or several steps',
      },
    },
    yes: 'yes',
  },
  gate_intent: {
    q: {
      type: 'choice',
      instructions: 'What does the user want?',
      criteria: {
        act: 'one click or one text entry on the page (open, go to, show, press, select, type)',
        answer: 'an answer, explanation, summary, or written text',
        multi: 'a task that needs several steps or other apps',
      },
    },
    yes: 'act',
  },
};

function gateScore(answers: Record<string, ChoiceAnswer>): number {
  const ps = Object.entries(GATE_QUESTIONS).map(([k, g]) => answers[k]?.probabilities?.[g.yes] ?? 0);
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

/** 클릭·입력 하나(act)인지, 글쓰기(answer)·여러 단계(multi)인지 — E13 의 학습된 ready 에는 뒤 둘이 없어 같이 묻는다. */
export const GATE_INTENT_Q = GATE_QUESTIONS.gate_intent.q;

const ACTION_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: "What kind of single page action does the user's message ask for?",
  criteria: {
    click: 'click, open, press, or select something',
    type: 'type text into a field without submitting',
    type_submit: 'type text into a field and submit it (e.g. search for something)',
  },
};

const TEXT_INSTR = "Which part of the user's instruction is the exact text to type into the field?";

export type ActionKind = 'click' | 'type' | 'type_submit';

/** 글자를 넣을 수 있는 역할 — 고른 요소가 이것이 아니면 입력 대신 클릭한다. */
const TYPABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

export function isTypable(ref: ElementRef | undefined): boolean {
  return !!ref && TYPABLE_ROLES.has(ref.role);
}

/** 학습 데이터와 같은 선택지 표기: `role "name"`. */
export function elementLabel(ref: ElementRef): string {
  return `${ref.role} "${ref.name ?? ''}"`;
}

const ROLE_KO: Record<string, string> = {
  button: '버튼',
  link: '링크',
  textbox: '입력칸',
  searchbox: '검색칸',
  combobox: '선택 상자',
  file: '파일 칸',
  checkbox: '체크박스',
  radio: '선택지',
  tab: '탭',
  menuitem: '메뉴',
  option: '항목',
  heading: '제목',
};

/** 사용자에게 보이는 표기: `"장바구니" 링크`. */
export function elementDisplay(ref: ElementRef): string {
  const name = (ref.name ?? '').trim();
  const role = ROLE_KO[ref.role] ?? ref.role;
  return name ? `"${name.length > 30 ? `${name.slice(0, 30)}…` : name}" ${role}` : role;
}

/**
 * 학습 데이터와 같은 state 형식 — E13 이면 화면 줄이 먼저, 사용자 말이 마지막.
 * scr 를 주면 그 화면으로(음성 경로: 스냅샷마다 요소 번호가 새로 매겨지므로 전역 화면을 쓰면 다른 스냅샷의
 * 번호와 섞인다), 안 주면 전역 화면(채팅 경로).
 */
export function decisionState(instruction: string, origin: string, scr: Screen13 | null = screen()): string {
  return scr ? stateWith(scr, instruction) : `User instruction: ${instruction}\nPage: ${origin}`;
}

function pickQuestion(refs: ElementRefs, keys: string[], e13: boolean): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  // E13: 선택지는 요소 번호만 — 이름은 state 의 화면 줄에 있다.
  for (const k of keys) criteria[k] = e13 ? k : elementLabel(refs[k]);
  return { type: 'choice', instructions: e13 ? PICK_Q13 : PICK_INSTR, criteria };
}

export function chunkKeys(keys: string[], size = CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

/** 따옴표로 감싼 문구 — 있으면 입력할 글자로 그대로 쓴다. */
/** 여는 따옴표별 닫는 따옴표 — 짝이 맞는 것만 닫는다(「…」 안의 "…" 는 글자다). */
const QUOTE_CLOSE: Record<string, string> = { '"': '"“”', '“': '"“”', '”': '"“”', "'": "'‘’", '‘': "'‘’", '’': "'‘’", '「': '」', '『': '』' };

export function quotedText(instruction: string): string | null {
  const at = instruction.search(/["“”'‘’「『]/);
  if (at < 0) return null;
  const close = QUOTE_CLOSE[instruction[at]];
  let end = at + 1;
  while (end < instruction.length && !close.includes(instruction[end])) end++;
  return end < instruction.length ? instruction.slice(at + 1, end).trim() || null : null;
}

/**
 * 어절 끝 조사 — 한국어 문법 규칙이다 (특정 사이트·문구와 무관).
 * 길이가 긴 것부터 떼야 '으로' 를 '로' 로 잘못 떼지 않는다.
 */
const PARTICLES = ['이라고', '라고', '에서', '으로', '에다', '을', '를', '이', '가', '은', '는', '에', '로', '도'];
/**
 * 넣을 글자 끝에서 뗄 조사 — 주격 '이/가' 는 빼고 뗀다. 글자 넣기 말 앞에는 주격이 오지 않고("원피스 검색해",
 * "원피스를 입력해"), '이/가' 로 끝나는 명사는 흔하다("4병특가", "고양이" 를 "4병특", "고양" 으로 넣던 문제).
 */
const TYPED_PARTICLES = PARTICLES.filter((p) => p !== '이' && p !== '가');

function stripParticle(word: string, particles: string[] = PARTICLES): string {
  for (const p of particles) {
    if (!word.endsWith(p)) continue;
    // 한 글자 조사는 두 글자 넘는 말에서만("도로"·"가을" 은 그대로), 두 글자 넘는 조사는 한 글자 말에도 붙는다
    // ("원으로" → "원"). 긴 조사가 맞는데 못 떼면 그 꼬리('으로' 의 '로')도 떼지 않는다 — "원으로" 를 "원으" 로 넣었다.
    return word.length > p.length + (p.length === 1 ? 1 : 0) ? word.slice(0, -p.length) : word;
  }
  return word;
}

/**
 * 입력할 글자 후보 — 지시문을 어절로 나눠 이어 붙인 구간들 (조사 뗀 것 포함).
 * 결정 모델이 이 중 하나를 고른다. 최대 3어절까지만 만든다.
 */
export function textCandidates(instruction: string, maxWords = 3): string[] {
  const words = instruction
    .replace(/[?!.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= maxWords && i + n <= words.length; n++) {
      const span = words.slice(i, i + n);
      const raw = span.join(' ');
      const stripped = [...span.slice(0, -1), stripParticle(span[span.length - 1])].join(' ');
      for (const c of [stripped, raw]) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
    }
  }
  return out.slice(0, CHUNK);
}

/**
 * 넣을 글자 고르기 (단어 단위, mac-fastact 와 같은 질문) — 단어마다 "이 단어가 쓰일 글자에 들어가나" 를
 * 두 문구로 묻고 평균을 낸다. 가장 높은 단어에서 양옆으로 0.8 이상인 단어까지 넓힌 구간을 쓴다.
 * 구간을 통째로 고르게 하면 명령어·추임새("음 검색창에 원피스")까지 같이 고르는 경향이 있다.
 */
const WORD_Q = [
  (w: string) => `Should the word "${w}" (or its stem) appear in the text that gets written?`,
  (w: string) => `Is the word "${w}" part of the text the user wants typed, rather than a command word?`,
];
const SPAN_MIN = 0.8;

export function textWordQuestions(instruction: string): Record<string, ChoiceQuestion> {
  const qs: Record<string, ChoiceQuestion> = {};
  instruction
    .split(/\s+/)
    .filter(Boolean)
    .forEach((w, i) =>
      WORD_Q.forEach((q, j) => (qs[`w${i}_${j}`] = { type: 'choice', instructions: q(w), criteria: { yes: 'yes', no: 'no' } })),
    );
  return qs;
}

/**
 * 단위 말이면 조사 뗀 꼴 — 아니면 null. 두 글자 어절의 한 글자 조사("개로", "원에")는 stripParticle 이 떼지 않는다
 * ("도로"·"통로" 를 지키려고) — 단위 말에 붙은 것만 여기서 뗀다(10/18 BO "안전재고 열 개로 바꿔줘" 를 "… 개로" 로 넣었다).
 */
function unitStem(word: string): string | null {
  const t = stripParticle(word, TYPED_PARTICLES);
  if (isUnitWord(t)) return t;
  return TYPED_PARTICLES.includes(word.slice(-1)) && isUnitWord(word.slice(0, -1)) ? word.slice(0, -1) : null;
}

/** from 앞 단어는 이미 처리한 앞 명령이다 — 구간에 넣지 않는다. */
export function textFromWordAnswers(instruction: string, answers: Record<string, ChoiceAnswer>, from = 0): string | null {
  const ws = instruction.split(/\s+/).filter(Boolean);
  if (ws.length <= from) return null;
  const p = ws.map((_, i) =>
    i < from ? 0 : WORD_Q.reduce((sum, _q, j) => sum + (answers[`w${i}_${j}`]?.probabilities?.yes ?? 0), 0) / WORD_Q.length,
  );
  const peak = p.indexOf(Math.max(...p));
  if (p[peak] < 0.5) return null;
  let s = peak;
  let e = peak + 1;
  // 인용 조사("~라고/~이라고")는 인용한 내용이 끝나는 자리다 — 거기서 더 넓히지 않는다.
  const quoteEnd = (w: string): boolean => /(이라고|라고)$/.test(w);
  while (s > 0 && p[s - 1] >= SPAN_MIN && !quoteEnd(ws[s - 1])) s--;
  while (e < ws.length && p[e] >= SPAN_MIN && !quoteEnd(ws[e - 1])) e++;
  // 수 말과 그 단위는 한 덩어리다 — 모델이 "이만 원으로" 에서 "원으로" 만 고르기도 했다(10/16 BO 정상가). 앞 어절과
  // 합쳐 수 말이 되면 넓힌다(plainNumber 가 읽는 꼴).
  while (s > 0 && plainNumber(stripParticle([ws[s - 1], ...ws.slice(s, e)].join(' '), TYPED_PARTICLES)) !== null) s--;
  // 단위가 오른쪽에 남기도 했다("안전재고 수량 열 개" 에서 "열" 만 — '개' 0.49). 뒤 어절이 단위 말이고 합쳐 수 말이
  // 되면 넓힌다(단위 말일 때만 — "15 해줘" 의 '해줘' 는 넓히지 않는다).
  const unitAt = (i: number): string | null => {
    const unit = i > 0 ? unitStem(ws[i]) : null;
    return unit && plainNumber(`${ws[i - 1]} ${unit}`) !== null ? unit : null;
  };
  while (e < ws.length && unitAt(e) && plainNumber([...ws.slice(s, e), unitAt(e)].join(' ')) !== null) e++;
  const span = ws.slice(s, e);
  span[span.length - 1] = (e - 1 > s && unitAt(e - 1)) || stripParticle(span[span.length - 1], TYPED_PARTICLES);
  return span.join(' ') || null;
}

const now = (): number => performance.now();

export type Classification = {
  /** 판별 점수 — 두 판별 질문의 '예' 확률 평균. */
  gate: number;
  action: ActionKind;
  /** 입력할 글자 (따옴표 문구 또는 결정 모델이 고른 어절). click 이면 null. */
  text: string | null;
  /** E13 실행 준비 판단의 선택 (act_now | wait | not_ui). E10 이면 없음. */
  ready?: string;
  /** 클릭·입력 하나로 끝나는 일일 확률(gate_intent 의 act) — E13 의 ready 에는 여러 단계·글쓰기 선택지가 없다. */
  single?: number;
  /** gate_intent 의 확률 전체(act·answer·multi) — 로그용. */
  intent?: Record<string, number>;
  ms: number;
};

/**
 * 1단계 — 판별·동작 종류·입력 글자를 한 요청에 묻는다. 스냅샷 없이 지시문과
 * 페이지 주소만 쓰므로 스냅샷과 동시에 보낼 수 있다 (질문끼리는 서버에서
 * 서로 격리돼 답이 섞이지 않는다).
 */
export async function classify(
  post: DecisionPost,
  instruction: string,
  origin: string,
  scr: Screen13 | null = screen(),
): Promise<Classification> {
  const t0 = now();
  const quoted = quotedText(instruction);
  const candidates = quoted ? [] : textCandidates(instruction);
  const questions: Record<string, ChoiceQuestion> = { action: ACTION_QUESTION };
  // E13: 학습된 실행 준비 판단(act_now / wait / not_ui)이 판별을 맡는다. E10 은 학습 안 된 판별 질문 두 개.
  const e13 = scr !== null;
  // ready 에는 여러 단계·글쓰기 선택지가 없어 "자료 읽고 … 화면에 입력해줘" 도 act_now 였다(10/19) — 같이 묻는다.
  if (e13) (questions.ready = { type: 'choice', instructions: READY_Q, criteria: READY_OPTS }), (questions.gate_intent = GATE_INTENT_Q);
  else for (const [k, g] of Object.entries(GATE_QUESTIONS)) questions[k] = g.q;
  if (candidates.length > 1) {
    const criteria: Record<string, string> = {};
    candidates.forEach((c, i) => (criteria[`t${i}`] = c));
    questions.text = { type: 'choice', instructions: TEXT_INSTR, criteria };
  }
  const a = await post({ state: decisionState(instruction, origin, scr), questions });
  const action = (a.action?.choice ?? 'click') as ActionKind;
  let text: string | null = null;
  if (action !== 'click') {
    text = quoted ?? (candidates.length === 1 ? candidates[0] : null);
    const picked = a.text?.choice;
    if (!text && picked) text = candidates[Number(picked.slice(1))] ?? null;
  }
  const gate = e13 ? (a.ready?.probabilities?.act_now ?? 0) : gateScore(a);
  return { gate, action, text, ready: e13 ? a.ready?.choice : undefined, single: a.gate_intent?.probabilities?.act, intent: a.gate_intent?.probabilities, ms: now() - t0 };
}

export type Pick = {
  ref: string;
  confidence: number;
  /** 확률 상위 후보 (로그용) — `role "name"` 과 확률. */
  top: Array<[string, number]>;
  calls: number;
  ms: number;
};

/**
 * 같은 ref만 중복이다. 이름과 역할이 같아도 서로 다른 칸·팝업·링크일 수 있으므로
 * 이름 없는 요소를 포함해 서로 다른 ref는 모두 유지한다. 기존 호출부를 위해 함수 이름은 유지한다.
 */
export function dedupeByLabel(refs: ElementRefs, keys: string[]): string[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    if (!Object.hasOwn(refs, k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function topOf(refs: ElementRefs, probs: Record<string, number>, n = 3): Array<[string, number]> {
  return Object.entries(probs)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, p]) => [`${k} ${refs[k] ? elementLabel(refs[k]) : '?'}`, Number(p.toFixed(3))]);
}

/**
 * 앞자리 편향 보정 — 이 모델은 같은 선택지라도 앞에 놓인 것을 더 고른다
 * (BO 실측: 중분류 버튼이 하위 링크보다 앞에 있으면 링크 확률 0.96 → 0.56).
 * 같은 질문을 순서만 뒤집어 함께 묻고 두 확률을 평균한다. 같은 요청 안이라
 * 왕복은 늘지 않는다.
 */
function pairQuestions(refs: ElementRefs, keys: string[], id: string, e13: boolean): Record<string, ChoiceQuestion> {
  return { [id]: pickQuestion(refs, keys, e13), [`${id}r`]: pickQuestion(refs, [...keys].reverse(), e13) };
}

function pairProbs(answers: Record<string, ChoiceAnswer>, id: string): Record<string, number> {
  const a = answers[id]?.probabilities ?? {};
  const b = answers[`${id}r`]?.probabilities;
  if (!b) return { ...a }; // 한 방향만 물은 경우
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = ((a[k] ?? 0) + (b[k] ?? 0)) / 2;
  return out;
}

function argmax(probs: Record<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const [k, p] of Object.entries(probs)) if (!best || p > best[1]) best = [k, p];
  return best;
}

/**
 * 묶음 라운드에서 결승에 올릴 요소 — 1등, 그리고 한 방향으로만 물었으면(묶음이 여럿) 2등도. 한 방향 질문은
 * 앞자리 편향이 있어 차이를 순서가 정한다(10/16 BO: "협력사 칸 눌러줘" 에 같은 묶음의 메뉴 버튼 "협력사"
 * 0.61·0.80, 폼 칸 "협력사" 0.39·0.20 — 두 방향으로 묻는 결승에 같이 올리면 폼 칸 0.98). 2등 확률에 문턱을
 * 두지 않는다: 10/19 BO "반품기능 제공안함으로 해줘" 에 앞의 "취소기능 제공안함" 0.926, 맞는 칸 0.071 이었다.
 */
function contenders(probs: Record<string, number>, oneWay: boolean): string[] {
  const [first, second] = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  if (!first) return [];
  return oneWay && second && second[1] > 0 ? [first[0], second[0]] : [first[0]];
}

/**
 * 2단계 — 스냅샷 요소 중 하나를 고른다 ("무조건 하나 고르기"). ref 중복만
 * 제거한 뒤 25개씩 묶는다. 한 방향 묶음의 1등과 기준을 넘긴 2등을 결승에 올리고,
 * 결승에서는 순서를 뒤집은 질문과 평균한다. 묶음이 하나면 그것이 결승이다.
 */
export async function pickElement(
  post: DecisionPost,
  instruction: string,
  origin: string,
  refs: ElementRefs,
  scr: Screen13 | null = screen(),
): Promise<Pick | null> {
  const t0 = now();
  const e13 = scr !== null;
  if (scr && scr.all.length > MAX_LINES) return pickWindowed(post, instruction, refs, scr);
  // E13: 화면 줄에 실린 요소만 후보(모델이 볼 수 있는 것만).
  const listed = scr?.ids;
  const keys = dedupeByLabel(refs, listed ? listed.filter((k) => k in refs) : Object.keys(refs));
  if (keys.length === 0) return null;
  const state = decisionState(instruction, origin, scr);
  const chunks = chunkKeys(keys);
  let questions: Record<string, ChoiceQuestion> = {};
  // 묶음이 여럿이면 묶음 라운드는 한 방향만 묻는다 — 큰 페이지에서 질문 수가 두 배가
  // 되면 판단 시간이 크게 늘고(벤치 p90 2.0→3.0초), 편향은 승자끼리 겨루는 결승에서
  // 결과를 뒤집는다. 묶음이 하나뿐이면 그게 결승이니 뒤집은 질문도 함께 묻는다.
  const pairChunks = chunks.length === 1;
  chunks.forEach((c, i) => {
    if (c.length > 1) {
      questions = pairChunks
        ? { ...questions, ...pairQuestions(refs, c, `c${i}`, e13) }
        : { ...questions, [`c${i}`]: pickQuestion(refs, c, e13) };
    }
  });
  const first = Object.keys(questions).length ? await post({ state, questions }) : {};
  let calls = Object.keys(questions).length ? 1 : 0;
  const chunkProbs = chunks.map((c, i) => (c.length > 1 ? pairProbs(first, `c${i}`) : { [c[0]]: 1 }));
  const winners = chunkProbs.flatMap((p) => contenders(p, !pairChunks)).filter((k) => k in refs);
  if (winners.length === 0) return null;
  if (winners.length === 1) {
    // 묶음이 하나면 그 묶음의 확률이 곧 확신도. 묶음이 여럿인데 승자가 하나만
    // 남은 경우(나머지 답이 목록 밖)는 믿을 근거가 없으니 0.
    const confidence = chunks.length > 1 ? 0 : (argmax(chunkProbs[0])?.[1] ?? 0);
    return { ref: winners[0], confidence, top: topOf(refs, chunkProbs[0]), calls, ms: now() - t0 };
  }
  const fin = await post({ state, questions: pairQuestions(refs, winners, 'q', e13) });
  calls++;
  const finProbs = pairProbs(fin, 'q');
  const best = argmax(finProbs);
  if (!best) return null;
  return { ref: best[0], confidence: best[1], top: topOf(refs, finProbs), calls, ms: now() - t0 };
}

const bigramsOf = (s: string): Set<string> => {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};

/**
 * 아주 큰 화면(요소 120개 초과 — 포털 뉴스 첫 화면은 670개)은 창이 열몇 개가 돼 판단이 2~3초 걸린다.
 * 화면 앞쪽(머리·메뉴) 60개와 말과 글자(두 글자 묶음)가 많이 겹치는 60개만 후보로 남긴다 — 읽는 순서는 지킨다.
 * 앞쪽을 남기는 건 이름이 안 겹치는 간접 표현("인기 상품 순위" → 랭킹존)이 대개 메뉴를 가리키기 때문이다.
 */
function narrowLarge(keys: string[], refs: ElementRefs, instruction: string): string[] {
  if (keys.length <= 2 * MAX_LINES) return keys;
  const said = bigramsOf(instruction);
  const score = (k: string): number => {
    let n = 0;
    for (const g of bigramsOf(refs[k]?.name ?? '')) if (said.has(g)) n++;
    return n;
  };
  const head = new Set(keys.slice(0, MAX_LINES));
  const matched = keys
    .filter((k) => !head.has(k))
    .map((k, i) => ({ k, s: score(k), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, MAX_LINES)
    .map((x) => x.k);
  const keep = new Set([...head, ...matched]);
  return keys.filter((k) => keep.has(k));
}

/**
 * E13 — 화면이 60줄을 넘으면 읽는 순서로 이어진 창(60줄 이하)마다 따로 묻는다. 앞 60줄만 보이면
 * 뒤쪽 요소(DOM 끝에 있는 사이드바의 펼친 하위 메뉴 등)는 고를 수가 없어 부모 버튼을 누르게 된다.
 * 창마다 state 가 달라 요청이 따로지만 동시에 보낸다. 창·묶음 승자끼리 승자만 실은 화면으로 결승을 한다.
 */
async function pickWindowed(
  post: DecisionPost,
  instruction: string,
  refs: ElementRefs,
  scr: Screen13,
): Promise<Pick | null> {
  const t0 = now();
  const byRef = new Map(scr.all.map((r) => [r.ref, r]));
  let keys = dedupeByLabel(refs, scr.all.map((r) => r.ref).filter((k) => k in refs));
  if (keys.length === 0) return null;
  keys = narrowLarge(keys, refs, instruction);
  const windows = windowsOf(keys);
  const rounds = await Promise.all(
    windows.map(async (w) => {
      const state = stateWith(buildScreen(scr.origin, w.map((k) => byRef.get(k)!), scr.size), instruction);
      const chunks = chunkKeys(w);
      const pair = chunks.length === 1;
      let questions: Record<string, ChoiceQuestion> = {};
      chunks.forEach((c, i) => {
        if (c.length > 1) {
          questions = pair
            ? { ...questions, ...pairQuestions(refs, c, `c${i}`, true) }
            : { ...questions, [`c${i}`]: pickQuestion(refs, c, true) };
        }
      });
      const a = Object.keys(questions).length ? await post({ state, questions }) : {};
      return chunks.map((c, i) => ({ oneWay: !pair, probs: c.length > 1 ? pairProbs(a, `c${i}`) : { [c[0]]: 1 } }));
    }),
  );
  const order = new Map(keys.map((k, i) => [k, i]));
  const winners = [...new Set(rounds.flat().flatMap((r) => contenders(r.probs, r.oneWay)))]
    .filter((k) => k in refs)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  if (winners.length === 0) return null;
  if (winners.length === 1) {
    // 후보가 한 창·한 묶음에 다 들었으면(화면은 커도 후보가 적은 입력 요청) 그 묶음의 확률이 곧 확신도 — 0 으로
    // 두면 결과 표가 뜬 팝업에서 "삼성 입력해줘" 가 입력칸 0.99 인데도 넘어갔다(10/16 BO 브랜드 조회).
    if (rounds.length === 1 && rounds[0].length === 1) {
      const probs = rounds[0][0].probs;
      return { ref: winners[0], confidence: probs[winners[0]] ?? 0, top: topOf(refs, probs), calls: 1, ms: now() - t0 };
    }
    // 후보가 하나뿐이면 그것이 답이다. 창이 여럿인데 승자가 하나만 남은 경우(나머지 답이 목록 밖)는 믿을 근거가 없다.
    const confidence = keys.length === 1 ? 1 : 0;
    return { ref: winners[0], confidence, top: [], calls: windows.length, ms: now() - t0 };
  }
  // 결승 화면에는 승자마다 바로 앞 제목도 싣는다(후보는 아니다) — 승자만 실으면 이름이 같은 선택지가 똑같은 줄이
  // 된다(10/19 BO 상품 등록 "반품기능 제공안함으로 해줘" 에 결승 화면이 "제공안함" 두 줄이라 취소기능 것을 골랐다).
  const pos = new Map(scr.all.map((r, i) => [r.ref, i]));
  const lines = new Set<string>();
  for (const k of winners) {
    const i = pos.get(k) ?? -1;
    for (let j = i - 1; j >= 0; j--) {
      if (scr.all[j].role === 'heading') {
        lines.add(scr.all[j].ref);
        break;
      }
    }
    lines.add(k);
  }
  const state = stateWith(buildScreen(scr.origin, [...lines].map((k) => byRef.get(k)!), scr.size), instruction);
  const fin = await post({ state, questions: pairQuestions(refs, winners, 'q', true) });
  const finProbs = pairProbs(fin, 'q');
  const best = argmax(finProbs);
  if (!best) return null;
  return { ref: best[0], confidence: best[1], top: topOf(refs, finProbs), calls: windows.length + 1, ms: now() - t0 };
}

/** 고른 요소와 분류를 합쳐 실제 동작을 정한다 — 글자를 못 넣는 요소면 클릭. */
export function resolveAction(
  c: Classification,
  element: ElementRef | undefined,
): { action: ActionKind; text: string | null } {
  if (c.action === 'click' || !c.text || !isTypable(element)) return { action: 'click', text: null };
  return { action: c.action, text: c.text };
}

/** 결정 모델 HTTP 클라이언트. */
export function decisionClient(baseUrl: string, timeoutMs = 5000): DecisionPost {
  const url = baseUrl.replace(/\/+$/, '') + '/v1/systemone';
  return async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`결정 모델 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { answers: Record<string, ChoiceAnswer> };
    return data.answers;
  };
}
