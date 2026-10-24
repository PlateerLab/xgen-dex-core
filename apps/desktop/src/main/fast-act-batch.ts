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
 *
 * 이미 그 값인 칸의 줄은 판단 모델을 부르지 않고 그대로 둔다(heldValue) — 줄마다 수 초라, 박소민 시연 프롬프트가
 * "이미 원하는 값인 칸은 다시 입력하지 말 것" 을 따로 적어 두었다(10/24).
 *
 * 사이트 확인창("…하시겠습니까?" 확인·취소)이 떠 있으면 남은 줄을 멈춘다 — 줄의 판단 모델은 그 창의 확인을 묻지 않고 누를 수
 * 있다. 누를지는 BrowserInteract 가 사용자에게 묻는다(browser-confirm).
 */
import { getBrowserRuntime } from './browser-runtime';
import { diag } from './diag-log';
import { replyFor } from './fast-act-reply';
import { decisionPost, visiblePage } from './fast-act-runner';
import { BrowserVoiceAgent } from './fast-act-voice';
import { FINAL } from './voice-segmenter';
import { FORM_VALUES_SCRIPT, isFieldVerification } from './fast-act-labels';
import { saidField } from './fast-act';
import { CONFIRM_DIALOG_SCRIPT, isPageDialog } from './browser-confirm';

const SCOPE = 'fast-act';
const now = (): number => performance.now();
export const MAX_FILL_STEPS = 50;

export type StepResult = {
  step: string;
  status: 'done' | 'failed' | 'skipped';
  /** 한 일(done) 또는 못 한 까닭(failed·skipped). */
  note: string;
  ms: number;
  read_only?: boolean;
  /** 줄이 처음 다룬 칸(고른 요소의 표기). */
  target?: string;
  /** 넣은 값 — 누르기만 한 줄은 없다. */
  requested?: string;
  /** 실행 뒤 읽은 값·선택 상태(null = 읽지 못함). */
  observed?: string | null;
  /** 줄 실행 중 화면에 뜬 알림 문구. */
  notices?: string[];
  /** 칸이 이미 그 값이라 손대지 않았다. */
  unchanged?: boolean;
};

/** 성공한 줄에 싣는 값의 길이 상한 — 상품상세 같은 긴 글은 앞부분만. */
const BRIEF_VALUE = 40;

/**
 * LLM 에 돌려줄 줄별 결과 — 성공한 줄은 번호(i)·다룬 칸·짧은 값만, 못 한 줄은 지시·까닭·요청값·관측값을 모두 남긴다.
 * 결과는 대화 기록에 쌓여 LLM 호출마다 다시 들어간다(10/23 demo-test-21: BrowserFill 11회가 도구 결과의 62%).
 * 화면 알림은 성공한 줄에도 남긴다 — 다음 칸 입력에 영향을 줄 수 있다.
 */
export function briefResults(results: StepResult[]): Record<string, unknown>[] {
  return results.map((r, k) => {
    if (r.status === 'done') {
      // 칸에서 읽은 값(없으면 넣은 값)을 짧게 — 값이 없으면 LLM 이 앞선 실패 줄의 관측값을 최종 상태로 읽었다(10/23 demo-test-23).
      const seen = r.observed ?? r.requested;
      const value = seen == null ? undefined : seen.length > BRIEF_VALUE ? seen.slice(0, BRIEF_VALUE) + '…' : seen;
      return {
        i: k + 1,
        status: r.status,
        ...(r.target ? { target: r.target } : { step: r.step }),
        ...(value !== undefined ? { value } : {}),
        ...(r.unchanged ? { unchanged: true } : {}),
        ...(r.notices ? { notices: r.notices } : {}),
      };
    }
    const { ms: _ms, ...rest } = r;
    return { i: k + 1, ...rest };
  });
}

const SEARCH_WORD = /(검색|조회|찾아|search|find|look up)/i;
const bare = (s: string): string => s.replace(/\s+/g, '');

/** 「」 값과 칸 이름을 밝힌 줄의 칸 이름·값 — "판매가에 「12900」 입력해줘". 검색하라는 줄은 값이 같아도 할 일이 남아 뺀다. */
function heldTarget(step: string): { said: string; wanted: string } | null {
  const quotes = [...step.matchAll(/「([^」]*)」/g)];
  if (quotes.length !== 1 || !quotes[0][1].trim() || SEARCH_WORD.test(step.replace(quotes[0][0], ''))) return null;
  const said = saidField(step);
  return said ? { said, wanted: quotes[0][1] } : null;
}

/** 띄어쓰기 차이와 숫자의 쉼표("12,900")만 같은 값으로 본다. */
function sameValue(current: string, wanted: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (squash(current) === squash(wanted)) return true;
  const number = (s: string) => s.replace(/,/g, '').trim();
  const numeric = (s: string) => /^-?\d+(?:\.\d+)?$/.test(number(s));
  return numeric(current) && numeric(wanted) && Number(number(current)) === Number(number(wanted));
}

/**
 * 줄이 부른 칸이 이미 「」 값인가 — FORM_VALUES_SCRIPT 결과에서 칸 이름이 같은 칸(없으면 이름을 품거나 품기는 칸)이 하나뿐이고
 * 값이 같을 때만. 둘 이상이면(체크박스 무리, "구매제한" 과 "최대 구매제한 수량") 판단 모델에 맡긴다 — 틀리게 건너뛰면 칸이 비는데
 * 실행하면 같은 값을 다시 넣을 뿐이다.
 */
export function heldValue(step: string, fields: unknown): { field: string; value: string } | null {
  const target = heldTarget(step);
  if (!target || !Array.isArray(fields)) return null;
  const named = fields.filter((f): f is { field: string; value?: unknown } => typeof f?.field === 'string' && bare(f.field).length >= 2);
  const exact = named.filter((f) => bare(f.field) === target.said);
  const near = exact.length ? exact : named.filter((f) => bare(f.field).includes(target.said) || target.said.includes(bare(f.field)));
  if (near.length !== 1) return null;
  const value = String(near[0].value ?? '');
  return sameValue(value, target.wanted) ? { field: near[0].field, value } : null;
}

export async function runSteps(
  workflowId: string,
  pageId: string,
  interactionId: string | undefined,
  steps: string[],
  signal?: AbortSignal,
  deadlineAt = Date.now() + 112_000,
): Promise<StepResult[]> {
  if (steps.length > MAX_FILL_STEPS) throw new Error(`BrowserFill 은 한 번에 ${MAX_FILL_STEPS}줄까지 실행할 수 있습니다.`);
  if (!decisionPost()) throw new Error('빠른 조작(판단 모델)을 쓸 수 없습니다 — BrowserInteract 로 채우세요.');
  const runtime = getBrowserRuntime();
  const start = runtime.get(pageId);
  if (!start || start.workflowId !== workflowId || start.mode !== 'shared')
    throw new Error(`page_id ${pageId} 는 이 대화의 공유 탭이 아닙니다 — BrowserTabs list 에서 폼이 열린 공유 탭(mode shared)의 page_id 를 주세요.`);
  const t0 = now();
  // 한 에이전트로 — 읽어 둔 화면을 다음 줄이 이어 쓴다.
  const agent = new BrowserVoiceAgent(workflowId, t0, undefined, interactionId, true);
  const out: StepResult[] = steps.map(step => ({ step, status: 'skipped', note: '아직 실행하지 않음', ms: 0 }));
  const controller = new AbortController();
  let stop!: () => void;
  let reason = '중단됨';
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const cancel = () => { controller.abort(); stop(); };
  const stopAt = Math.min(deadlineAt - 2_000, Date.now() + 110_000);
  const timer = setTimeout(() => { reason = '시간 한도 도달'; cancel(); }, Math.max(0, stopAt - Date.now()));
  signal?.addEventListener('abort', cancel, { once: true });
  if (Date.now() >= stopAt) { reason = '시간 한도 도달'; cancel(); }
  if (signal?.aborted) cancel();
  try {
    const work = runtime.withPageScope(start.pageId, controller.signal, async () => {
      // 폼 값은 처음 한 번 읽는다. 앞 줄이 화면을 바꾼 뒤에는 그 값이 낡았을 수 있어, 건너뛸 것 같은 줄에서만 다시 읽어 확인한다.
      const readFields = () => runtime.pageScript<unknown>(workflowId, start.pageId, FORM_VALUES_SCRIPT, 3_000).catch(() => null);
      let fields = steps.some((step) => heldTarget(step)) ? await readFields() : null;
      let fresh = true;
      for (let i = 0; i < steps.length && !controller.signal.aborted; i++) {
        const step = steps[i];
        if (isFieldVerification(step)) {
          out[i] = { step, status: 'failed', read_only: true, note: '확인 요청은 값을 변경하지 않습니다. 반환된 form_values로 확인하세요.', ms: 0 };
          continue;
        }
        const t = now();
        let held = heldValue(step, fields);
        if (held && !fresh) {
          fields = await readFields();
          fresh = true;
          held = heldValue(step, fields);
        }
        if (controller.signal.aborted) break;
        if (held) {
          out[i] = { step, status: 'done', note: `이미 「${held.value}」 — 손대지 않음`, ms: Math.round(now() - t), target: `"${held.field}" 칸`, observed: held.value, unchanged: true };
          diag(SCOPE, 'batch-step', out[i]);
          continue;
        }
        const before = agent.actions.length;
        if (!runtime.get(start.pageId)) { reason = '폼 탭이 닫혔습니다.'; break; }
        const dialog = await runtime.pageScript<unknown>(workflowId, start.pageId, CONFIRM_DIALOG_SCRIPT, 1_500).catch(() => null);
        if (controller.signal.aborted) break;
        if (isPageDialog(dialog)) {
          reason = `확인창이 떠 있어 멈춤("${dialog.text.slice(0, 80)}", 버튼 ${dialog.buttons.join('·')}). 누르려면 BrowserInteract click — 확정 버튼은 사용자 확인을 받습니다.`;
          break;
        }
        fresh = false;
        // A deadline may arrive during an upload or click. Never label that step safe to replay.
        out[i] = { step, status: 'failed', note: '실행 중 중단됨. 일부 반영됐을 수 있으므로 현재 값을 확인한 뒤 남은 작업만 수행하세요.', ms: 0 };
        try {
          if (visiblePage(workflowId)?.pageId !== start.pageId) runtime.activate(start.pageId);
          const last = await agent.handle(step, FINAL, async () => !controller.signal.aborted, () => controller.signal.aborted);
          if (controller.signal.aborted) break;
          const acted = agent.actions.slice(before);
          const ok = last.acted && last.effect === 'ok';
          const note = acted.length ? replyFor(acted, true) : last.acted ? ok ? '요청한 상태를 확인함' : '실행 결과를 확인하지 못함' : last.reason;
          const end = acted[acted.length - 1];
          const notices = acted.flatMap((a) => a.notices ?? []);
          out[i] = {
            step,
            status: ok ? 'done' : 'failed',
            note,
            ms: Math.round(now() - t),
            ...(acted[0] ? { target: acted[0].display } : {}),
            ...(end?.text != null ? { requested: end.text } : {}),
            ...(end && end.observed !== undefined ? { observed: end.observed } : {}),
            ...(notices.length ? { notices } : {}),
          };
        } catch (err) {
          if (controller.signal.aborted) break;
          out[i] = { step, status: 'failed', note: `${err instanceof Error ? err.message : String(err)}. 현재 값을 확인한 뒤 남은 작업만 수행하세요.`, ms: Math.round(now() - t) };
        }
        diag(SCOPE, 'batch-step', out[i]);
      }
    });
    await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  for (const row of out) if (row.status === 'skipped') row.note = reason;
  diag(SCOPE, 'batch', { steps: steps.length, done: out.filter((r) => r.status === 'done').length, ms: Math.round(now() - t0) });
  return out.map(row => ({ ...row }));
}
