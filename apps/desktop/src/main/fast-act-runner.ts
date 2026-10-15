/**
 * 고속 조작 실행기 (실험) — chat:start 가 서버 스트림을 열기 전에 부른다.
 *
 * 설정 `fastAct`(기본 꺼짐)를 켜고 로그인했을 때 켜진다. 결정 모델은 XGEN 판단 API
 * (`/api/base/v1/decision/systemone`)로 부른다. 개발 중에는 `DEX_FAST_ACT_URL` 로 판단 모델
 * 서버를 직접 부를 수 있다(설정과 무관하게 켜진다).
 * 단순 조작이면 이 PC 의 내장 브라우저에서 스냅샷 → 결정 모델 → 클릭/입력까지
 * 끝내고 결과를 서버 턴과 같은 ChatEvent 로 그린다. 그 밖에는 false 를 돌려
 * 평소처럼 서버로 넘긴다.
 *
 * 실행이 시작된 뒤(클릭·입력을 보낸 뒤)에는 절대 서버로 넘기지 않는다 —
 * 같은 조작이 두 번 일어난다.
 *
 * 한계 (실험이라 그대로 둔다):
 *   · 로컬 턴은 서버 기록에 남지 않는다 — 대화를 다시 열면 사라지고, 서버
 *     LLM 도 다음 턴에서 이 조작을 모른다.
 *   · 현재 대화 에이전트의 '공유' 브라우저 탭만 본다.
 */
import { stripTeamsContext, turnInputText, type ChatEvent, type ChatRequest } from '@dex/protocol';
import { stripBrowserContext, type BrowserPageInfo } from '@dex/protocol/browser';
import { stripVoiceContext } from '@dex/protocol/voice-context';
import { getBrowserRuntime } from './browser-runtime';
import { diag } from './diag-log';
import {
  classify,
  decisionClient,
  elementDisplay,
  elementLabel,
  pickElement,
  resolveAction,
  type DecisionPost,
  type ElementRefs,
} from './fast-act';
import { FORMAT, buildScreen, setScreen } from './fast-act-e13';
import { takeVoiceTurn, type VoiceTurn } from './voice-turns';

const SCOPE = 'fast-act';

/** 판별 점수 하한 — 벤치 53문항 + 비조작 22문장으로 정한 값 (재현율 0.81, 비조작 거절 0.95). */
const GATE_MIN = Number(process.env.DEX_FAST_ACT_GATE ?? 0.5);
/** 최종 요소 확신도 하한 — 순서 보정 뒤 두 후보가 비등하면(0.5 안팎) 서버로 넘긴다. */
const PICK_MIN = Number(process.env.DEX_FAST_ACT_PICK ?? 0.6);
/** 클릭 뒤 화면 반영(주소 변경)을 기다리는 최대 시간 — 로딩이 시작된 경우에만 여기까지 본다. */
const SETTLE_MAX_MS = 3_000;

/** 판단 모델이 없다고(503) 답한 서버는 이 시간 동안 묻지 않는다 — 턴마다 스냅샷·실패 왕복을 더하지 않게. */
const UNAVAILABLE_BACKOFF_MS = 60_000;

/** XGEN 판단 API 경로 — index.ts 가 로그인 클라이언트로 채운다. */
export interface FastActDeps {
  /** 설정이 켜져 있고 로그인돼 있는가 */
  enabled: () => boolean;
  post: DecisionPost;
}
let deps: FastActDeps | null = null;
let direct: DecisionPost | null = null;
let warmed: DecisionPost | null = null;
let unavailableUntil = 0;

export function configureFastAct(d: FastActDeps): void {
  deps = { enabled: d.enabled, post: withBackoff(d.post) };
}

/** XGEN 쪽 호출이 503(판단 모델 미로드)이면 잠시 끈다. */
function withBackoff(post: DecisionPost): DecisionPost {
  return async (body) => {
    try {
      return await post(body);
    } catch (err) {
      if ((err as { status?: number }).status === 503) {
        unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
        diag(SCOPE, 'decision model unavailable — backing off', { ms: UNAVAILABLE_BACKOFF_MS });
      }
      throw err;
    }
  };
}

export function decisionPost(): DecisionPost | null {
  let post: DecisionPost | null = null;
  const url = process.env.DEX_FAST_ACT_URL?.trim();
  if (url) post = direct ??= decisionClient(url, 8_000);
  else if (deps?.enabled() && Date.now() >= unavailableUntil) post = deps.post;
  if (post && post !== warmed) {
    warmed = post;
    // 예열 — 첫 요청이 연결 수립까지 떠안지 않게 한 번 미리 부른다.
    post({ state: 'warm up', questions: { q: { type: 'choice', instructions: 'ok?', criteria: { a: 'a', b: 'b' } } } })
      .then(() => diag(SCOPE, 'warm-up ok'))
      .catch((err) => {
        warmed = null;
        diag(SCOPE, 'warm-up failed', String(err));
      });
  }
  return post;
}

export function fastActEnabled(): boolean {
  return !!decisionPost();
}

/** 렌더러가 붙인 봉투(브라우저·Teams 컨텍스트)를 떼고 사용자 원문만 남긴다. */
function userText(req: ChatRequest): string | null {
  if (typeof req.input !== 'string') return null; // 첨부·이미지가 있는 턴은 대상이 아니다
  return stripVoiceContext(stripTeamsContext(stripBrowserContext(turnInputText(req.input)))).trim() || null;
}

/** 이 에이전트의 화면에 보이는 브라우저 탭 — BrowserPane 과 같은 규칙. */
export function visiblePage(workflowId: string): BrowserPageInfo | null {
  const runtime = getBrowserRuntime();
  if (!runtime.isEnabled()) return null;
  const state = runtime.state();
  const pages = state.pages.filter((p) => p.workflowId === workflowId && p.mode === 'shared');
  return pages.find((p) => p.pageId === state.activeByWorkflow[workflowId]) ?? pages[0] ?? null;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const now = (): number => performance.now();
const ms = (v: number): string => `${Math.round(v)}ms`;
const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(r, t));

/**
 * 클릭 뒤 화면이 바뀌었는지 본다 — 주소가 바뀌면 바로 반영으로 본다(로딩 끝까지
 * 기다리면 광고·추적 스크립트가 많은 페이지에서 매번 최대 대기까지 간다: FO 실측
 * 주소는 0.8초에 바뀌는데 답은 4.6초). 같은 페이지 안의 변화(펼치기·입력)는
 * 주소가 안 바뀌므로 잠깐만 본다.
 */
export async function waitSettled(
  pageId: string,
  before: BrowserPageInfo,
): Promise<{ page: BrowserPageInfo | null; navigated: boolean; ms: number }> {
  const runtime = getBrowserRuntime();
  const t0 = now();
  let sawLoading = false;
  while (now() - t0 < SETTLE_MAX_MS) {
    const p = runtime.get(pageId);
    if (!p) return { page: null, navigated: false, ms: now() - t0 };
    if (p.url !== before.url) return { page: p, navigated: true, ms: now() - t0 };
    if (p.loading === 'loading') sawLoading = true;
    if (!sawLoading && now() - t0 > 600) return { page: p, navigated: false, ms: now() - t0 };
    await sleep(30);
  }
  return { page: runtime.get(pageId), navigated: false, ms: now() - t0 };
}

let seq = 0;

/**
 * 음성 세션이 말하는 도중에 실행한 조작을 이 턴에 그린다. 남은 말이 없으면 여기서 끝내고(true),
 * 있으면 요청을 남은 말로 바꿔 서버로 넘긴다(false) — 이미 한 조작을 서버가 다시 하지 않게 알려 준다.
 * 실행한 것이 없으면 평소처럼 서버로.
 */
function voiceTurn(req: ChatRequest, voice: VoiceTurn, text: string, emit: (ev: ChatEvent) => void): boolean {
  if (voice.actions.length === 0) return false;
  const id = `voice-${Date.now()}-${++seq}`;
  emit({ kind: 'status', surface: 'connector_local', detail: '말하는 도중 실행 — 서버 LLM 없이 결정 모델로 처리' });
  voice.actions.forEach((a, i) => {
    const toolUseId = `${id}-${i}`;
    const how = `${a.action}${a.text ? ` "${a.text}"` : ''}`;
    const when = a.partial ? '말하는 도중' : '말이 끝난 뒤';
    emit({ kind: 'tool', event: { eventType: 'tool_call', toolName: '음성 조작', toolInput: { said: a.said }, toolUseId } });
    emit({
      kind: 'tool',
      event: {
        eventType: 'tool_result',
        toolName: '음성 조작',
        result: `${a.label} · ${how} · ${when} · 판단 ${ms(a.decideMs)} · 실행 ${ms(a.actMs)}`,
        toolUseId,
        durationMs: a.decideMs + a.actMs,
      },
    });
  });
  const done = voice.actions
    .map((a) => (a.text ? `${a.display}에 "${a.text}"${a.action === 'type_submit' ? ' 입력하고 Enter' : ' 입력'}` : `${a.display} 누름`))
    .join(' → ');
  if (!voice.unhandled) {
    const mid = voice.actions.filter((a) => a.partial).length;
    const when = mid === voice.actions.length ? '모두 말하는 도중에' : mid ? `${mid}개는 말하는 도중에` : '말이 끝나자';
    // 한 문단으로 — 문단을 나누면 채팅은 마지막 문단만 답으로 보여 준다.
    emit({ kind: 'text', content: `${done} · ${when} 처리 (음성 조작 · 서버 LLM 없이 결정 모델)` });
    emit({ kind: 'end' });
    return true;
  }
  // 이미 한 조작은 "지금 화면 상태" 로만 알린다 — "다시 하지 마라" 식 지시를 붙이면 LLM 이 그 말을 답에
  // 옮긴다("앞서 실행했다고 하신 동작은 다시 실행하지 않았습니다").
  const already = voice.actions.map((a) => a.display).join(', ');
  const rest = `${voice.unhandled}\n\n(현재 화면: 방금 음성 조작으로 ${already} 을(를) 눌러 둔 상태)`;
  if (typeof req.input === 'string' && req.input.includes(text)) req.input = req.input.replace(text, rest);
  else req.input = rest;
  diag(SCOPE, 'voice: 남은 말 서버로', { unhandled: voice.unhandled, acted: voice.actions.length });
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
  const post = decisionPost();
  const text = userText(req);
  if (!post || !text || !req.workflowId) return false;
  // 비교용 — '!' 로 시작하면 같은 지시를 기존 서버 경로로 보낸다.
  if (text.startsWith('!')) return false;
  // 말하는 도중 실행한 발화 — 이미 한 조작은 다시 하지 않는다(판단도 최종 기준으로 이미 해 봤다).
  const voice = takeVoiceTurn(req.workflowId, text);
  if (voice) return voiceTurn(req, voice, text, emit);
  const page = visiblePage(req.workflowId);
  if (!page) {
    diag(SCOPE, 'skip: 열린 브라우저 탭 없음');
    return false;
  }
  const t0 = now();
  diag(SCOPE, 'start', { text, at: Date.now() }); // 렌더러 전송 → main 도착 지연을 재기 위한 벽시계
  const origin = originOf(page.url);
  const runtime = getBrowserRuntime();
  const id = `fast-${Date.now()}-${++seq}`;
  const row = (name: string, input: unknown, result: string, durationMs: number, n: number): void => {
    const toolUseId = `${id}-${n}`;
    emit({ kind: 'tool', event: { eventType: 'tool_call', toolName: name, toolInput: input, toolUseId } });
    emit({ kind: 'tool', event: { eventType: 'tool_result', toolName: name, result, toolUseId, durationMs } });
  };

  // 1) 판별과 스냅샷을 동시에 — 판별이 '아니오' 면 스냅샷을 기다리지 않고 바로 넘긴다.
  const snapStart = now();
  const snapP = runtime
    .runAgentCommand(req.workflowId, page.pageId, ['snapshot', '-i'], 10_000)
    .then((run) => ({ run, ms: now() - snapStart }));
  snapP.catch(() => undefined); // 넘긴 경우 결과를 버린다

  // E13 은 모든 질문의 state 에 화면 줄이 들어간다 — 스냅샷을 먼저 받아 화면을 정한 뒤 판별한다.
  let early: Awaited<typeof snapP> | null = null;
  if (FORMAT === 'e13') {
    try {
      early = await snapP;
    } catch (err) {
      diag(SCOPE, 'skip: 스냅샷 실패', String(err));
      return false;
    }
    const r0 = ((early.run.result as { data?: { refs?: ElementRefs } } | undefined)?.data?.refs ?? {}) as ElementRefs;
    setScreen(buildScreen(origin, Object.entries(r0).map(([ref, v]) => ({ ref, role: v.role, name: v.name ?? '' }))));
  } else setScreen(null);
  let cls;
  try {
    cls = await classify(post, text, origin);
  } catch (err) {
    diag(SCOPE, 'skip: 결정 모델 오류', String(err));
    return false;
  }
  if (signal.aborted) return true;
  if (cls.gate < GATE_MIN) {
    diag(SCOPE, 'to server: 단순 조작 아님', { text, gate: cls.gate, ms: Math.round(cls.ms) });
    row('고속 조작 판별', { instruction: text }, `서버로 넘김 — 단순 조작 아님 (판별 ${cls.gate.toFixed(2)})`, cls.ms, 0);
    return false;
  }

  // 2) 스냅샷 → 요소 고르기
  let snap;
  try {
    snap = early ?? (await snapP);
  } catch (err) {
    diag(SCOPE, 'skip: 스냅샷 실패', String(err));
    return false;
  }
  const data = (snap.run.result as { data?: { refs?: ElementRefs } } | undefined)?.data;
  const refs = data?.refs ?? {};
  let pick;
  try {
    pick = await pickElement(post, text, origin, refs);
  } catch (err) {
    diag(SCOPE, 'skip: 결정 모델 오류', String(err));
    return false;
  }
  if (signal.aborted) return true;
  if (!pick || pick.confidence < PICK_MIN) {
    const why = pick ? `요소 확신 낮음 (${pick.confidence.toFixed(2)})` : '고를 요소 없음';
    diag(SCOPE, `to server: ${why}`, { text, top: pick?.top, refs: Object.keys(refs).length });
    row('고속 조작 판별', { instruction: text }, `서버로 넘김 — ${why}`, now() - t0, 0);
    return false;
  }
  const element = refs[pick.ref];
  const { action, text: typed } = resolveAction(cls, element);
  const decideMs = now() - t0;

  // 3) 실행 — 여기부터는 서버로 넘기지 않는다.
  emit({ kind: 'status', surface: 'connector_local', detail: '고속 조작 — 서버 LLM 없이 결정 모델로 처리' });
  row(
    '스냅샷',
    { page: page.url },
    `요소 ${Object.keys(refs).length}개`,
    snap.ms,
    1,
  );
  row(
    '결정 모델',
    { instruction: text },
    `${pick.ref} ${elementLabel(element)} · ${action}${typed ? ` "${typed}"` : ''} · 판별 ${cls.gate.toFixed(2)} · 확신 ${pick.confidence.toFixed(2)} · 호출 ${pick.calls + 1}번`,
    cls.ms + pick.ms,
    2,
  );
  const gen = snap.run.page.generation;
  const ref = `@${pick.ref}`;
  const actStart = now();
  try {
    if (action === 'click') {
      await runtime.runAgentCommand(req.workflowId, page.pageId, ['click', ref], 10_000, gen);
    } else {
      await runtime.runAgentCommand(req.workflowId, page.pageId, ['fill', ref, typed ?? ''], 10_000, gen);
      if (action === 'type_submit') {
        await runtime.runAgentCommand(req.workflowId, page.pageId, ['press', 'Enter'], 10_000);
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    diag(SCOPE, 'act failed', { text, ref, detail });
    row(action === 'click' ? '클릭' : '입력', { ref }, `실패: ${detail}`, now() - actStart, 3);
    emit({ kind: 'text', content: `${elementLabel(element)} 조작에 실패했어요: ${detail}` });
    emit({ kind: 'end' });
    return true;
  }
  const actMs = now() - actStart;
  const clickedAt = now() - t0;
  row(action === 'click' ? '클릭' : '입력', { ref, text: typed }, '완료', actMs, 3);

  // 4) 결과 확인
  const settled = await waitSettled(page.pageId, page);
  const after = settled.page;
  // 한 문단으로 — 문단을 나누면 채팅은 마지막 문단만 답으로 보여 준다(앞 문단은 작업 과정 쪽으로 접힌다).
  const did = typed
    ? `${elementDisplay(element)}에 "${typed}"${action === 'type_submit' ? ' 입력하고 Enter' : ' 입력'}`
    : `${elementDisplay(element)} 누름`;
  const moved = settled.navigated && after ? ` → ${after.title || after.url}` : '';
  const summary =
    `${did}${moved} · 고속 조작 ${ms(clickedAt + settled.ms)}` +
    ` (스냅샷 ${ms(snap.ms)} · 판단 ${ms(cls.ms + pick.ms)} · 실행 ${ms(actMs)} · 화면 반영 ${ms(settled.ms)})`;
  diag(SCOPE, 'done', {
    text,
    ref: pick.ref,
    label: elementLabel(element),
    action,
    gate: Number(cls.gate.toFixed(3)),
    pick: Number(pick.confidence.toFixed(3)),
    refs: Object.keys(refs).length,
    snapMs: Math.round(snap.ms),
    classifyMs: Math.round(cls.ms),
    pickMs: Math.round(pick.ms),
    decideMs: Math.round(decideMs),
    actMs: Math.round(actMs),
    clickedMs: Math.round(clickedAt),
    settledMs: Math.round(clickedAt + settled.ms),
    navigated: settled.navigated,
    top: pick.top,
  });
  emit({ kind: 'text', content: summary });
  emit({ kind: 'end' });
  return true;
}

// 앱이 뜨고 조금 뒤 예열 — 첫 지시가 연결 수립 비용을 떠안지 않게(XGEN 경로는 로그인 뒤 첫 호출 때).
if (process.env.DEX_FAST_ACT_URL?.trim()) setTimeout(() => void decisionPost(), 3_000);
