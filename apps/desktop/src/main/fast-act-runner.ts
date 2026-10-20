/**
 * 결정 모델 연결과 브라우저 탭 헬퍼. 단계별 BrowserInteract와 기존 음성 판단기가 같이 쓴다.
 *
 * 설정 `fastAct`(기본 꺼짐)를 켜고 로그인했을 때 켜진다. 결정 모델은 XGEN 판단 API
 * (`/api/base/v1/decision/systemone`)로 부른다. 개발 중에는 `DEX_FAST_ACT_URL` 로 판단 모델
 * 서버를 직접 부를 수 있다(설정과 무관하게 켜진다).
 */
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { getBrowserRuntime } from './browser-runtime';
import { appendFile } from 'node:fs/promises';
import { diag, redact } from './diag-log';
import { decisionClient, type DecisionPost } from './fast-act';

const SCOPE = 'fast-act';

/** 클릭 뒤 화면 반영(주소 변경)을 기다리는 최대 시간 — 로딩이 시작된 경우에만 여기까지 본다. */
const SETTLE_MAX_MS = 3_000;

/** 판단 모델이 없다고(503) 답한 서버는 이 시간 동안 묻지 않는다 — 턴마다 스냅샷·실패 왕복을 더하지 않게. */
const UNAVAILABLE_BACKOFF_MS = 60_000;

/** XGEN 판단 API 경로 — index.ts 가 로그인 클라이언트로 채운다. */
export interface FastActDeps {
  /** 설정이 켜져 있고 로그인돼 있는가 */
  enabled: () => boolean;
  post: DecisionPost;
  /**
   * 조작할 브라우저 탭을 화면에 꺼낸다 — 에이전트가 브라우저를 열 때와 같은 경로(채팅 옆 분할).
   * 가려진 웹뷰는 그리기를 멈춰서 클릭이 5초 기다리다 효과 없이 끝난다(10/15 dev-xgen 실측).
   */
  reveal?: (page: BrowserPageInfo) => void;
}
let deps: FastActDeps | null = null;
let direct: DecisionPost | null = null;
let warmed: DecisionPost | null = null;
let unavailableUntil = 0;

export function configureFastAct(d: FastActDeps): void {
  deps = { enabled: d.enabled, post: withLog(withBackoff(d.post)), reveal: d.reveal };
}

/**
 * 개발용: `DEX_SEV_LOG=<파일.jsonl>` 이면 판단 호출마다 입력(state·questions)·출력(answers)·시간을 한 줄씩 붙인다.
 * 화면 글자와 사용자 말이 그대로 남으므로 기본 꺼짐이고, 진단 링 버퍼(diag)가 아닌 지정한 파일에만 쓴다.
 */
const SEV_LOG = process.env.DEX_SEV_LOG?.trim();
function withLog(post: DecisionPost): DecisionPost {
  if (!SEV_LOG) return post;
  const write = (rec: object): void =>
    void appendFile(SEV_LOG, `${redact(JSON.stringify({ at: new Date().toISOString(), ...rec }))}\n`).catch(() => undefined);
  return async (body) => {
    const t = performance.now();
    try {
      const answers = await post(body);
      write({ ms: Math.round(performance.now() - t), state: body.state, questions: body.questions, answers });
      return answers;
    } catch (err) {
      write({ ms: Math.round(performance.now() - t), state: body.state, questions: body.questions, error: String(err) });
      throw err;
    }
  };
}

/** 조작 직전에 부른다 — 이미 보이면 배치는 그대로다. */
export function revealForAct(page: BrowserPageInfo): void {
  try {
    deps?.reveal?.(page);
  } catch (err) {
    diag(SCOPE, 'reveal failed', String(err));
  }
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
  if (url) post = direct ??= withLog(decisionClient(url, 8_000));
  else if (deps?.enabled() && Date.now() >= unavailableUntil) post = deps.post;
  if (post && post !== warmed) {
    warmed = post;
    // 예열 — 첫 요청이 연결 수립까지 떠안지 않게 한 번 미리 부른다.
    post({ state: 'warm up', questions: { q: { type: 'choice', instructions: 'ok?', criteria: { a: 'a', b: 'b' } } } })
      .then(() => diag(SCOPE, 'warm-up ok'))
      .catch((err) => {
        warmed = null;
        // 서버가 준 이유(본문)도 남긴다 — 404 만으로는 경로가 없는지, 판단 모델이 없는지 알 수 없었다(10/20).
        diag(SCOPE, 'warm-up failed', { error: String(err), body: (err as { body?: unknown }).body });
      });
  }
  return post;
}

export function fastActEnabled(): boolean {
  return !!decisionPost();
}

/** 빠른 조작이 설정상 켜져 있나 — 판단 모델이 잠시 쉬는 중(503 뒤)이어도 true. 도구 광고처럼 한 번 정해지면 오래 가는 곳에 쓴다. */
export function fastActConfigured(): boolean {
  return !!process.env.DEX_FAST_ACT_URL?.trim() || !!deps?.enabled();
}

/** 이 에이전트의 활성 팝업 또는 브라우저 탭. */
export function visiblePage(workflowId: string): BrowserPageInfo | null {
  const runtime = getBrowserRuntime();
  if (!runtime.isEnabled()) return null;
  const state = runtime.state();
  const pages = state.pages.filter((p) => p.workflowId === workflowId && p.mode !== 'background');
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

// 앱이 뜨고 조금 뒤 예열 — 첫 지시가 연결 수립 비용을 떠안지 않게(XGEN 경로는 로그인 뒤 첫 호출 때).
if (process.env.DEX_FAST_ACT_URL?.trim()) setTimeout(() => void decisionPost(), 3_000);
