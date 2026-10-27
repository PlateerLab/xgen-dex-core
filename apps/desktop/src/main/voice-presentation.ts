import { diag } from './diag-log';
import { classify, pickElement, type ElementRefs } from './fast-act';
import { screenOf } from './fast-act-desktop';
import { decisionPost } from './fast-act-runner';
import type { VoiceAction } from './fast-act-voice';
import { axApps, axPresentation, type AxApp, type PresentationAction } from './mac-ax';
import { CONTINUATION, GUARDED, type Guard, type Outcome, type Thresholds } from './voice-segmenter';

type Control = { app: AxApp; action: PresentationAction; name: string };
const CONFIDENCE = 0.9;
const NONE = 'e9999';

export function presentationControls(apps: AxApp[]): { refs: ElementRefs; controls: Record<string, Control> } {
  const refs: ElementRefs = {};
  const controls: Record<string, Control> = {};
  for (const app of apps.filter(a => a.bundleId.toLowerCase() === 'com.microsoft.powerpoint')) {
    for (const [action, label] of [
      ['next', '다음 장·다음 슬라이드로 넘기기'],
      ['previous', '이전 장·이전 슬라이드로 돌아가기'],
      ['hide', 'PPT·장표·발표 화면 내리기 (쇼 종료 후 앱 숨기기)'],
      ['show', 'PPT·장표·발표 화면 띄우기 (현재 슬라이드부터 쇼 시작)'],
    ] as const) {
      const ref = `e${9001 + Object.keys(controls).length}`;
      const name = `${app.app} ${label}`;
      refs[ref] = { role: 'button', name };
      controls[ref] = { app, action, name };
    }
  }
  refs[NONE] = { role: 'button', name: '다른 작업 — PowerPoint의 다음 장·이전 장·내리기·다시 띄우기 요청이 아님' };
  return { refs, controls };
}

/** One running target and at most one native attempt per utterance, independent of monitor focus. */
export class PresentationVoiceAgent {
  private apps: Promise<AxApp[]> | null = null;
  private attempted = false;

  constructor(private t0: number, private actions: VoiceAction[], private showDex: () => void, private onAct?: (a: VoiceAction) => void) {}

  async handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean): Promise<Outcome | null> {
    const t0 = performance.now();
    const no = (reason: string, stop = false): Outcome => ({ acted: false, reason, ms: performance.now() - t0, ...(stop ? { stop: true } : {}) });
    const post = decisionPost();
    if (!post) return null;
    this.apps ??= axApps().catch(error => { this.apps = null; throw error; });
    const apps = await this.apps;
    const { refs, controls } = presentationControls(apps);
    if (!Object.keys(controls).length) return null;
    const origin = '실행 중인 PowerPoint 발표 화면 (다른 모니터·백그라운드 포함)';
    const scr = screenOf(origin, refs);
    const cls = await classify(post, text, origin, scr);
    if (cls.ready === 'not_ui' || cls.ready === 'multi' || (cls.onscreen ?? 0) < 0.5) {
      if (process.env.DEX_WAKE_DEBUG === '1')
        diag('voice-presentation', 'pass-through', { text: text.slice(0, 300), ready: cls.ready, single: cls.single, onscreen: cls.onscreen });
      return null;
    }
    const pick = await pickElement(post, text, origin, refs, scr);
    if (pick?.ref === NONE && pick.confidence >= CONFIDENCE) {
      return null;
    }
    if (abort()) return no(GUARDED);
    const control = pick && controls[pick.ref];
    // Only the noun-command exception needs an explicit, unambiguous direction.
    const next = text.includes('다음');
    const previous = text.includes('이전');
    const namedStep = !th.partial && cls.ready === 'wait' && !!control &&
      (control.action === 'next' ? next && !previous : control.action === 'previous' && previous && !next);
    const ready = cls.ready === 'act_now' && cls.gate >= CONFIDENCE && (cls.single ?? 0) >= CONFIDENCE;
    const targetKnown = !!control && !!pick && pick.confidence >= CONFIDENCE && (cls.onscreen ?? 0) >= CONFIDENCE;
    const accepted = targetKnown && (ready || namedStep);
    if (process.env.DEX_WAKE_DEBUG === '1') {
      diag('voice-presentation', 'decision', {
        text: text.slice(0, 300), partial: th.partial, ready: cls.ready,
        act: cls.gate, single: cls.single, onscreen: cls.onscreen,
        pick: pick?.confidence, ref: pick?.ref, action: control?.action, pid: control?.app.pid,
        namedStep, accepted,
        reason: accepted ? 'accepted' : !control ? 'no_control' : !targetKnown ? 'target_confidence' : 'readiness',
      });
    }
    if (!control || !pick || !accepted) {
      if (!targetKnown) return null;
      return no(th.partial ? '기다림 — 발표 명령 확정 전' : '발표 조작의 대상과 동작을 확실히 고르지 못했어요.', !th.partial);
    }
    // Partial STT can revise "next" into "previous". Presentation actions wait for final speech.
    if (th.partial) return no('기다림 — 발표 명령은 말이 끝난 뒤 실행');
    if (this.attempted) return no(CONTINUATION);
    if ((control.action === 'next' || control.action === 'previous') && (control.app.hidden || !control.app.presenting)) {
      return no('발표 화면이 보이지 않아요. PowerPoint 발표 화면을 먼저 띄워 주세요.', true);
    }
    if (!(await guard(control.name, 'press', pick.confidence)) || abort()) return no(GUARDED);
    if (this.attempted) return no(CONTINUATION);
    this.attempted = true;
    diag('voice-presentation', 'attempt', { text, pid: control.app.pid, action: control.action, app: control.app.app, pick: pick.confidence });
    const actStarted = performance.now();
    try {
      const result = await axPresentation(control.app.pid, control.action);
      diag('voice-presentation', 'native-result', { pid: control.app.pid, action: control.action, ...result });
      if (!result.verified) return no(result.reason || '발표 화면의 변경을 확인하지 못했어요. 같은 명령을 자동으로 반복하지 않습니다.', true);
      if (control.action === 'hide') this.showDex();
      const sentences = {
        next: '다음 장으로 넘겼어요.', previous: '이전 장으로 돌아갔어요.',
        hide: '슬라이드 쇼를 종료하고 PowerPoint를 내렸어요.', show: 'PowerPoint 발표 화면을 띄웠어요.',
      };
      const action: VoiceAction = {
        said: text, label: control.name, display: control.name, action: 'click', text: null, partial: false,
        decideMs: Math.round(actStarted - t0), actMs: Math.round(performance.now() - actStarted),
        at: Math.round(performance.now() - this.t0), navigated: false, app: control.app.app,
        sentence: sentences[control.action],
      };
      this.actions.push(action);
      this.onAct?.(action);
      diag('voice-presentation', 'verified', { ...action, pid: control.app.pid, operation: control.action });
      return { acted: true, kind: 'press', target: action.label, effect: 'ok', ms: performance.now() - t0 };
    } catch (error) {
      const reason = `발표 조작을 중단했어요: ${error instanceof Error ? error.message : String(error)}`;
      diag('voice-presentation', 'failed', { pid: control.app.pid, action: control.action, reason });
      return no(reason, true);
    }
  }
}
