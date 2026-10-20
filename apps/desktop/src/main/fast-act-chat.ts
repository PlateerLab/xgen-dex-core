/**
 * 채팅으로 시킨 빠른 조작 — chat:start 가 서버 스트림을 열기 전에 부른다.
 *
 * 말로 시킨 것과 **같은 판단·실행기**를 쓴다: Segmenter(최종 기준 FINAL) + BrowserVoiceAgent. 그래서 채팅과 음성이
 * 같은 말에 같은 일을 한다 — 동사 없이 요소 이름만 말한 것("블로그 탭", "xgen 검색"), 검색칸 제출, 가려진 요소
 * (메뉴 펼치기·팝업 닫기), 요소 번호 만료 재시도, 이어 말한 두 요청. 예전 채팅 경로는 따로 만든 단순판이라
 * 이름만 말하면 '단순 조작 아님' 으로 서버에 넘기고, 가려진 요소는 브라우저 오류를 그대로 답으로 냈다.
 *
 * 못 한 말은 서버로 넘긴다(false) — 앞부분을 이미 했으면 요청을 남은 말로 바꿔서. 실행이 실패한 조작도 화면을
 * 바꾸지 않았으므로 서버로 간다. 답은 서버 에이전트처럼 한 일을 문장으로 쓴다(fast-act-reply).
 *
 * 한계 (실험이라 그대로 둔다):
 *   · 로컬 턴은 서버 기록에 남지 않는다 — 대화를 다시 열면 사라지고, 서버 LLM 도 다음 턴에서 이 조작을 모른다.
 *   · 현재 대화 에이전트의 '공유' 브라우저 탭만 본다.
 */
import { stripTeamsContext, turnInputText, type ChatEvent, type ChatRequest } from '@dex/protocol';
import { stripBrowserContext } from '@dex/protocol/browser';
import { stripVoiceContext } from '@dex/protocol/voice-context';
import { diag } from './diag-log';
import { actionRow, replyFor } from './fast-act-reply';
import { askedProbability } from './fast-act';
import { decisionPost, visiblePage } from './fast-act-runner';
import { BrowserVoiceAgent, type VoiceAction } from './fast-act-voice';
import { Segmenter, type Outcome, type VoiceAgent } from './voice-segmenter';
import { takeVoiceTurn } from './voice-turns';

const SCOPE = 'fast-act';
const DRY = process.env.DEX_FAST_ACT_DRY === '1';
const now = (): number => performance.now();
/** 직전 서버 답이 이 확률 이상으로 묻는 답이면 다음 말은 서버로 넘긴다(askedProbability). */
const ASKED_MIN = 0.5;

/** 대화별 직전 서버 답(끝 2,000자) — 바로 다음 말이 그 답에 대한 대답인지 한 번 본다. */
const lastServerReply = new Map<string, string>();

/** 서버 턴이 끝났다 — 그 답을 기억한다(index.ts 가 서버 스트림을 다 받은 뒤 부른다). */
export function rememberServerReply(interactionId: string | undefined, reply: string): void {
  if (interactionId && reply.trim()) lastServerReply.set(interactionId, reply.trim());
}

/** 렌더러가 붙인 봉투(브라우저·Teams 컨텍스트)를 떼고 사용자 원문만 남긴다. */
function userText(req: ChatRequest): string | null {
  if (typeof req.input !== 'string') return null; // 첨부·이미지가 있는 턴은 대상이 아니다
  return stripVoiceContext(stripTeamsContext(stripBrowserContext(turnInputText(req.input)))).trim() || null;
}

let seq = 0;

/**
 * 빠른 조작으로 한 일을 이 턴에 그린다. 남은 말이 없으면 답까지 쓰고 끝내고(true), 있으면 요청을 남은 말로
 * 바꿔 서버로 넘긴다(false) — 이미 한 조작을 서버가 다시 하지 않게 알려 준다. 한 것이 없으면 평소처럼 서버로.
 */
function finishLocal(
  req: ChatRequest,
  text: string,
  actions: VoiceAction[],
  unhandled: string | null,
  emit: (ev: ChatEvent) => void,
  voice: boolean,
): boolean {
  if (actions.length === 0) return false;
  const id = `${voice ? 'voice' : 'fast'}-${Date.now()}-${++seq}`;
  const mid = actions.filter((a) => a.partial).length;
  // 배지는 "이 PC에서 실행 — 빠른 조작" 으로 그려진다(Chat.tsx). 음성이면 말하는 도중이었는지도.
  const when = !voice ? '' : mid === actions.length ? ' · 말하는 도중 처리' : mid ? ` · ${mid}개는 말하는 도중 처리` : ' · 말이 끝나자 처리';
  emit({ kind: 'status', surface: 'connector_local', detail: `빠른 조작${when}` });
  actions.forEach((a, i) => {
    const toolUseId = `${id}-${i}`;
    emit({ kind: 'tool', event: { eventType: 'tool_call', toolName: '빠른 조작', toolInput: { said: a.said }, toolUseId } });
    emit({
      kind: 'tool',
      event: { eventType: 'tool_result', toolName: '빠른 조작', result: actionRow(a, voice), toolUseId, durationMs: a.decideMs + a.actMs },
    });
  });
  if (!unhandled) {
    emit({ kind: 'text', content: replyFor(actions) });
    emit({ kind: 'end' });
    return true;
  }
  // 이미 한 조작은 "지금 화면 상태" 로만 알린다 — "다시 하지 마라" 식 지시를 붙이면 LLM 이 그 말을 답에
  // 옮긴다("앞서 실행했다고 하신 동작은 다시 실행하지 않았습니다").
  const already = actions.map((a) => a.display).join(', ');
  const rest = `${unhandled}\n\n(현재 화면: 방금 빠른 조작으로 ${already} 을(를) 눌러 둔 상태)`;
  if (typeof req.input === 'string' && req.input.includes(text)) req.input = req.input.replace(text, rest);
  else req.input = rest;
  diag(SCOPE, '남은 말 서버로', { unhandled, acted: actions.length, voice });
  return false;
}

/**
 * true = 이 PC 에서 처리했다 (end 까지 보냄). false = 서버로 넘겨라.
 */
export async function tryFastAct(
  req: ChatRequest,
  emit: (ev: ChatEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const text = userText(req);
  if (!decisionPost() || !text || !req.workflowId) return false;
  // 비교용 — '!' 로 시작하면 같은 지시를 기존 서버 경로로 보낸다.
  if (text.startsWith('!')) return false;
  // 말하는 도중 실행한 발화 — 이미 한 조작은 다시 하지 않는다(판단도 최종 기준으로 이미 해 봤다).
  const voice = takeVoiceTurn(req.workflowId, text);
  if (voice) return finishLocal(req, text, voice.actions, voice.unhandled, emit, true);
  if (!visiblePage(req.workflowId)) {
    diag(SCOPE, 'skip: 열린 브라우저 탭 없음');
    return false;
  }
  const t0 = now();
  const inner = new BrowserVoiceAgent(req.workflowId, t0, undefined, req.interactionId);
  // 직전 턴을 서버가 묻는 말로 끝냈다 — 이 말은 그 물음에 대한 대답이라 서버로. 대화 맥락은 서버 LLM 만 안다.
  // 다만 화면의 칸 이름을 직접 부른 말은 그 자체로 알아들을 수 있는 새 지시라 여기서 한다(namesField).
  const reply = lastServerReply.get(req.interactionId);
  lastServerReply.delete(req.interactionId);
  if (reply) {
    const p = await askedProbability(decisionPost()!, reply).catch(() => 0);
    // 칸 이름은 물었을 때만 본다 — 숨은 탭이면 꺼내야 해서.
    const named = p >= ASKED_MIN ? await inner.namesField(text) : null;
    diag(SCOPE, 'reply-check', { text, reply: reply.slice(-80), p: +p.toFixed(3), named });
    if (p >= ASKED_MIN && !named) return false;
  }
  diag(SCOPE, 'start', { text, at: Date.now() }); // 렌더러 전송 → main 도착 지연을 재기 위한 벽시계
  // 사용자가 턴을 멈추면 그 뒤로는 실행하지 않는다.
  const agent: VoiceAgent = {
    get lastTarget() {
      return inner.lastTarget;
    },
    boundary: (utterance, done, rest) => inner.boundary(utterance, done, rest),
    readiness: (texts) => inner.readiness(texts),
    handle: (said, th, guard, abort, utterance) =>
      // DEX_FAST_ACT_DRY=1(개발용) — 판단까지만 하고 실행하지 않는다. 판단 점수를 잴 때 화면·데이터를 바꾸지 않으려고.
      inner.handle(
        said,
        th,
        async (...a) => {
          if (DRY) diag(SCOPE, 'dry-target', { said, target: a[0], kind: a[1], conf: a[2] });
          return !DRY && !signal.aborted && (await guard(...a));
        },
        () => signal.aborted || abort(),
        utterance,
      ),
  };
  const decided: Array<{ text: string; outcome: Outcome }> = [];
  const seg = new Segmenter(agent, (e) => {
    if (e.type === 'decide') decided.push({ text: e.text, outcome: e.outcome });
  });
  await seg.final(text);
  if (DRY) {
    diag(SCOPE, 'dry', { text, decisions: decided.map((d) => `${d.text} → ${d.outcome.acted ? `실행 ${d.outcome.target}` : d.outcome.reason}`) });
    emit({ kind: 'text', content: '(판단만 했어요 — DEX_FAST_ACT_DRY)' });
    emit({ kind: 'end' });
    return true;
  }
  if (signal.aborted && inner.actions.length === 0) return true;
  const ms = Math.round(now() - t0);
  diag(SCOPE, inner.actions.length ? 'done' : 'to server', {
    text,
    ms,
    acted: inner.actions.map((a) => a.label),
    unhandled: seg.unhandled,
    decisions: decided.map((d) => `${d.text} → ${d.outcome.acted ? `실행 ${d.outcome.target}` : d.outcome.reason}`),
  });
  if (inner.actions.length === 0) {
    // 왜 서버로 넘겼는지 — 작업 과정에만 남긴다.
    const last = decided.at(-1)?.outcome;
    const why = last && !last.acted ? last.reason : '할 조작을 찾지 못함';
    const toolUseId = `fast-${Date.now()}-${++seq}`;
    emit({ kind: 'tool', event: { eventType: 'tool_call', toolName: '빠른 조작', toolInput: { instruction: text }, toolUseId } });
    emit({
      kind: 'tool',
      event: { eventType: 'tool_result', toolName: '빠른 조작', result: `서버 에이전트로 넘김 — ${why.slice(0, 120)}`, toolUseId, durationMs: ms },
    });
    return false;
  }
  return finishLocal(req, text, inner.actions, seg.unhandled, emit, false);
}
