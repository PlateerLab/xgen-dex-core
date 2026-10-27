/**
 * 빠른 조작의 DeX 자체 명령 — "새 에이전트 만들어 줘" 를 서버 에이전트로 보내지 않고 DeX 화면에서 바로 한다(시작 화면 열기).
 *
 * 앱·발표 조작처럼 화면 후보로 붙여 페이지 요소·앱과 같은 질문으로 고른다(fast-act-desktop desktopCands). DeX 가 맨 앞일
 * 때만 붙는다(탭 없는 화면·브라우저 칸). 다른 앱이 맨 앞이면 그 앱 화면에서 고른다.
 *
 * 판단 모델은 "해당 없음" 을 고르지 못한다 — 후보가 하나뿐이면 "에이전트 이름 바꿔 줘"·"에이전트 목록 보여 줘"·"대화 기록
 * 지워 줘" 도 0.99~1.00 으로 가져갔다(10/28 dev 판단 모델, 탭 없는 화면). 그래서 명령마다 그 명령의 뜻을 이루는 낱말(cue —
 * 새 채팅이면 '새')을 두고, 말에 없으면 골라도 실행하지 않는다. 같은 측정에서 새 에이전트·새 채팅·새 대화를 여는 말 6개는
 * 모두 1.00, 긴 지시·"에이전트로 정리해 줘"·"방금 만든 에이전트 배포해 줘" 는 서버로 갔다(실행 준비·한 단계 판단).
 *
 * 실행은 렌더러가 한다(Workspace — 사이드바 [새 채팅] 과 같은 동작). 켜 둔 계속 듣기는 열린 시작 화면이 이어 듣는다.
 */
import { diag } from './diag-log';
import type { ElementRefs } from './fast-act';
import type { VoiceAction } from './fast-act-voice';
import { GUARDED, type Guard, type Outcome, type Thresholds } from './voice-segmenter';

const SCOPE = 'fast-act-dex';
/** 고른 확신 기준 — 발표 조작(CONTROL_PICK)과 같다. 측정에서 맞는 말은 모두 1.00 이었다. */
const DEX_PICK = 0.9;
const now = (): number => performance.now();

export type DexCommandId = 'new-chat';

export type DexCommand = {
  id: DexCommandId;
  /** 화면 후보 이름. */
  name: string;
  /** 말에 이것이 없으면 골라도 실행하지 않는다. */
  cue: RegExp;
  /** 실행 뒤 답 문장. */
  sentence: string;
};

export const DEX_COMMANDS: readonly DexCommand[] = [
  {
    id: 'new-chat',
    name: '새 채팅 — 새 에이전트로 시작 (XGen Dex 시작 화면)',
    cue: /새|new|신규/i,
    sentence: '새 채팅을 열었어요. 무엇을 맡길지 말씀해 주세요.',
  },
];

/** 렌더러에 명령을 보낸다 — 창이 없으면 false. */
let send: (id: DexCommandId) => boolean = () => false;

export function configureDexCommands(fn: (id: DexCommandId) => boolean): void {
  send = fn;
}

/** 화면 맨 위에 붙일 DeX 명령 후보 — start = 첫 번호. */
export function dexCommandRefs(start: number): { refs: ElementRefs; commands: Record<string, DexCommand> } {
  const refs: ElementRefs = {};
  const commands: Record<string, DexCommand> = {};
  DEX_COMMANDS.forEach((c, i) => {
    const ref = `e${start + i}`;
    refs[ref] = { role: 'button', name: c.name };
    commands[ref] = c;
  });
  return { refs, commands };
}

export type DexCommandRun = {
  said: string;
  th: Thresholds;
  guard: Guard;
  abort: () => boolean;
  pick: { ref: string; confidence: number; top?: unknown };
  t0: number;
  sessionT0: number;
  push: (a: VoiceAction) => void;
};

/** 고른 DeX 명령을 실행한다. 말이 끝난 뒤에만 — 화면이 바뀌면 지금 대화 화면의 듣기가 끝난다. */
export async function runDexCommand(c: DexCommand, r: DexCommandRun): Promise<Outcome> {
  const no = (reason: string): Outcome => ({ acted: false, reason, ms: now() - r.t0, detail: r.pick.top });
  if (r.th.partial) return no('기다림 — DeX 명령은 말이 끝난 뒤');
  if (!c.cue.test(r.said)) return no(`DeX 명령 낱말 없음 (${c.id})`);
  if (r.pick.confidence < DEX_PICK) return no(`DeX 명령 확신 낮음 ${r.pick.confidence.toFixed(2)}`);
  if (!(await r.guard(c.name, 'press', r.pick.confidence)) || r.abort()) return no(GUARDED);
  const decideMs = now() - r.t0;
  const tAct = now();
  if (!send(c.id)) return no('DeX 창 없음');
  const a: VoiceAction = {
    said: r.said,
    label: c.name,
    display: c.name.split(' (')[0],
    action: 'click',
    text: null,
    partial: false,
    decideMs: Math.round(decideMs),
    actMs: Math.round(now() - tAct),
    at: Math.round(now() - r.sessionT0),
    navigated: false,
    sentence: c.sentence,
  };
  r.push(a);
  diag(SCOPE, 'act', { ...a, command: c.id, pick: Number(r.pick.confidence.toFixed(3)) });
  return { acted: true, kind: 'press', target: a.label, ms: now() - r.t0, effect: 'ok' };
}
