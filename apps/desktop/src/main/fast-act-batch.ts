/**
 * 칸별 지시 여러 줄을 빠른 조작으로 차례로 실행한다 — 서버 LLM 의 BrowserFill 도구(browser-tools).
 *
 * LLM 이 자료(PDF·엑셀…)를 읽고 "판매가 12900원 입력해줘" 같은 줄을 한 번에 넘기면, 줄마다 채팅 빠른 조작과 같은
 * 판단·실행기(BrowserVoiceAgent, 최종 기준 FINAL)로 처리한다. 줄은 이미 한 칸의 지시라 Segmenter 로 나누지 않는다 —
 * 나누면 "직구상품 여부는 해당없음으로 설정해줘" 의 "설정해줘" 가 따로 BO 화면 설정 버튼을 눌렀다(10/19).
 * 칸당 수 초 — LLM 이 BrowserInteract 로 칸마다 하는 15~50초보다 빠르다. 못 한 줄은 서버로 넘기지 않고 결과에 남긴다 — 부른 LLM 이 자기 도구로 처리한다.
 * 칸은 서로 따로라 못 한 줄이 있어도 다음 줄로 간다.
 *
 * 채울 폼 탭은 LLM 이 page_id 로 밝힌 공유 탭이다 — 공유 탭은 page_id 를 밝혀야만 다룬다(browser-runtime resolvePage).
 * 보이는 탭을 짐작하면 다른 턴·다른 기기의 요청이 사용자가 지금 보는 탭을 바꾼다. 빠른 조작은 보이는 탭에서 일하므로
 * 줄마다 그 탭을 앞으로 꺼낸다 — 줄을 하고 나서 팝업이 남았으면(고르다 만 조회 팝업) 뒤 줄이 팝업 안에서 실행되지 않게
 * (10/19: LLM 이 미리 열어 둔 협력사 팝업에서 "모델명 … 입력해줘" 가 "협력사명 검색어" 칸에 들어감).
 */
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
  pageId: string,
  interactionId: string | undefined,
  steps: string[],
  signal?: AbortSignal,
): Promise<StepResult[]> {
  if (!decisionPost()) throw new Error('빠른 조작(판단 모델)을 쓸 수 없습니다 — BrowserInteract 로 채우세요.');
  const runtime = getBrowserRuntime();
  const start = runtime.get(pageId);
  if (!start || start.workflowId !== workflowId || start.mode !== 'shared')
    throw new Error(`page_id ${pageId} 는 이 대화의 공유 탭이 아닙니다 — BrowserTabs list 에서 폼이 열린 공유 탭(mode shared)의 page_id 를 주세요.`);
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
    const note = acted.length ? replyFor(acted, true) : last.acted ? '했지만 화면이 바뀌지 않음' : last.reason;
    out.push({ step, status: ok ? 'done' : 'failed', note, ms: Math.round(now() - t) });
    diag(SCOPE, 'batch-step', out.at(-1));
  }
  diag(SCOPE, 'batch', { steps: steps.length, done: out.filter((r) => r.status === 'done').length, ms: Math.round(now() - t0) });
  return out;
}
