/**
 * 빠른 조작의 맥 앱 열기·전환 (실험) — "PPT 열어줘" 를 서버 에이전트(데스크탑 앱 도구, 약 21초) 대신 결정 모델이 바로 한다.
 *
 * 결정 모델은 화면 요소 고르기만 배웠다 — "앱 요청이냐" 를 따로 물으면 답이 엉망이다(10/18: 38문장 중 23, "카톡 열어줘"
 * 도 '페이지'). 그래서 앱을 화면 요소처럼 붙여 페이지 요소와 같은 질문으로 고르게 한다(브라우저의 뒤로·탭과 같은 방식):
 *   · 실행 중인 앱 — 화면 맨 위 후보 "<앱> 앱으로 전환 (맥 데스크탑 앱)". 맨 앞 앱과 DeX 자신은 뺀다.
 *   · 설치된 앱 — 화면 맨 끝 "<앱> 앱 실행 (맥 데스크탑 앱)". 맨 위에 두면 맥 앱 이름(날씨·메일·주식 …)이 페이지 요소를
 *     가로챘다("날씨 눌러줘" → 날씨 앱). 맨 위의 "다른 맥 앱 열기" 하나로 대신하면 실행 중이 아닌 앱을 거의 못 골랐다.
 *   · 숨겨 둔 앱(앱 내리기·⌘H) — "<앱> 앱 다시 띄우기 (맥 데스크탑 앱)". "앱으로 전환" 이면 발표 중 내린 PowerPoint 를
 *     "장표 다시 올려줘"·"발표 화면 다시 보여줘" 로 못 골랐다(10/27: 8문장 중 5 → 8).
 *   · 앱 후보가 이기면 앱 목록(실행 중 + 설치됨)만 놓고 한 번 더 고른다 — 큰 화면에서는 앱끼리 헷갈린다("워드 켜줘" →
 *     PowerPoint 전환 0.98, 앱 목록에서는 Word 1.00). 목록도 화면 후보와 같은 문구다 — 앱 이름만 두면 첫 판단이 맞게
 *     고른 숨긴 PowerPoint 를 "발표 자료 다시 띄워줘" 에 Keynote 로 바꿔 열었다(10/27: 8문장 중 5·엉뚱한 실행 1 → 8·0,
 *     다른 앱 요청 10문장은 그대로 10).
 *   · 브라우저 탭이 없는 DeX 앞 화면 — 맨 위에 웹 후보(WEB_CAND). 앱 후보만 있으면 사이트 요청이 브라우저·비슷한 이름의 앱을 열었다.
 *   · 발표 중인 PowerPoint — 맨 위에 다음·이전 장, 쇼 끝내고 내리기(voice-presentation). 쇼를 끝내고 내린 PowerPoint 를
 *     "다시 띄우기" 로 고르면 앱만 보이지 않고 현재 슬라이드부터 쇼를 다시 시작한다.
 * 측정(10/18 dev 판단 모델, 네이버 첫 화면, 앱 요청 17 + 페이지 요청 14): 실행 중인 앱 6개일 때 26/31·엉뚱한 실행 3,
 * 16개일 때 28/31·0. 페이지 요청은 모두 그대로였고, 나머지는 확신이 낮아 서버 에이전트로 간다.
 * 앱 이름은 보이는 이름("계산기")과 번들 이름("Calculator") 둘 다 싣는다 — 사람은 한국어로 부른다(Spotlight 표시 이름).
 *
 * 켜는 조건은 말로 하는 다른 앱 조작과 같다(fast-act-computer 가 configureDesktopAct 로 넘긴다).
 */
import { execFile } from 'node:child_process';
import { listInstalledApps, type InstalledApp } from '@dex/engine/app-launch';
import { openWithDefaultApp } from '@dex/engine/local-tools';
import { diag } from './diag-log';
import { classify, decisionState, GATE_INTENT_Q, pickElement, type DecisionPost, type ElementRefs } from './fast-act';
import { CHROME_PICK } from './fast-act-chrome';
import { READY_OPTS, READY_Q, buildScreen, type Screen13 } from './fast-act-e13';
import { decisionPost } from './fast-act-runner';
import { dexCommandRefs, runDexCommand, type DexCommand } from './fast-act-dex';
import type { VoiceAction } from './fast-act-voice';
import { endedShow, namedControl, namedControlOk, presentationControls, restartShow, runPresentation, weakSlidePick, type PresentationControl } from './voice-presentation';
import { axActivate, axApps, axSnapshot, type AxApp } from './mac-ax';
import { GUARDED, type Guard, type Outcome, type Thresholds, type VoiceAgent } from './voice-segmenter';

const SCOPE = 'fast-act-desktop';
/** 실행 중인 앱 목록을 재사용하는 시간 — 한 판단 안의 여러 질문이 같은 후보를 보게. */
const RUNNING_TTL_MS = 1_000;
/** 설치된 앱 목록(폴더 읽기 + 표시 이름)을 재사용하는 시간. */
const INSTALLED_TTL_MS = 60_000;
/** 앱을 연 뒤 맨 앞에 오기를 기다리는 시간(처음 실행은 느리다), 떠 있는 앱을 앞으로 가져오는 시간. */
const LAUNCH_WAIT_MS = 8_000;
const FRONT_WAIT_MS = 2_000;
/** 맨 앞에 온 뒤 창이 뜨기를 기다리는 시간 — 다음 지시("새 프레젠테이션 만들어줘")가 창 요소를 봐야 한다. */
const WINDOW_WAIT_MS = 1_500;
const POLL_MS = 150;
/** 설치된 앱 후보의 번호 — 화면 맨 위 후보(e9001…)·페이지·앱 요소(e1…)와 겹치지 않게. */
const TAIL_START = 8001;
const LIST_ORIGIN = '맥 앱 (실행 중·설치됨)';
const LAUNCHER_ORIGIN = 'XGen Dex';
/**
 * 브라우저 탭이 없는 DeX 앞 화면(LauncherVoiceAgent)의 맨 위 후보 — 사이트·웹 검색 요청을 받는 자리. 앱 후보만 있으면
 * "네이버 들어가서 …" 가 Safari 실행 0.86, "네이버 열어줘" 가 Finder 전환 1.00 으로 갔다(10/27: 웹 요청 12개 중 11개가
 * 앱 실행, Safari 가 실제로 켜짐). 이 후보가 이기면 서버 에이전트가 DeX 브라우저로 연다(빠른 조작은 주소로 가는 법이 없다).
 * 앱 목록 고르기에도 같은 후보를 둔다 — 첫 판단에서 앱이 이겨도 앱 목록에서 웹으로 갈 수 있게.
 * 측정(10/27 dev 판단 모델, 웹 요청 22 + 앱 요청 26): 웹 요청의 앱 실행 12 → 3, 앱 요청 맞게 23 → 25(틀린 앱 0 → 1:
 * "메일 앱 열어줘" → Outlook), 숨긴 PowerPoint 다시 띄우기 8문장은 8 그대로.
 */
export const WEB_CAND = '웹사이트 열기·검색 (DeX 브라우저)';
const WEB_REF = 'e9001';
const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** DeX 자신의 번들 — 설치된 앱 후보에서 뺀다. */
const SELF_BUNDLE = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');

let enabled: () => boolean = () => false;

export function configureDesktopAct(fn: () => boolean): void {
  enabled = fn;
}

export function desktopActEnabled(): boolean {
  return enabled();
}

let running: { at: number; p: Promise<AxApp[]> } | null = null;

function runningApps(): Promise<AxApp[]> {
  if (!running || now() - running.at > RUNNING_TTL_MS) running = { at: now(), p: axApps().catch(() => []) };
  return running.p;
}

/** Spotlight 의 표시 이름(사용자 언어) — 한 번에 묻는다(앱 130개 0.1초). 못 읽은 앱은 빈 문자열. */
function displayNames(paths: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('mdls', ['-raw', '-name', 'kMDItemDisplayName', ...paths], { maxBuffer: 1 << 20, timeout: 3_000 }, (_err, out) => {
      // 한 앱이라도 못 읽으면 종료 코드가 0 이 아니다 — 읽은 것은 그대로 쓴다.
      const names = String(out ?? '').split('\0');
      resolve(paths.map((_, i) => {
        const n = (names[i] ?? '').normalize('NFC').trim().replace(/\.app$/i, '');
        return n === '(null)' ? '' : n;
      }));
    });
  });
}

let installed: { at: number; p: Promise<InstalledApp[]> } | null = null;

/** 설치된 앱 — 번들 이름과 다르면 표시 이름("계산기")도. */
export function installedApps(): Promise<InstalledApp[]> {
  if (!installed || now() - installed.at > INSTALLED_TTL_MS) {
    installed = {
      at: now(),
      p: listInstalledApps()
        .then(async (apps) => {
          const names = await displayNames(apps.map((a) => a.path));
          return apps.map((a, i) => (names[i] && names[i] !== a.name ? { ...a, displayName: names[i] } : a));
        })
        .catch(() => []),
    };
  }
  return installed.p;
}

/** 앱 하나 — 고르면 이것을 연다. label = 설치된 앱의 "표시 이름 (번들 이름)", hidden = 실행 중인데 숨겨 둔 앱. */
export type DesktopApp = { name: string; label: string; path: string; pid?: number; hidden?: boolean };
/**
 * 화면에 붙일 앱 후보 — head 는 맨 위(DeX 명령·발표 조작·실행 중), tail 은 맨 끝(설치됨). controls = head 의 발표 조작,
 * commands = head 의 DeX 자체 명령(DeX 가 맨 앞일 때만, fast-act-dex).
 */
export type DesktopCands = {
  head: ElementRefs;
  tail: ElementRefs;
  apps: Record<string, DesktopApp>;
  controls: Record<string, PresentationControl>;
  commands: Record<string, DexCommand>;
};

export const NO_DESKTOP: DesktopCands = { head: {}, tail: {}, apps: {}, controls: {}, commands: {} };

const labelOf = (a: InstalledApp): string => (a.displayName ? `${a.displayName} (${a.name})` : a.name);

/** 앱 후보 이름 — 화면 후보와 앱 목록(openPickedApp)이 같이 쓴다. */
export const candName = (a: DesktopApp): string =>
  a.pid === undefined
    ? `${a.label} 앱 실행 (맥 데스크탑 앱)`
    : a.hidden
      ? `${a.name} 앱 다시 띄우기 (맥 데스크탑 앱)`
      : `${a.name} 앱으로 전환 (맥 데스크탑 앱)`;

/** 실행 중인 앱(맨 앞 앱·DeX 제외) 다음에 설치된 앱(실행 중인 것·DeX 제외). */
async function appList(exceptPid: number | null): Promise<DesktopApp[]> {
  const [run, inst] = await Promise.all([runningApps(), installedApps()]);
  const paths = new Set(run.map((a) => a.path));
  return [
    ...run
      .filter((a) => a.pid !== process.pid && a.pid !== exceptPid)
      .map((a) => ({ name: a.app, label: a.app, path: a.path, pid: a.pid, hidden: a.hidden })),
    ...inst.filter((a) => !paths.has(a.path) && a.path !== SELF_BUNDLE).map((a) => ({ name: a.displayName ?? a.name, label: labelOf(a), path: a.path })),
  ];
}

/**
 * 화면에 붙일 앱 후보 — 꺼져 있으면 없음. frontPid = 지금 맨 앞 앱(그 앱 화면에서 판단할 때 — 이미 앞에 있으니 뺀다),
 * null 이면 DeX 가 맨 앞이라 DeX 자체 명령을 맨 위에 둔다. headStart = 맨 위 후보의 첫 번호(앞의 시스템 후보 다음).
 */
export async function desktopCands(frontPid: number | null, headStart: number): Promise<DesktopCands> {
  if (!desktopActEnabled()) return NO_DESKTOP;
  const dex = frontPid === null ? dexCommandRefs(headStart) : { refs: {}, commands: {} };
  // 발표 조작은 맨 앞 앱(PPT 쇼가 맨 앞일 때)도 — 앱 후보만 맨 앞 앱을 뺀다.
  const { refs, controls } = presentationControls(await runningApps(), headStart + Object.keys(dex.refs).length);
  const out: DesktopCands = { head: { ...dex.refs, ...refs }, tail: {}, apps: {}, controls, commands: dex.commands };
  for (const a of await appList(frontPid)) {
    const head = a.pid !== undefined;
    const into = head ? out.head : out.tail;
    const ref = `e${(head ? headStart : TAIL_START) + Object.keys(into).length}`;
    into[ref] = { role: 'button', name: candName(a) };
    out.apps[ref] = a;
  }
  return out;
}

/** 발표 조작 뒤 — 실행 중인 앱 목록(발표 중 여부)을 새로 읽게. */
export function forgetRunning(): void {
  running = null;
}

/** 앱을 열거나 앞으로 가져와 맨 앞에 올 때까지 기다리고, 창이 뜨기를 잠깐 기다린다. */
async function bringFront(a: DesktopApp): Promise<AxApp> {
  // `open <번들>` — 실행하거나, 떠 있으면(숨김 포함) 앞으로. 번들 경로를 모르는 실행 중인 앱만 접근성으로.
  if (a.path) {
    const err = await openWithDefaultApp(a.path);
    if (err) throw new Error(err);
  } else if (a.pid !== undefined) {
    await axActivate(a.pid);
  }
  const match = (x: AxApp): boolean => (a.pid !== undefined ? x.pid === a.pid : x.path === a.path);
  const limit = a.pid !== undefined ? FRONT_WAIT_MS : LAUNCH_WAIT_MS;
  let front: AxApp | undefined;
  for (const t = now(); ; await sleep(POLL_MS)) {
    running = null;
    front = (await runningApps()).find((x) => match(x) && x.front);
    if (front || now() - t > limit) break;
  }
  if (!front) throw new Error(`${a.name} 이(가) 맨 앞에 오지 않음`);
  for (const t = now(); now() - t < WINDOW_WAIT_MS; await sleep(POLL_MS)) {
    const ax = await axSnapshot(front.pid, 800).catch(() => null);
    if (ax && ax.windowCount > 0) break;
  }
  running = null;
  return front;
}

/**
 * 앱 후보가 이겼다 — 앱 목록만 놓고 어느 앱인지 다시 고르고, 열어서 맨 앞에 올 때까지 기다린다. 확신이 낮거나
 * 열지 못하면 throw(서버 에이전트로 넘어간다). web = 목록 맨 앞에 둘 웹 후보(WEB_CAND) — 그것을 고르면 열지 않는다.
 */
export async function openPickedApp(post: DecisionPost, said: string, web?: string): Promise<{ app: string; pid: number; pickMs: number; openMs: number; sentence?: string }> {
  const t0 = now();
  const list = await appList(null);
  const lead = web ? 1 : 0;
  const refs: ElementRefs = Object.fromEntries([
    ...(web ? [['e1', { role: 'button', name: web }] as const] : []),
    ...list.map((a, i) => [`e${i + 1 + lead}`, { role: 'button', name: candName(a) }] as const),
  ]);
  const pick = await pickElement(post, said, LIST_ORIGIN, refs, screenOf(LIST_ORIGIN, refs));
  const target = pick ? list[Number(pick.ref.slice(1)) - 1 - lead] : undefined;
  diag(SCOPE, 'pick-app', { said, app: target ? candName(target) : pick && refs[pick.ref]?.name, conf: pick && Number(pick.confidence.toFixed(3)), top: pick?.top });
  if (web && pick?.ref === 'e1') throw new Error('웹 페이지 요청');
  if (!pick || !target || pick.confidence < CHROME_PICK) throw new Error(`앱 확신 낮음 ${pick?.confidence.toFixed(2) ?? '-'}`);
  const pickMs = now() - t0;
  if (target.hidden && endedShow(target.pid)) {
    await restartShow(target.pid!);
    running = null;
    return { app: target.name, pid: target.pid!, pickMs, openMs: now() - t0 - pickMs, sentence: '발표 화면을 현재 슬라이드부터 다시 띄웠어요.' };
  }
  const front = await bringFront(target);
  return { app: target.name, pid: front.pid, pickMs, openMs: now() - t0 - pickMs };
}

/** 앱을 연 기록 — 답은 "<앱> 앱을 열었어요."(fast-act-reply). */
export function openedAction(said: string, app: string, partial: boolean, decideMs: number, actMs: number, at: number): VoiceAction {
  return {
    said,
    label: `app "${app}"`,
    display: `${app} 앱`,
    action: 'click',
    text: null,
    partial,
    decideMs: Math.round(decideMs),
    actMs: Math.round(actMs),
    at: Math.round(at),
    navigated: false,
    app,
  };
}

/** 요소 목록 → E13 화면(틀 없음, 목록 순서 그대로). */
export function screenOf(origin: string, refs: ElementRefs): Screen13 {
  return buildScreen(origin, Object.entries(refs).map(([ref, r]) => ({ ref, role: r.role, name: r.name ?? '' })));
}

/**
 * DeX 가 맨 앞인데 브라우저 탭이 없을 때 — 앱 후보만 있는 화면에서 판단한다(fast-act-computer RoutedVoiceAgent).
 * 탭이 없으면 브라우저 칸 판단기는 아무것도 못 한다(채팅 경로는 아예 서버로 갔다).
 */
export class LauncherVoiceAgent implements VoiceAgent {
  constructor(
    private t0: number,
    /** 실행 기록 — 다른 판단기와 같은 배열에 모은다. */
    readonly actions: VoiceAction[],
    private onAct?: (a: VoiceAction) => void,
  ) {}

  get lastTarget(): string | null {
    return this.actions.at(-1)?.label ?? null;
  }

  private async screen(): Promise<{ c: DesktopCands; refs: ElementRefs; scr: Screen13 }> {
    const c = await desktopCands(null, 9002);
    const web: ElementRefs = Object.keys(c.apps).length ? { [WEB_REF]: { role: 'button', name: WEB_CAND } } : {};
    const refs = { ...web, ...c.head, ...c.tail };
    return { c, refs, scr: screenOf(LAUNCHER_ORIGIN, refs) };
  }

  async boundary(utterance: string, done: string, rest: string[]): Promise<{ start: number; conf: number }> {
    const post = decisionPost();
    if (!post) return { start: -1, conf: 0 };
    const { scr } = await this.screen();
    const criteria: Record<string, string> = {
      none: 'there is no second request — the remaining words only finish the first one',
    };
    rest.forEach((w, i) => (criteria[`w${i}`] = `starts at "${w}"`));
    const a = await post({
      state: decisionState(utterance, LAUNCHER_ORIGIN, scr),
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
    if (!post) return texts.map(() => ({ ready: 'wait', p: 0 }));
    const { scr } = await this.screen();
    return Promise.all(
      texts.map(async (t) => {
        const a = await post({
          state: decisionState(t, LAUNCHER_ORIGIN, scr),
          questions: { ready: { type: 'choice', instructions: READY_Q, criteria: READY_OPTS }, gate_intent: GATE_INTENT_Q },
        }).catch(() => ({}) as Record<string, { choice?: string; probabilities?: Record<string, number> }>);
        return { ready: (a.gate_intent?.probabilities?.act ?? 0) < 0.9 ? 'multi' : (a.ready?.choice ?? 'wait'), p: a.ready?.probabilities?.act_now ?? 0 };
      }),
    );
  }

  async handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean): Promise<Outcome> {
    const t0 = now();
    const no = (reason: string, detail?: unknown): Outcome => ({ acted: false, reason, ms: now() - t0, detail });
    const post = decisionPost();
    if (!post) return no('결정 모델 없음');
    const { c, refs, scr } = await this.screen();
    if (!Object.keys(refs).length) return no('열린 브라우저 탭 없음');
    const cls = await classify(post, text, LAUNCHER_ORIGIN, scr);
    const rc = cls.gate.toFixed(2);
    if (cls.ready === 'not_ui') return no(`화면 조작 아님 ${rc}`);
    if (!((cls.single ?? 0) >= 0.9)) return no(`여러 단계·글쓰기 작업 ${cls.single}`);
    // 발표 조작 이름만 말했다("다음 장") — 고른 것이 발표 조작일 때만 아래에서 실행한다.
    const off = !((cls.onscreen ?? 0) >= 0.5);
    const waiting = (th.partial && cls.ready !== 'act_now') || cls.gate < th.intent;
    const named = (off || waiting) && namedControl(th, cls.ready, c.controls);
    if (off && !named) return no(`화면에 없는 대상 ${cls.onscreen}`);
    if (waiting && !named) return no(`기다림 ${cls.ready} ${rc}`);
    if (abort()) return no('판단 취소(새 인식)');
    const pick = await pickElement(post, text, LAUNCHER_ORIGIN, refs, scr);
    // 다음·이전 장이 1위인데 2위와 갈렸다 — 둘만 놓고 다시 고른다(voice-presentation).
    const slide = pick && (await weakSlidePick(post, text, LAUNCHER_ORIGIN, c.controls, pick, refs).catch(() => null));
    const chosen = slide ?? pick;
    const ctl = chosen && c.controls[chosen.ref];
    if (chosen && ctl && (!named || namedControlOk(text, ctl))) {
      return runPresentation(ctl, { said: text, th, guard, abort, pick: chosen, t0, sessionT0: this.t0, push: (a) => { running = null; this.actions.push(a); this.onAct?.(a); } });
    }
    if (named) return no(`기다림 ${cls.ready} ${rc} (발표 조작 이름 아님)`, pick?.top);
    const cmd = pick && c.commands[pick.ref];
    if (pick && cmd) {
      return runDexCommand(cmd, { said: text, th, guard, abort, pick, t0, sessionT0: this.t0, push: (a) => { this.actions.push(a); this.onAct?.(a); } });
    }
    if (pick?.ref === WEB_REF) return no(`웹 페이지 요청 ${pick.confidence.toFixed(2)}`, pick.top);
    if (!pick || !c.apps[pick.ref] || pick.confidence < CHROME_PICK) return no(`앱 후보 확신 낮음 ${pick?.confidence.toFixed(2)}`, pick?.top);
    return runOpen(
      post,
      text,
      th,
      guard,
      pick,
      refs[pick.ref].name ?? '',
      t0,
      this.t0,
      (a) => {
        this.actions.push(a);
        this.onAct?.(a);
      },
      WEB_CAND,
    );
  }
}

/**
 * 고른 앱 후보를 실행한다 — 판단기 셋(브라우저 칸·다른 앱·탭 없음)이 같이 쓴다. 앱 목록에서 어느 앱인지 다시 고르고 열어
 * 기록한다. 고른 확신·guard 는 다른 화면 밖 조작(브라우저 뒤로·앱 숨기기)과 같은 기준.
 */
export async function runOpen(
  post: DecisionPost,
  text: string,
  th: Thresholds,
  guard: Guard,
  pick: { ref: string; confidence: number; top?: unknown },
  /** 고른 후보의 이름 — guard 가 말과 겹치는지 본다. */
  name: string,
  t0: number,
  sessionT0: number,
  push: (a: VoiceAction) => void,
  /** 앱 목록 고르기에 같이 둘 웹 후보 — 탭 없는 화면(LauncherVoiceAgent)만 넘긴다. */
  web?: string,
): Promise<Outcome> {
  const no = (reason: string): Outcome => ({ acted: false, reason, ms: now() - t0, detail: pick.top });
  if (pick.confidence < CHROME_PICK) return no(`앱 후보 확신 낮음 ${pick.confidence.toFixed(2)}`);
  if (!(await guard(name, 'press', pick.confidence))) return no(GUARDED);
  const decideMs = now() - t0;
  let opened: Awaited<ReturnType<typeof openPickedApp>>;
  try {
    opened = await openPickedApp(post, text, web);
  } catch (err) {
    return no(`앱 열기 안 함 — ${err instanceof Error ? err.message : String(err)}`);
  }
  const a = openedAction(text, opened.app, th.partial, decideMs + opened.pickMs, opened.openMs, now() - sessionT0);
  if (opened.sentence) a.sentence = opened.sentence;
  push(a);
  diag(SCOPE, 'act', { ...a, pick: Number(pick.confidence.toFixed(3)), top: pick.top });
  // 남은 말은 연 앱 화면에서 다시 나눈다(voice-segmenter) — "PPT 열어서 새 프레젠테이션 만들어줘".
  return { acted: true, kind: 'press', target: a.label, ms: now() - t0, effect: 'ok', reread: true };
}
