/**
 * 말하는 도중에 실행하기 (실험) — 음성 인식의 중간 결과마다 "아직 처리하지 않은 뒷부분" 을
 * 판단해서, 확신이 높으면 바로 실행하고 그 부분을 처리됨으로 표시한다.
 * mac-fastact `src/stream.ts` 의 이식본이다 (판단·실행은 VoiceAgent 가 맡는다).
 *
 * "장바구니 열고 첫 번째 상품 눌러줘" 를 말하면 "장바구니 열고" 까지 들었을 때 장바구니를 열고,
 * 이어지는 말은 다음 토막으로 처리한다. 최종 결과가 오면 남은 부분을 느슨한 기준(FINAL)으로
 * 한 번 더 본다. 그래도 못 한 부분(unhandled)은 호출자가 서버 LLM 으로 넘긴다.
 *
 * 인식기는 앞서 낸 단어를 고쳐 쓰기도 한다 — 처리한 앞부분이 그대로면 글자로, 바뀌었으면
 * 처리한 마지막 단어를 찾아 그 뒤부터 본다.
 */

/** partial: 말하는 도중(중간 인식) 판단인가 — 이때는 확신 기준이 높고, 글자 넣기는 글자가 끝난 뒤에만. */
export type Thresholds = { intent: number; pick: number; partial: boolean };
export const PARTIAL: Thresholds = { intent: 0.75, pick: 0.75, partial: true };
export const FINAL: Thresholds = { intent: 0.5, pick: 0.6, partial: false };

export const CONTINUATION = '앞 명령의 꼬리말';
/** guard 가 실행을 막음 — 꼬리말과 달리 처리됨으로 치지 않는다(말이 더 들어오면 다시 본다). */
export const GUARDED = '실행 조건 불충족';
export const NEEDS_CONFIRM = '확인 필요';

export type ActKind = 'press' | 'type';

export type Outcome =
  | { acted: false; reason: string; ms: number; detail?: unknown; stop?: boolean }
  | {
      acted: true;
      kind: ActKind;
      target: string;
      text?: string;
      ms: number;
      /** ok = 실행됨, none = 눌렀는데 변화 없음 */
      effect?: 'ok' | 'none';
      /**
       * 다른 앱으로 옮겼다(맥 앱 열기) — 실행한 토막에 다음 요청이 묻어 있을 수 있다. 첫 단어만 처리한 것으로 치고
       * 나머지를 그 앱 화면에서 다시 나눈다: "PPT 열어서 새 프레젠테이션 만들어줘" 는 앞부분 "PPT 열어서 새 프레젠테이션"
       * 이 이미 실행 준비 '지금' 이라 통째로 앱 열기에 쓰이고 "만들어줘" 만 꼬리로 남았다(10/18).
       */
      reread?: boolean;
    };

export type Guard = (target: string, kind: ActKind, conf?: number) => Promise<boolean>;

export interface VoiceAgent {
  /** 같은 발화 안에서 마지막으로 실행한 대상 표기 (같은 걸 두 번 누르지 않게). */
  readonly lastTarget: string | null;
  boundary(utterance: string, done: string, rest: string[]): Promise<{ start: number; conf: number }>;
  /** 말 여러 개의 실행 준비 판단을 한 번에 — 학습된 질문(act_now / wait / not_ui, 여러 단계·글쓰기 작업이면 multi)과 act_now 확률. */
  readiness(texts: string[]): Promise<Array<{ ready: string; p: number }>>;
  /** pressOnly = 누를 것만 고른다(입력칸은 후보에서 뺀다). */
  handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean, utterance: string, pressOnly?: boolean): Promise<Outcome>;
}

export type SegmentEvent =
  | { type: 'partial' | 'final'; text: string; t: number }
  | { type: 'decide'; text: string; partial: boolean; outcome: Outcome; t: number };

const bigrams = (s: string): Set<string> => {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};

/**
 * 말과 대상 이름이 글자 두 개 이상 이어서 겹치는가. 한 발화 안에서 이미 하나를 실행한 뒤
 * 남은 말에만 쓴다 — "바꿔줘" 처럼 대상을 가리키지 않는 꼬리말이 엉뚱한 것을 누르지 않게.
 */
export function mentions(text: string, target: string): boolean {
  const a = bigrams(text);
  for (const g of bigrams(target)) if (a.has(g)) return true;
  return false;
}

/**
 * 공백 정리 + 한국어 보조 동사·조사 붙이기 — "해 줘" 처럼 띄어 쓴 "해" 는 넣을 글자로 잡힌다.
 * 특정 문구와 무관한 언어 규칙이다. 문장부호는 남긴다: XGEN STT 가 붙이는 마침표는 두 요청의 경계 단서라
 * 모델에게 보여야 한다(10/5 벤치: 떼면 이어 말하기 69→58%). 비교할 때만 bare() 로 뗀다.
 */
export const norm = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/(\S) (줘|주세요|줄래|줄래요|줘요)(?= |$)/g, '$1$2')
    .replace(/(\S) (이라고|라고|으로|에서|에게|을|를|로|은|는|이|가|에|도)(?= |$)/g, '$1$2')
    .trim();
const words = (s: string): string[] => norm(s).split(' ').filter(Boolean);
/** 비교용 — 문장부호를 뗀 글자. 인식기는 중간 결과에도 마침표를 붙여 "버튼." 과 "버튼" 이 다른 단어가 된다. */
export const bare = (s: string): string => s.replace(/[.,!?。…]+/g, '');
/**
 * 중간 결과를 통째로 믿는다(기본). XGEN 은 서버가 연속 두 가설의 일치로 확정한 글자를 낸다.
 * 10/5 벤치(사람 67·이어 말하기 52, XGEN STT): 정확도 88.1%/80.8%(안 믿을 때 88.1%/71.2%), 말 끝→실행 중앙
 * 0.14초(0.94초) — 틀릴 명령이 말하는 도중에 틀릴 뿐 틀린 수는 같다. DEX_VOICE_TRUST_PARTIALS=0 이면 끈다.
 */
const TRUST_PARTIALS = process.env.DEX_VOICE_TRUST_PARTIALS !== '0';

export class Segmenter {
  private consumed = '';
  private prevPartial = '';
  /** 마지막 실행 전의 consumed — 실행한 토막의 시작점. */
  private segStart: string | null = null;
  /** 마지막으로 실행을 일으킨 말 토막. */
  private lastSeg = '';
  /** 앱을 옮긴 실행 뒤 남은 말을 다시 나누는 중(Outcome.reread) — 다음 요청이 없으면 꼬리로 누르지 않고 끝낸다. */
  private rereading = false;
  private latest = '';
  private lastTried = '';
  private finalText: string | null = null;
  private finished = false;
  /** An attempted action was not verified; only the server may resume this utterance. */
  private needsRecovery = false;
  /** 판단 세대 — 최종 인식이 오면 올라간다. 이전 세대의 판단은 끝나도 실행하지 못한다. */
  private epoch = 0;
  /** 지금 돌고 있는 pump 의 세대 (-1 = 없음). */
  private runningEpoch = -1;
  private resolveDone: (() => void) | null = null;
  /** 최종 판단에서도 처리하지 못한 남은 말 — 서버 LLM 으로 넘길 부분. */
  unhandled: string | null = null;
  /** Terminal local failure: do not reinterpret or forward this utterance automatically. */
  failure: string | null = null;
  /**
   * 실행 중인 조작 — guard 를 통과한 뒤 handle 이 돌아올 때까지. 최종 인식이 와서 새 세대가 시작돼도
   * 이전 세대의 실행은 이미 화면을 바꾸고 있으므로, 새 세대는 그 실행이 끝나고 기록된 뒤에 남은 말을 본다
   * (안 기다리면 같은 명령을 또 실행한다).
   */
  private acting: Promise<void> | null = null;
  private releaseActing: (() => void) | null = null;

  constructor(
    private agent: VoiceAgent,
    private onEvent: (e: SegmentEvent) => void,
    private clock: () => number = () => performance.now(),
  ) {}

  /**
   * 처리한 앞부분을 떼어 낸 나머지. 인식기는 띄어쓰기를 자주 바꾸므로 공백을 뺀 글자 수로
   * 맞추고, 단어 중간에서 끊기면 그 단어는 버린다.
   */
  private remainder(full: string): string {
    const f = norm(full);
    // 1) 이미 처리한 마지막 단어를 찾아 그 뒤부터 — 중간·최종 인식의 글자가 달라도 끝 단어는 대개 같다.
    const cw = words(this.consumed);
    if (cw.length) {
      const fw = words(f);
      const last = bare(cw[cw.length - 1]);
      const fb = fw.map(bare);
      const idx = fb.indexOf(last);
      if (idx >= 0 && fb.indexOf(last, idx + 1) < 0) return fw.slice(idx + 1).join(' ');
    }
    // 2) 못 찾으면 공백 뺀 글자 수로 맞춘다.
    const target = bare(this.consumed).replace(/\s/g, '').length;
    let i = 0;
    let n = 0;
    while (i < f.length && n < target) {
      if (f[i] !== ' ' && bare(f[i]) !== '') n++;
      i++;
    }
    if (i > 0 && i < f.length && f[i] !== ' ' && f[i - 1] !== ' ') while (i < f.length && f[i] !== ' ') i++;
    return f.slice(i).trim();
  }

  /** 이 말이 가장 최근 인식 결과(최종이 왔으면 최종)에 아직 들어 있는가 — 공백 무시. */
  private stillHeard(text: string): boolean {
    const newest = bare(norm(this.finalText ?? this.prevPartial)).replace(/\s/g, '');
    return newest.includes(bare(norm(text)).replace(/\s/g, ''));
  }

  /**
   * 남은 말의 짧은 앞부분 중 이미 하나의 요청인 것 — XGEN 은 1.2초마다 여러 단어를 한꺼번에 내므로
   * "배송 메뉴 펼치고 통계 메뉴" 처럼 앞 요청 뒤에 다음 요청의 앞머리가 붙어 들어오고, 통째로 물으면
   * 모델은 기다리라고 한다. 앞부분 몇 개(두 단어 이상)의 실행 준비를 한 번에 묻고 '지금' 인 가장 긴 것을 고른다.
   */
  private async readyPrefix(cand: string, th: Thresholds): Promise<string | null> {
    const w = words(cand);
    const prefixes: string[] = [];
    for (let k = w.length - 1; k >= 2 && prefixes.length < 3; k--) prefixes.push(w.slice(0, k).join(' '));
    if (!prefixes.length) return null;
    // 말 전체도 묻는다 — 여러 단계·글쓰기 작업이면 앞부분만 떼어 실행하지 않는다(10/19 BO: "PDF에 있는 상품 설명으로 상품상세
    // 써서 넣어줘" 의 "… 써서" 를 따로 실행해 상품상세에 "상품" 을 넣음). 그러면 말 전체가 handle 로 가서 서버로 넘어간다.
    const r = await this.agent.readiness([cand, ...prefixes]).catch(() => []);
    if (r[0]?.ready === 'multi') return null;
    // 남은 말이 새 요청인지 실행 전에 묻는다 — 앞부분만 떼어 보면 완결된 말이라도("임시저장한 상품 확인" 0.98) 남은 말이 그
    // 꼬리면("페이지로 이동해줘") 한 요청이다. 실행한 뒤에 물으면 이미 엉뚱한 것(임시저장 버튼)을 누른 뒤다(10/19 BO). 긴 앞부분부터
    // 보고, 남은 말이 꼬리면 더 짧은 앞부분을 본다("전시안함 선택하고 선물하기 해당없음으로 | 해줘" → "전시안함 선택하고 | …").
    for (let i = 0; i < prefixes.length; i++) {
      if (r[i + 1]?.ready !== 'act_now' || r[i + 1].p < th.intent) continue;
      const rest = w.slice(words(prefixes[i]).length);
      const b = await this.agent.boundary(cand, prefixes[i], rest).catch(() => ({ start: 0, conf: 0 }));
      if (b.start >= 0) return prefixes[i];
    }
    return null;
  }

  /**
   * 중간 결과는 안정된 앞부분만 쓴다 — 직전 중간 결과와 단어가 같은 앞부분에서 마지막 단어
   * (아직 덜 들었을 수 있음)를 뺀 것. 인식기는 막 들은 단어를 자주 고친다.
   */
  partial(text: string): void {
    const cur = words(text);
    const prev = words(this.prevPartial);
    this.prevPartial = text;
    let k = 0;
    while (k < cur.length && k < prev.length && bare(cur[k]) === bare(prev[k])) k++;
    // XGEN 은 서버가 연속 두 가설의 일치(LocalAgreement)로 확정한 글자를 내므로 통째로 믿는다(TRUST_PARTIALS).
    // 끄면 직전 결과와 같은 앞부분에서 마지막 단어를 뺀 것만 쓴다.
    const stable = TRUST_PARTIALS ? cur.join(' ') : cur.slice(0, Math.min(k, cur.length - 1)).join(' ');
    this.onEvent({ type: 'partial', text: norm(text), t: this.clock() });
    if (this.finalText !== null || stable.length <= norm(this.latest).length) return;
    this.latest = stable;
    void this.pump();
  }

  /**
   * 서버가 토막을 끊었다(VAD final — 말이 잠깐 멈춤). 그 글자는 마지막 단어까지 확정이므로 안정 판정
   * (마지막 단어 빼기)을 거치지 않는다. 한국어는 동사가 끝에 오므로, 끝 단어를 빼면 실행 준비 판단이
   * 동사를 못 보고 늘 기다린다 — "기획전 보여주고 [쉼] 장바구니도 열어줘" 의 앞 명령을 쉼에서 실행한다.
   */
  confirm(text: string): void {
    this.prevPartial = text;
    this.onEvent({ type: 'partial', text: norm(text), t: this.clock() });
    const stable = norm(text);
    if (this.finalText !== null || stable.length <= norm(this.latest).length) return;
    this.latest = stable;
    void this.pump();
  }

  /** 최종 결과 — 남은 부분까지 처리하면 resolve 된다. */
  final(text: string): Promise<void> {
    this.latest = norm(text);
    this.finalText = this.latest;
    this.onEvent({ type: 'final', text: this.latest, t: this.clock() });
    const done = new Promise<void>((r) => (this.resolveDone = r));
    if (this.failure) {
      this.unhandled = null;
      this.finish();
      return done;
    }
    if (this.needsRecovery) {
      this.unhandled = this.remainder(this.latest) || this.lastSeg;
      this.finish();
      return done;
    }
    if (!this.latest) {
      this.finish();
      return done;
    }
    // 진행 중인 중간 판단을 기다리지 않는다 — 새 세대로 바로 최종 판단을 시작한다.
    this.epoch++;
    void this.pump();
    return done;
  }

  /** 지금까지 실행한 것이 있는가. */
  get acted(): boolean {
    return this.segStart !== null;
  }

  private finish(): void {
    this.finished = true;
    this.resolveDone?.();
  }

  private async pump(): Promise<void> {
    if (this.runningEpoch === this.epoch || this.finished) return;
    const my = this.epoch;
    this.runningEpoch = my;
    try {
      for (;;) {
        if (this.acting) await this.acting; // 이전 세대의 실행이 끝나고 기록될 때까지
        if (my !== this.epoch) return; // 최종 인식이 와서 새 세대가 이어받았다
        if (this.failure) { this.finish(); break; }
        const text = this.latest;
        this.lastTried = text;
        const isFinal = this.finalText !== null && text === this.finalText;
        const rest = this.remainder(text);
        if (this.needsRecovery) {
          this.unhandled = rest || this.lastSeg;
          if (isFinal) this.finish();
          break;
        }
        if (words(rest).length === 0) {
          if (isFinal) this.finish();
          break;
        }
        // 중간 결과로 실행하려면 두 단어 이상 — 한 단어만 듣고 누르면 엉뚱한 걸 누른다.
        if (!isFinal && words(rest).length < 2) break;
        // 이 발화에서 이미 하나를 실행했으면 남은 말은 앞 명령의 꼬리일 수 있다. 결정 모델에
        // 새 요청이 시작되는 단어를 묻고(없으면 꼬리말뿐), 그 단어부터를 새 명령으로 본다.
        const after = this.segStart !== null;
        const th = isFinal ? FINAL : PARTIAL;
        let outcome: Outcome | undefined;
        let cand = rest;
        /** 남은 말이 앞 요청의 꼬리라는데, 그 말만으로 누를 것이 분명한지 본다(아래). */
        let tail = false;
        if (after) {
          // 결정 모델 오류면 남은 말 전체를 새 요청으로 본다 — 못 하면 최종에서 서버로 간다(꼬리말로 치면 버려진다).
          const b = await this.agent.boundary(text, this.lastSeg, words(rest)).catch(() => ({ start: 0, conf: 0 }));
          if (my !== this.epoch) return;
          if (b.start < 0) {
            // 중간 인식에서는 자르지 않는다 — 뒷말이 아직 안 들어와서 꼬리말처럼 보일 수 있다.
            if (!isFinal) break;
            // 앱을 옮긴 토막의 나머지("PPT 앱 열어줘" 의 "앱 열어줘")는 이미 한 요청의 일부다 — 새 앱 화면에서 누르지 않는다.
            if (this.rereading) {
              this.rereading = false;
              this.consumed = text;
              this.finish();
              break;
            }
            // 꼬리말이라도 앞에서 실행한 토막에 그 뜻이 빠졌을 수 있다 — "삼성 입력하고 검색해줘" 는 한 요청으로
            // 읽히지만(10/16 BO 브랜드 찾기: none 0.999) 실행한 것은 "삼성 입력하고" 까지였다. 남은 말만으로 누를
            // 대상이 분명할 때만 누르고, 아니면 꼬리말로 친다(서버로 넘기지 않는다).
            tail = true;
          } else {
            cand = words(rest).slice(b.start).join(' ');
            this.rereading = false;
          }
        }
        let used = cand;
        if (!outcome) {
          /** 이 판단이 실행 잠금을 쥐고 있나 — 같은 판단 안의 재시도(요소 번호 만료)는 통과시킨다. */
          let holding = false;
          const pass = (ok: boolean): boolean => {
            if (ok && !this.acting) {
              this.acting = new Promise<void>((r) => (this.releaseActing = r));
              holding = true;
            }
            return ok;
          };
          const guard: Guard = async (target, kind, conf) => {
            // 이전 세대 판단·다른 판단의 실행 중이면 하지 않는다
            if (my !== this.epoch || (this.acting && !holding)) return false;
            // 판단하는 사이 인식 결과가 바뀌었으면(오인식 정정) 실행하지 않는다.
            if (!this.stillHeard(cand)) return false;
            if (!after) return pass(true);
            // 꼬리말만으로는 누르기만 — 넣을 글자는 앞 토막의 몫이다.
            if (tail && kind !== 'press') return false;
            // 두 번째 요청의 누르기는 말이 대상 이름을 가리키거나 고른 확신이 높아야 하고,
            // 방금 누른 것을 또 누르지 않는다(입력은 넣을 글자를 말하므로 이름 겹침을 보지 않는다).
            return pass(
              (kind === 'type' || mentions(cand, target) || (conf ?? 0) >= 0.9) &&
                !this.agent.lastTarget?.includes(target),
            );
          };
          const abort = (): boolean => my !== this.epoch || (!isFinal && this.latest !== text);
          const tw = words(text);
          /** 처리한 것으로 칠 글자 — 앞부분만 실행했으면 그 끝 단어까지(n = 처리한 앞 단어 수). */
          const upTo = (target: string, n = words(target).length): string =>
            tw.slice(0, tw.length - (words(cand).length - n)).join(' ');
          const run = async (target: string): Promise<Outcome> => {
            let o: Outcome | undefined;
            try {
              o = await this.agent.handle(target, th, guard, abort, text, tail);
            } catch (err) {
              // 판단·실행 중 오류(결정 모델 응답 없음 등) — 못 한 것으로 친다. 던지면 final() 이 끝나지 않는다.
              o = { acted: false, reason: `오류 ${err instanceof Error ? err.message : String(err)}`, ms: 0 };
            } finally {
              if (o && !o.acted && o.stop) {
                this.failure = o.reason;
                this.unhandled = null;
              }
              // 실행했으면 세대가 바뀌었어도 기록한다 — 화면은 이미 바뀌었다.
              if (o?.acted) {
                this.segStart = this.consumed;
                const reread = !!o.reread && words(target).length > 1;
                this.lastSeg = reread ? words(target)[0] : target;
                if (o.effect === 'none') this.needsRecovery = true;
                else this.consumed = upTo(target, reread ? 1 : undefined);
                this.rereading = reread && o.effect !== 'none';
              }
              if (holding) {
                this.releaseActing?.();
                this.releaseActing = null;
                this.acting = null;
                holding = false;
              }
            }
            return o;
          };
          // 최종이고 말이 길면(네 단어 이상) 두 요청을 이어 말했을 수 있다 — 앞부분이 이미 요청이면 그것부터.
          const first = isFinal && !tail && words(cand).length >= 4 ? await this.readyPrefix(cand, th) : null;
          if (my !== this.epoch) return;
          if (first) {
            outcome = await run(first);
            if (outcome.acted) used = first;
            else if (!outcome.stop) outcome = await run(cand); // 실행 실패가 아닌 미완성 앞부분만 통째로 다시 본다
          } else {
            outcome = await run(cand);
            // 중간 결과에서 기다리라고 하면, 짧은 앞부분이 이미 요청인지 본다.
            if (!isFinal && !outcome.acted && outcome.reason.startsWith('기다림') && words(cand).length >= 3 && !abort()) {
              const p = await this.readyPrefix(cand, th);
              if (p && !abort()) {
                const o2 = await run(p);
                if (o2.acted) [outcome, used] = [o2, p];
              }
            }
          }
          if (tail && !outcome.acted) outcome = { acted: false, reason: CONTINUATION, ms: outcome.ms };
        }
        if (my !== this.epoch) return;
        this.onEvent({ type: 'decide', text: used, partial: !isFinal, outcome, t: this.clock() });
        if (this.failure) { this.finish(); break; }
        if (!outcome.acted && outcome.reason === CONTINUATION && !this.stillHeard(used)) {
          // 판단하는 사이 인식이 정정됐다 — 처리한 것으로 치지 않고 최신 결과로 다시 본다.
          if (this.latest === text && !isFinal) break;
          continue;
        }
        if (!outcome.acted && outcome.reason === CONTINUATION) {
          this.consumed = text; // 꼬리말은 처리한 것으로 친다 — 다시 판단하지 않게
          if (isFinal) {
            this.finish();
            break;
          }
          if (this.latest === text) break;
          continue;
        }
        if (outcome.acted) {
          // (실행 기록은 handle 직후에 했다) 효과가 없었으면 이 발화의 나머지는 하지 않는다 — 엉뚱한 상태에서 계속하면 더 나빠진다.
          if (outcome.effect && outcome.effect !== 'ok') {
            this.unhandled = this.remainder(this.latest) || used;
            if (isFinal) this.finish();
            return;
          }
          continue;
        }
        if (isFinal) {
          // 최종인데 못 했다 — 남은 말은 서버 LLM 으로 넘긴다 (위험 동작 확인도 서버가 맡는다).
          this.unhandled = used;
          this.finish();
          break;
        }
        if (this.latest === text) break; // 새 말이 들어올 때까지 대기
      }
    } finally {
      if (this.runningEpoch === my) this.runningEpoch = -1;
    }
    if (my !== this.epoch) return;
    // 빠져나오는 사이에 새 말(또는 최종 결과)이 들어왔으면 다시 돈다.
    if (!this.finished && (this.latest !== this.lastTried || this.finalText !== null)) void this.pump();
  }
}
