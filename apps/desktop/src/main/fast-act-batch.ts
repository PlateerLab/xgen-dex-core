/**
 * 칸별 지시 여러 줄을 빠른 조작으로 차례로 실행한다 — 서버 LLM 의 BrowserFill 도구(browser-tools).
 *
 * LLM 이 자료(PDF·엑셀…)를 읽고 "판매가 12900원 입력해줘" 같은 줄을 한 번에 넘기면, 줄마다 채팅 빠른 조작과 같은
 * 판단·실행기(BrowserVoiceAgent, 최종 기준 FINAL)로 처리한다. 줄은 이미 한 칸의 지시라 Segmenter 로 나누지 않는다 —
 * 나누면 "직구상품 여부는 해당없음으로 설정해줘" 의 "설정해줘" 가 따로 BO 화면 설정 버튼을 눌렀다(10/19).
 * 칸당 수 초 — LLM 이 BrowserInteract 로 칸마다 하는 15~50초보다 빠르다. 못 한 줄은 서버로 넘기지 않고 결과에 남긴다 — 부른 LLM 이 자기 도구로 처리한다.
 * 칸은 서로 따로라 못 한 줄이 있어도 다음 줄로 간다.
 *
 * 줄은 팝업 창이 아니라 그 창을 연 폼에서 판단해야 한다. 앞 탭이 팝업(window.opener 가 있는 창)이면 연 쪽 탭을 앞으로
 * 꺼내고 시작하고, 줄을 하고 나서 팝업이 남았으면(고르다 만 조회 팝업) 다시 폼 탭을 꺼낸다 — 안 그러면 뒤 줄이 팝업
 * 안에서 실행된다(10/19: LLM 이 미리 열어 둔 협력사 팝업에서 "모델명 … 입력해줘" 가 "협력사명 검색어" 칸에 들어감).
 */
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { getBrowserRuntime } from './browser-runtime';
import { diag } from './diag-log';
import { replyFor } from './fast-act-reply';
import { decisionPost, visiblePage } from './fast-act-runner';
import { BrowserVoiceAgent } from './fast-act-voice';
import { FINAL } from './voice-segmenter';

const SCOPE = 'fast-act';
const now = (): number => performance.now();

export type StepResult = {
  step: string;
  status: 'done' | 'failed' | 'skipped';
  /** 한 일(done) 또는 못 한 까닭(failed·skipped). */
  note: string;
  ms: number;
};

export async function runSteps(
  workflowId: string,
  interactionId: string | undefined,
  steps: string[],
  signal?: AbortSignal,
): Promise<StepResult[]> {
  if (!decisionPost()) throw new Error('빠른 조작(판단 모델)을 쓸 수 없습니다 — BrowserInteract 로 채우세요.');
  const start = await formPage(workflowId);
  if (!start) throw new Error('열린(공유) 브라우저 탭이 없습니다.');
  const runtime = getBrowserRuntime();
  const t0 = now();
  // 한 에이전트로 — 읽어 둔 화면을 다음 줄이 이어 쓴다.
  const agent = new BrowserVoiceAgent(workflowId, t0, undefined, interactionId);
  const out: StepResult[] = [];
  for (const step of steps) {
    if (signal?.aborted) {
      out.push({ step, status: 'skipped', note: '중단됨', ms: 0 });
      continue;
    }
    if (visiblePage(workflowId)?.pageId !== start.pageId) {
      if (!runtime.get(start.pageId)) throw new Error('폼 탭이 닫혔습니다.');
      runtime.activate(start.pageId);
    }
    const t = now();
    const before = agent.actions.length;
    const last = await agent.handle(step, FINAL, async () => !signal?.aborted, () => !!signal?.aborted).catch(
      (err: Error) => ({ acted: false as const, reason: err.message, ms: 0 }),
    );
    const acted = agent.actions.slice(before);
    const ok = last.acted && last.effect !== 'none';
    const note = acted.length ? replyFor(acted) : last.acted ? '했지만 화면이 바뀌지 않음' : last.reason;
    out.push({ step, status: ok ? 'done' : 'failed', note, ms: Math.round(now() - t) });
    diag(SCOPE, 'batch-step', out.at(-1));
  }
  diag(SCOPE, 'batch', { steps: steps.length, done: out.filter((r) => r.status === 'done').length, ms: Math.round(now() - t0) });
  return out;
}

/** 줄을 실행할 폼 탭 — 앞 탭이 팝업이면 팝업이 아닌 공유 탭(연 쪽)을 앞으로 꺼낸다. */
async function formPage(workflowId: string): Promise<BrowserPageInfo | null> {
  const runtime = getBrowserRuntime();
  const front = visiblePage(workflowId);
  const popup = (p: BrowserPageInfo): Promise<boolean> =>
    runtime.pageScript<boolean>(workflowId, p.pageId, '!!window.opener', 2_000).catch(() => false);
  if (!front || !(await popup(front))) return front;
  for (const p of runtime.state().pages) {
    if (p.workflowId !== workflowId || p.mode !== 'shared' || p.pageId === front.pageId || (await popup(p))) continue;
    diag(SCOPE, 'batch-form-page', { from: front.url, to: p.url });
    return runtime.activate(p.pageId);
  }
  return front;
}
