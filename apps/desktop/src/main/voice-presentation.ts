/**
 * 발표(PowerPoint 슬라이드 쇼) 조작 — 다음·이전 장, 쇼 끝내고 내리기. 발표 중인 PowerPoint 가 있을 때만 화면 후보
 * (fast-act-desktop desktopCands)에 붙어 판단기 셋(브라우저 칸·다른 앱·탭 없음)이 페이지·앱 후보와 같이 고른다. 발표 화면이
 * 다른 모니터에 있고 DeX 가 맨 앞이어도 된다. 실행은 PID 를 정해 도우미의 presentation 명령으로 — 쇼 창에 초점을 맞춘 뒤 키를
 * 보내고, 내리기는 쇼 종료를 확인한 뒤 앱을 숨긴다(발표자 보기를 쓰는 두 화면에서는 쇼를 둔 채 숨기면 청중 화면이 남았다, #250).
 *
 * 측정(10/27 dev 판단 모델 e13-s7 — 네이버 화면·DeX 앞 화면·PPT 쇼 화면):
 *   · 발표 후보만 따로 묻기(후보 넷 + "다른 작업")는 다른 요청을 발표 조작으로 실행했다 — "크롬 열어줘" → 내리기 0.967,
 *     "뒤로 가줘" → 이전 장 1.000. 판단 모델은 "해당 없음" 을 고르지 못한다. 화면 후보에 섞으면 앱·탭·페이지 요청은 제자리로 간다.
 *   · 이름: "슬라이드 쇼 끝내고 … 내리기" 로 내리기류 5문장이 0.48~0.94 → 1.00. "다음 슬라이드·다음 장 (… 슬라이드 쇼)" 가
 *     "슬라이드 쇼 다음 장" 보다 페이지의 "다음 …" 요소에 덜 졌다(네이버 다음 계열 7문장 중 5 → 2 패배).
 *   · 그래도 페이지 요소가 이기면 발표 조작과 그 요소만 놓고 다시 고른다(presentationRepick) — 페이지 요청 13문장은 모두 그대로,
 *     "PPT 다음 장."·"다음 슬라이드"·"앞 장 다시 보여줘" 는 발표 조작으로. 맨 "다음 장" 이 "다음 콘텐츠 보기" 와 맞서면 페이지가
 *     이긴다(0.67) — DeX 화면을 보고 하는 말일 수 있어 그대로 둔다.
 *   · 이전 장 이름이 "이전 슬라이드·이전 장" 이면 "앞 장 다시 보여줘"·"앞 장으로 가줘"·"앞 슬라이드 보여줘" 가 다음 장(DeX 앞 화면),
 *     "XGen Dex 앞으로 가져오기" 0.99(PPT 쇼 앞)로 갔다 — "앞" 을 앞으로로 읽는다. "앞 장·이전 슬라이드" 로 세 화면(쇼·발표자 보기·
 *     DeX 앞) 모두 이전 장, 앱·DeX·내리기·서버 요청은 그대로(10/27 판단만 측정, 화면마다 24~25문장). "이전 장" 까지 넣으면
 *     발표자 보기에서 "이전 장으로 돌아가줘" 가 서버로 갔다. "방금 장 다시 보여줘" 는 발표자 보기에서 아직 다음 장(0.91).
 */
import { diag } from './diag-log';
import { pickElement, type DecisionPost, type ElementRefs, type Pick } from './fast-act';
import { buildScreen } from './fast-act-e13';
import type { VoiceAction } from './fast-act-voice';
import { axFront, axPresentation, type AxApp, type PresentationAction } from './mac-ax';
import { GUARDED, mentions, type Guard, type Outcome, type Thresholds } from './voice-segmenter';

/** 발표 앱 — 번들 → 후보에 쓰는 이름. 쇼 창 판별·키는 도우미(dex-ax presentation)가 이 앱 기준으로 한다. */
const PRESENTERS: Record<string, string> = { 'com.microsoft.powerpoint': 'PowerPoint' };
const CONTROL_PICK = 0.9;
/**
 * 내리기는 쇼를 끝낸다 — 더 높은 확신에서만. DeX 앞 화면에서 "유튜브 열어줘" 가 내리기 0.920 이었다(내리기 말 15개는
 * 0.986 이상, 10/27).
 */
const HIDE_PICK = 0.97;
/** 다음·이전 장이 1위인데 확신이 모자랄 때 다시 고르는 조건 — 1·2위가 확률을 이만큼 나눠 가졌을 때만(둘이 갈렸다). */
const SPLIT = 0.9;
/** 내린 뒤 DeX 가 맨 앞에 왔는지 보는 시간 — 맨 앞 앱을 숨기면 macOS 가 뒤의 앱을 비동기로 올린다(10/18 iTerm2). */
const FRONT_CHECK_MS = 800;

export type PresentationControl = { app: AxApp; action: Exclude<PresentationAction, 'show'>; name: string };
type RepickResult = { ref: string; confidence: number; top: Array<[string, number]> } | null;

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let showDex: () => void = () => undefined;

/** DeX 를 앞으로 가져오는 함수 — fast-act-computer configureComputerAct 가 넘긴다. */
export function configurePresentation(fn: () => void): void {
  showDex = fn;
}

/** 이 도우미로 쇼를 끝내고 내린 앱 — "다시 띄우기" 를 고르면 앱만 보이지 않고 현재 슬라이드부터 쇼를 다시 시작한다. */
const ended = new Set<number>();

export function endedShow(pid: number | undefined): boolean {
  return pid !== undefined && ended.has(pid);
}

/** 발표 중인 앱마다 다음·이전·내리기 — 번호는 start 부터(화면 맨 위 후보 자리). */
export function presentationControls(apps: AxApp[], start: number): { refs: ElementRefs; controls: Record<string, PresentationControl> } {
  const refs: ElementRefs = {};
  const controls: Record<string, PresentationControl> = {};
  for (const app of apps) {
    const name = PRESENTERS[app.bundleId.toLowerCase()];
    if (!name || !app.presenting || app.hidden) continue;
    for (const [action, label] of [
      ['next', `다음 슬라이드·다음 장 (${name} 슬라이드 쇼)`],
      ['previous', `앞 장·이전 슬라이드 (${name} 슬라이드 쇼)`],
      ['hide', `슬라이드 쇼 끝내고 ${name} 내리기 (발표 화면 내리기)`],
    ] as const) {
      const ref = `e${start + Object.keys(controls).length}`;
      refs[ref] = { role: 'button', name: label };
      controls[ref] = { app, action, name: label };
    }
  }
  for (const pid of ended) if (!apps.some((a) => a.pid === pid)) ended.delete(pid);
  return { refs, controls };
}

/**
 * 말이 끝났는데 발표 조작 이름만 말했다("다음 장", "다음 슬라이드") — 판단 모델은 기다림·화면 밖(onscreen 0.16~0.32)으로
 * 답한다. 발표 중이면 고른 것이 발표 조작이고 말이 그 이름을 가리킬 때만 실행한다(namedControlOk).
 */
export function namedControl(th: Thresholds, ready: string | undefined, controls: Record<string, PresentationControl>): boolean {
  return !th.partial && ready === 'wait' && Object.keys(controls).length > 0;
}

export function namedControlOk(text: string, c: PresentationControl): boolean {
  return mentions(text, c.name);
}

/** 발표 중에 화면 요소가 이겼다 — 발표 조작과 그 요소만 놓고 다시 고른다. 발표 조작이 확신 있게 이기면 그 고르기. */
export async function presentationRepick(
  post: DecisionPost,
  said: string,
  origin: string,
  controls: Record<string, PresentationControl>,
  ref: string,
  element: { role: string; name?: string },
): Promise<RepickResult> {
  if (!Object.keys(controls).length) return null;
  return repickAgainst(post, said, origin, controls, ref, element);
}

/**
 * 다음·이전 장이 1위인데 확신이 모자라고 2위와 확률을 나눠 가졌다 — 다음·이전 장과 그 2위만 놓고 다시 고른다. 발표자 보기에서
 * "이전 장으로 돌아가줘" 가 이전 장 0.57 · "HOP 앱 실행" 0.42 로 갈려 서버로 갔고, 서버는 브라우저 뒤로 가기를 했다(10/27).
 * 쇼를 끝내는 내리기는 되돌리기 어려워 이렇게 올리지 않는다(다시 고르는 후보에서도 뺀다). 다시 볼 일이 아니면 묻지 않고 null.
 */
export async function weakSlidePick(
  post: DecisionPost,
  said: string,
  origin: string,
  controls: Record<string, PresentationControl>,
  pick: Pick,
  refs: ElementRefs,
): Promise<RepickResult> {
  const ctl = controls[pick.ref];
  if (!ctl || ctl.action === 'hide' || pick.confidence >= CONTROL_PICK) return null;
  const rival = pick.top.find(([label]) => !controls[label.split(' ')[0]]);
  const ref = rival?.[0].split(' ')[0];
  if (!rival || !ref || !refs[ref] || pick.confidence + rival[1] < SPLIT) return null;
  const slides = Object.fromEntries(Object.entries(controls).filter(([, c]) => c.action !== 'hide'));
  return repickAgainst(post, said, origin, slides, ref, refs[ref]);
}

async function repickAgainst(
  post: DecisionPost,
  said: string,
  origin: string,
  controls: Record<string, PresentationControl>,
  ref: string,
  element: { role: string; name?: string },
): Promise<RepickResult> {
  const refs: ElementRefs = {
    ...Object.fromEntries(Object.entries(controls).map(([r, c]) => [r, { role: 'button', name: c.name }])),
    [ref]: { role: element.role, name: element.name ?? '' },
  };
  const scr = buildScreen(origin, Object.entries(refs).map(([r, v]) => ({ ref: r, role: v.role, name: v.name ?? '' })));
  const p = await pickElement(post, said, origin, refs, scr);
  diag('voice-presentation', 'repick', { said, element: element.name, pick: p && refs[p.ref]?.name, conf: p && Number(p.confidence.toFixed(3)) });
  return p && controls[p.ref] && p.confidence >= CONTROL_PICK ? p : null;
}

/** DeX 를 앞으로 — 숨긴 앱 뒤의 앱이 늦게 올라와 DeX 를 덮었으면 한 번 더. */
export async function dexToFront(show: () => void = showDex): Promise<void> {
  show();
  for (const t = now(); now() - t < FRONT_CHECK_MS; await sleep(100)) {
    const f = await axFront().catch(() => null);
    if (f?.pid === process.pid) return;
  }
  show();
}

const SENTENCE: Record<PresentationControl['action'], [string, string]> = {
  // [확인됨, 키만 보냄(장 번호를 읽지 못했거나 그대로 — 애니메이션·마지막 장)]
  next: ['다음 장으로 넘겼어요.', '다음 장 키를 보냈어요.'],
  previous: ['이전 장으로 돌아갔어요.', '이전 장 키를 보냈어요.'],
  hide: ['슬라이드 쇼를 끝내고 PowerPoint 를 내렸어요.', ''],
};

export type PresentationRun = {
  said: string;
  th: Thresholds;
  guard: Guard;
  abort: () => boolean;
  pick: { confidence: number; top?: unknown };
  /** 판단 시작 시각(now) — 판단·실행 시간을 나눈다. */
  t0: number;
  /** 음성 세션 시작 시각 — 기록의 at. */
  sessionT0: number;
  push: (a: VoiceAction) => void;
};

/**
 * 고른 발표 조작을 실행한다. 말이 끝난 뒤에만(중간 인식은 "다음" 이 "이전" 으로 바뀔 수 있다). 키를 보내기 전에 멈췄으면
 * 못 한 것으로 돌려 서버로 넘기고, 보낸 뒤 확인하지 못했거나 결과를 모르면 stop — 서버가 같은 조작을 다시 해 두 장을 넘기거나
 * 쇼를 다시 열지 않게 한다.
 */
export async function runPresentation(c: PresentationControl, r: PresentationRun): Promise<Outcome> {
  const no = (reason: string, stop = false): Outcome => ({ acted: false, reason, ms: now() - r.t0, detail: r.pick.top, ...(stop ? { stop: true } : {}) });
  if (r.th.partial) return no('기다림 — 발표 조작은 말이 끝난 뒤');
  const min = c.action === 'hide' ? HIDE_PICK : CONTROL_PICK;
  if (r.pick.confidence < min) return no(`발표 조작 확신 낮음 ${r.pick.confidence.toFixed(2)}`);
  if (!(await r.guard(c.name, 'press', r.pick.confidence)) || r.abort()) return no(GUARDED);
  const decideMs = now() - r.t0;
  const tAct = now();
  let res: Awaited<ReturnType<typeof axPresentation>>;
  try {
    res = await axPresentation(c.app.pid, c.action);
  } catch (err) {
    // 도우미가 답하지 않았다 — 키가 갔는지 모른다.
    const reason = `발표 조작 결과를 확인하지 못했어요: ${err instanceof Error ? err.message : String(err)}`;
    diag('voice-presentation', 'failed', { pid: c.app.pid, action: c.action, reason });
    return no(reason, true);
  }
  diag('voice-presentation', 'native-result', { pid: c.app.pid, action: c.action, ...res });
  const slide = c.action !== 'hide';
  if (!res.sent) return no(res.reason || '발표 화면에 키를 보내지 않았어요.');
  if (!res.verified && !slide) return no(res.reason || '발표 화면을 내렸는지 확인하지 못했어요.', true);
  if (c.action === 'hide') {
    ended.add(c.app.pid);
    await dexToFront();
  }
  const a: VoiceAction = {
    said: r.said,
    label: c.name,
    display: c.name,
    action: 'click',
    text: null,
    partial: false,
    decideMs: Math.round(decideMs),
    actMs: Math.round(now() - tAct),
    at: Math.round(now() - r.sessionT0),
    navigated: false,
    // app 은 넣지 않는다 — 앱을 연 기록으로 읽혀 "… 를 열었어요." 로 답했다(10/27 실측).
    sentence: SENTENCE[c.action][res.verified ? 0 : 1],
  };
  r.push(a);
  diag('voice-presentation', 'act', { ...a, app: c.app.app, pid: c.app.pid, operation: c.action, verified: res.verified, pick: Number(r.pick.confidence.toFixed(3)) });
  // 내리면 맨 앞이 DeX 로 바뀐다 — 남은 말은 새 화면에서 다시 나눈다.
  return { acted: true, kind: 'press', target: a.label, ms: now() - r.t0, effect: 'ok', ...(c.action === 'hide' ? { reread: true } : {}) };
}

/** 쇼를 끝내고 내린 앱을 다시 띄운다 — 현재 슬라이드부터 쇼(⌘↩). 확인하지 못하면 throw(앱 열기와 같이 서버로). */
export async function restartShow(pid: number): Promise<void> {
  const res = await axPresentation(pid, 'show');
  diag('voice-presentation', 'native-result', { pid, action: 'show', ...res });
  if (!res.verified) throw new Error(res.reason || '쇼를 다시 시작하지 못함');
  ended.delete(pid);
}
