/**
 * 말로 다른 맥 앱 조작 (실험) — 맨 앞 앱이 DeX 가 아니면 그 앱의 접근성(AX) 화면에서 판단·실행한다.
 *
 * 브라우저 칸 조작(fast-act-voice)과 같은 판단(E13 실행 준비·요소 고르기)·같은 기준을 쓰고 화면만 다르다:
 *   · 화면 = 맨 앞 앱의 초점 창 요소(창 안 3×3 위치) + 메뉴바 항목("보기 > 슬라이드 쇼").
 *   · 화면 밖 조작을 시스템 후보로 맨 앞에 붙인다(브라우저의 뒤로·탭과 같은 방식): 발표·전체 화면 끝내기와
 *     다음/이전(Esc·→·← 키, 앱 창이 화면 하나를 통째로 덮을 때만), 앱 숨기기, 창 최소화, DeX 앞으로.
 *     이것이 없으면 "장표 내려줘" 에 `파일 > 닫기` 를 0.95 로 고른다(10/16 측정).
 *   · 되돌릴 수 없을 수 있는 항목(닫기·종료·저장·휴지통·삭제 …)은 후보에서 뺀다 — 남는 후보는 모두 되돌릴 수 있다.
 *   · 글자 입력은 하지 않는다(누르기만). 입력 요청은 서버 에이전트로 넘어간다.
 *
 * 켜는 조건: 맥 + 설정 computerAct(기본 꺼짐) + 빠른 조작 + 접근성 도우미(mac-ax). 접근성 권한은 DeX 가 받는다.
 */
import { diag } from './diag-log';
import {
  DANGEROUS_BROWSER_REQUEST as DANGEROUS_REQUEST,
  DANGEROUS_BROWSER_TARGET as DANGEROUS,
  classify,
  decisionState,
  elementDisplay,
  elementLabel,
  pickElement,
  type ElementRef,
  type ElementRefs,
} from './fast-act';
import { CHROME_PICK } from './fast-act-chrome';
import { FORMAT, READY_OPTS, READY_Q, buildScreen, type Screen13, type ScreenRef } from './fast-act-e13';
import { decisionPost } from './fast-act-runner';
import { TYPING_WORD, type BrowserVoiceAgent, type VoiceAction } from './fast-act-voice';
import {
  AX_STALE,
  axFront,
  axHide,
  axKeys,
  axMinimize,
  axPress,
  axSnapshot,
  macAxAvailable,
  type AxFront,
  type AxSnapshot,
} from './mac-ax';
import { GUARDED, mentions, type Guard, type Outcome, type Thresholds, type VoiceAgent } from './voice-segmenter';

const SCOPE = 'voice-computer';
/** 판단에 쓰는 스냅샷의 최대 나이, 뒤에서 새로 읽기 시작하는 나이 — 브라우저 칸과 같다. */
const SNAP_TTL_MS = 3_000;
const SNAP_REFRESH_MS = 1_000;
/** 맨 앞 앱 조회를 재사용하는 시간 — 한 판단 안의 여러 질문이 같은 앱을 보게. */
const FRONT_TTL_MS = 300;
/** 말이 끝났는데 요소 이름만 말했을 때 누르는 확신 하한. */
const NAMED_ONLY_PICK = 0.8;
/** 누른 뒤 앱 화면이 바뀌기를 기다리는 시간 — AX 에는 페이지 로드 같은 끝 신호가 없다. */
const SETTLE_MS = 300;
const DEX_NAME = 'XGen Dex';
const now = (): number => performance.now();

/**
 * 앱 메뉴·창에서 되돌릴 수 없을 수 있는 항목(브라우저 DANGEROUS 에 더해) — 후보에서 뺀다. 맥 한국어 메뉴는 종료를
 * "PowerPoint 끝내기" 로 쓴다(10/16 실측 — 빠뜨리면 "피피티 내려 줘" 가 앱 끝내기를 1.00 으로 고른다). 보내기·인쇄는
 * 바깥으로 나가고, 버리기·복귀는 고친 내용을 잃는다.
 */
export const MAC_DANGEROUS =
  /(닫기|종료|끝내기|저장|휴지통|강제|잠자기|재시동|다시 시작|버리기|폐기|복귀|인쇄|보내기|전송|close|quit|save|trash|force|sleep|restart|shut ?down|discard|revert|print|send)/i;
/** 누르기만 해서는 아무 일도 없는 요소(입력칸·슬라이더) — 후보에서 뺀다. */
const NO_PRESS = new Set(['textbox', 'searchbox', 'slider']);

export type ComputerActDeps = {
  enabled: () => boolean;
  /** DeX 메인 창을 보이고 앞으로. */
  showDex: () => void;
};

let deps: ComputerActDeps | null = null;
let helperFound = false;

export function configureComputerAct(d: ComputerActDeps): void {
  deps = d;
}

export function computerActEnabled(): boolean {
  if (process.platform !== 'darwin' || FORMAT !== 'e13' || !deps?.enabled()) return false;
  helperFound ||= macAxAvailable();
  return helperFound;
}

let frontCache: { at: number; p: Promise<AxFront | null> } | null = null;

/** 맨 앞 앱이 DeX 가 아니면 그 앱 — 다른 앱 조작이 꺼져 있거나 DeX 가 맨 앞이면 null. */
export async function externalFront(): Promise<AxFront | null> {
  if (!computerActEnabled()) return null;
  if (!frontCache || now() - frontCache.at > FRONT_TTL_MS) {
    frontCache = { at: now(), p: axFront().catch(() => null) };
  }
  const f = await frontCache.p;
  return f && f.pid !== process.pid ? f : null;
}

type SystemAction = { role: string; name: string; run: () => Promise<void> };

/** 화면 밖 조작 — 번호는 앱 요소(e1…)와 겹치지 않게 e9001 부터. */
export function systemActions(ax: Pick<AxSnapshot, 'app' | 'pid' | 'presenting' | 'window'>, showDex: () => void): Record<string, SystemAction> {
  const out: Record<string, SystemAction> = {};
  const add = (a: SystemAction): void => void (out[`e${9001 + Object.keys(out).length}`] = a);
  // 키는 맨 앞 앱으로 간다 — 이 판단기는 그 앱이 맨 앞일 때만 쓰인다.
  const key = (combo: string) => (): Promise<void> => axKeys(combo);
  if (ax.presenting) {
    add({ role: 'button', name: '발표(전체 화면) 끝내기 (Esc 키)', run: key('escape') });
    add({ role: 'button', name: '다음 슬라이드·장 (→ 키)', run: key('right') });
    add({ role: 'button', name: '이전 슬라이드·장 (← 키)', run: key('left') });
  }
  // "내리기" 를 이름에 둔다 — "앱 숨기기" 만이면 "ppt 내려줘" 가 발표 끝내기(Esc)로 가서 앱 창이 앞에 남았다
  // (10/18 dev 판단 모델: 내려줘류 7문장 0/7 → 7/7, 발표 끝내기·다음·이전·DeX 앞으로 문장은 그대로). 말을 듣는
  // DeX 를 먼저 앞으로 가져온 뒤 숨긴다 — 맨 앞 앱을 숨기면 macOS 가 뒤에 있던 앱을 비동기로 앞에 올려, 숨긴 뒤
  // 가져오면 그 앱(10/18 슬라이드 쇼: iTerm2)에 밀렸다.
  add({
    role: 'button',
    name: `${ax.app} 내리기 (앱 숨기기)`,
    run: async () => {
      showDex();
      await axHide(ax.pid);
    },
  });
  if (ax.window !== undefined && !ax.presenting) add({ role: 'button', name: `${ax.app} 창 최소화`, run: () => axMinimize(ax.pid) });
  add({ role: 'button', name: `${DEX_NAME} 앞으로 가져오기`, run: async () => showDex() });
  return out;
}

/** 앱 요소 → 후보. 위험한 항목·누를 수 없는 요소·이름 없는 요소는 빼고, 틀은 창 안 좌표로 바꾼다. */
export function appRefs(ax: Pick<AxSnapshot, 'refs' | 'windowFrame'>): { refs: ElementRefs; list: ScreenRef[]; size?: number[] } {
  const wf = ax.windowFrame;
  const refs: ElementRefs = {};
  const list: ScreenRef[] = [];
  for (const r of ax.refs) {
    const name = (r.name ?? '').trim();
    if (!name || NO_PRESS.has(r.role) || DANGEROUS.test(name) || MAC_DANGEROUS.test(name)) continue;
    let frame: number[] | undefined;
    let visible = true;
    if (r.frame && wf) {
      frame = [r.frame[0] - wf[0], r.frame[1] - wf[1], r.frame[2], r.frame[3]];
      // 창 밖(스크롤로 가려진) 요소는 보이지 않는다.
      visible = frame[0] + frame[2] > 0 && frame[1] + frame[3] > 0 && frame[0] < wf[2] && frame[1] < wf[3];
    }
    refs[r.ref] = { role: r.role, name };
    list.push({ ref: r.ref, role: r.role, name, frame, visible });
  }
  return { refs, list, size: wf ? [wf[2], wf[3]] : undefined };
}

type MacSnap = {
  at: number;
  pid: number;
  gen: number;
  ax: AxSnapshot;
  origin: string;
  refs: ElementRefs;
  system: Record<string, SystemAction>;
  scr: Screen13;
};

function originOf(ax: AxSnapshot): string {
  const win = ax.window ? ` — ${ax.window.slice(0, 40)}` : '';
  return `${ax.app}${win}${ax.presenting ? ' (전체 화면)' : ''}`;
}

function buildSnap(ax: AxSnapshot): MacSnap {
  const system = systemActions(ax, () => deps?.showDex());
  const head = Object.entries(system).map(([ref, a]) => ({ ref, role: a.role, name: a.name }));
  const { refs, list, size } = appRefs(ax);
  const origin = originOf(ax);
  return {
    at: now(),
    pid: ax.pid,
    gen: ax.gen,
    ax,
    origin,
    refs: { ...Object.fromEntries(head.map((h) => [h.ref, { role: h.role, name: h.name }])), ...refs },
    system,
    scr: buildScreen(origin, list, size, head),
  };
}

export class ComputerVoiceAgent implements VoiceAgent {
  private snap: MacSnap | null = null;
  private inflight: Promise<MacSnap | null> | null = null;
  /** 실행할 때마다 오른다 — 실행 전에 시작한 스냅샷 결과는 화면 기억에 남기지 않는다. */
  private version = 0;
  /** 판단 중인 handle 수 — 판단하는 동안에는 미리 읽기를 하지 않는다(새 스냅샷은 요소 번호를 바꾼다). */
  private deciding = 0;

  constructor(
    private t0: number,
    /** 실행 기록 — 브라우저 칸 판단기와 같은 배열에 모은다. */
    readonly actions: VoiceAction[],
    private onAct?: (a: VoiceAction) => void,
  ) {}

  get lastTarget(): string | null {
    return this.actions.at(-1)?.label ?? null;
  }

  prefetch(front: AxFront): void {
    if (this.deciding > 0 || this.inflight) return;
    if (this.snap && this.snap.pid === front.pid && now() - this.snap.at < SNAP_REFRESH_MS) return;
    void this.snapshot(front, true).catch(() => undefined);
  }

  private async snapshot(front: AxFront, refresh = false): Promise<MacSnap | null> {
    const fresh = (s: MacSnap | null): s is MacSnap => !!s && s.pid === front.pid && now() - s.at < SNAP_TTL_MS;
    if (this.inflight) {
      const s = await this.inflight;
      if (fresh(s)) return s;
    }
    if (!refresh && fresh(this.snap)) return this.snap;
    const v = this.version;
    const p = axSnapshot(front.pid).then(buildSnap);
    this.inflight = p.catch(() => null);
    let got: MacSnap;
    try {
      got = await p;
    } finally {
      this.inflight = null;
    }
    if (v === this.version) this.snap = got;
    return got;
  }

  private async current(): Promise<MacSnap | null> {
    const front = await externalFront();
    return front ? this.snapshot(front) : null;
  }

  /** 화면이 바뀐다 — 스냅샷과 맨 앞 앱 기억을 버린다. */
  private forget(): void {
    this.version++;
    this.snap = null;
    frontCache = null;
  }

  async boundary(utterance: string, done: string, rest: string[]): Promise<{ start: number; conf: number }> {
    const post = decisionPost();
    if (!post) return { start: -1, conf: 0 };
    const s = await this.current().catch(() => null);
    const criteria: Record<string, string> = {
      none: 'there is no second request — the remaining words only finish the first one',
    };
    rest.forEach((w, i) => (criteria[`w${i}`] = `starts at "${w}"`));
    const a = await post({
      state: decisionState(utterance, s?.origin ?? '', s?.scr ?? null),
      questions: {
        q: {
          type: 'choice',
          instructions: `In "${utterance}", the first request ("${done}" …) is done. Where does a second, different request start?`,
          criteria,
        },
      },
    });
    const probs = a.q?.probabilities ?? {};
    const none = probs.none ?? 0;
    let best = -1;
    let bestP = -1;
    rest.forEach((_, i) => {
      const p = probs[`w${i}`] ?? 0;
      if (p > bestP) [best, bestP] = [i, p];
    });
    if (a.q?.choice === 'none' && none >= 0.6) return { start: -1, conf: none };
    return { start: best, conf: bestP };
  }

  async readiness(texts: string[]): Promise<Array<{ ready: string; p: number }>> {
    const post = decisionPost();
    const s = await this.current().catch(() => null);
    if (!post || !s) return texts.map(() => ({ ready: 'wait', p: 0 }));
    return Promise.all(
      texts.map(async (t) => {
        const a = await post({
          state: decisionState(t, s.origin, s.scr),
          questions: { ready: { type: 'choice', instructions: READY_Q, criteria: READY_OPTS } },
        }).catch(() => ({}) as Record<string, { choice?: string; probabilities?: Record<string, number> }>);
        return { ready: a.ready?.choice ?? 'wait', p: a.ready?.probabilities?.act_now ?? 0 };
      }),
    );
  }

  async handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean): Promise<Outcome> {
    this.deciding++;
    try {
      const o = await this.handleOnce(text, th, guard, abort);
      // 판단 도중 다른 스냅샷이 떠서 요소 번호가 바뀌었으면 화면을 새로 읽어 한 번만 다시 판단한다.
      if (!o.acted && o.reason.includes(AX_STALE)) {
        this.snap = null;
        return await this.handleOnce(text, th, guard, abort);
      }
      return o;
    } finally {
      this.deciding--;
    }
  }

  private async handleOnce(text: string, th: Thresholds, guard: Guard, abort: () => boolean): Promise<Outcome> {
    const t0 = now();
    const no = (reason: string, detail?: unknown): Outcome => ({ acted: false, reason, ms: now() - t0, detail });
    const post = decisionPost();
    if (!post) return no('결정 모델 없음');
    let s: MacSnap | null;
    try {
      s = await this.current();
    } catch (err) {
      return no(`앱 화면 읽기 실패 ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!s) return no('맨 앞 앱 없음');

    const cls = await classify(post, text, s.origin, s.scr);
    const rc = cls.gate.toFixed(2);
    if (cls.ready === 'not_ui') return no(`화면 조작 아님 ${rc}`);
    // 말이 끝났는데 요소 이름만 말한 경우 — 브라우저 칸과 같은 규칙(아래에서 확신·이름 겹침을 본다).
    const namedOnly = !th.partial && cls.ready === 'wait';
    if ((th.partial && cls.ready !== 'act_now') || (cls.gate < th.intent && !namedOnly)) {
      return no(`기다림 ${cls.ready} ${rc}`);
    }
    if (abort()) return no('판단 취소(새 인식)');
    if (DANGEROUS_REQUEST.test(text)) return no('되돌릴 수 없을 수 있는 동작 — 서버로');
    if (cls.action !== 'click' && !!cls.text && TYPING_WORD.test(text)) return no('맥 앱 글자 입력은 하지 않음 — 서버로');

    const pick = await pickElement(post, text, s.origin, s.refs, s.scr);
    if (process.env.DEX_VOICE_TEST === '1') {
      diag(SCOPE, 'debug-screen', {
        text,
        app: s.ax.app,
        presenting: s.ax.presenting,
        snapMs: Math.round(s.ax.ms),
        refs: s.ax.refs.length,
        cands: Object.keys(s.refs).length,
        screen: s.scr.text.split('\n').slice(0, 20).join(' | '),
        top: pick?.top,
      });
    }
    if (!pick || pick.confidence < th.pick) return no(`요소 확신 낮음 ${pick?.confidence.toFixed(2)}`, pick?.top);
    const sys = s.system[pick.ref];
    if (sys && pick.confidence < CHROME_PICK) return no(`시스템 조작 확신 낮음 ${pick.confidence.toFixed(2)}`, pick.top);
    const element = s.refs[pick.ref];
    if (namedOnly && (pick.confidence < NAMED_ONLY_PICK || !mentions(text, element.name ?? ''))) {
      return no(`기다림 wait ${rc} (이름만 — 확신 ${pick.confidence.toFixed(2)})`, pick.top);
    }
    if (!(await guard(element.name ?? '', 'press', pick.confidence))) return no(GUARDED, pick.top);
    const decideMs = now() - t0;

    const tAct = now();
    try {
      if (sys) await sys.run();
      else await axPress(pick.ref, s.gen);
    } catch (err) {
      this.forget();
      return no(`실행 실패 ${err instanceof Error ? err.message : String(err)}`, pick.top);
    }
    const done = await this.record(text, element, th, decideMs, now() - tAct, pick, s);
    return { acted: true, kind: 'press', target: done.label, ms: now() - t0, effect: 'ok' };
  }

  private async record(
    said: string,
    element: ElementRef,
    th: Thresholds,
    decideMs: number,
    actMs: number,
    pick: { confidence: number; top?: unknown },
    s: MacSnap,
  ): Promise<VoiceAction> {
    const at = now() - this.t0;
    this.forget();
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    this.forget(); // 기다리는 사이 읽은 화면도 버린다
    const done: VoiceAction = {
      said,
      label: elementLabel(element),
      display: `${s.ax.app} ${elementDisplay(element)}`,
      action: 'click',
      text: null,
      partial: th.partial,
      decideMs: Math.round(decideMs),
      actMs: Math.round(actMs),
      at: Math.round(at),
      navigated: false,
    };
    this.actions.push(done);
    this.onAct?.(done);
    diag(SCOPE, 'act', { ...done, app: s.ax.app, presenting: s.ax.presenting, snapMs: Math.round(s.ax.ms), pick: Number(pick.confidence.toFixed(3)), top: pick.top });
    return done;
  }
}

/**
 * 맨 앞 앱으로 판단기를 고른다 — DeX 가 아닌 앱이 맨 앞이고 다른 앱 조작이 켜져 있으면 그 앱(ComputerVoiceAgent),
 * 아니면 이 에이전트의 브라우저 칸(BrowserVoiceAgent). 판단 호출마다 다시 본다(앞 조작으로 맨 앞 앱이 바뀐다).
 * 실행 기록은 두 판단기가 같은 배열에 모은다.
 */
export class RoutedVoiceAgent implements VoiceAgent {
  readonly actions: VoiceAction[];
  private computer: ComputerVoiceAgent;

  constructor(
    private browser: BrowserVoiceAgent,
    t0: number,
    onAct?: (a: VoiceAction) => void,
  ) {
    this.actions = browser.actions;
    this.computer = new ComputerVoiceAgent(t0, browser.actions, onAct);
  }

  get lastTarget(): string | null {
    return this.actions.at(-1)?.label ?? null;
  }

  private async route(): Promise<VoiceAgent> {
    return (await externalFront()) ? this.computer : this.browser;
  }

  prefetch(): void {
    if (!computerActEnabled()) return this.browser.prefetch();
    void externalFront().then((f) => (f ? this.computer.prefetch(f) : this.browser.prefetch()));
  }

  async boundary(utterance: string, done: string, rest: string[]): Promise<{ start: number; conf: number }> {
    return (await this.route()).boundary(utterance, done, rest);
  }

  async readiness(texts: string[]): Promise<Array<{ ready: string; p: number }>> {
    return (await this.route()).readiness(texts);
  }

  async handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean, utterance: string): Promise<Outcome> {
    return (await this.route()).handle(text, th, guard, abort, utterance);
  }
}
