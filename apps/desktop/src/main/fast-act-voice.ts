/**
 * 말하는 도중 실행 (실험) — Segmenter 가 부르는 판단·실행기. 이 에이전트의 공유 브라우저 탭에서
 * 스냅샷 → 결정 모델(E13: 실행 준비·동작 종류·요소) → 클릭/입력.
 *
 * 스냅샷은 실행이 일어날 때까지 재사용한다(말하는 동안 중간 결과가 여러 번 들어와도 화면은 그대로다).
 * 실행 뒤에는 화면이 바뀌므로 버린다.
 *
 * 채팅으로 시킨 빠른 조작(fast-act-chat)도 이 판단·실행기를 쓴다 — 같은 말에 같은 일을 하도록.
 * 결정 모델 답 위에 보수적인 규칙을 더한다(mac-fastact 와 같은 규칙):
 *   · 입력칸을 누르기만 하는 건 아무것도 이루지 못한다 — 하지 않는다.
 *   · 중간 인식에서 글자 넣기는 넣을 글자 뒤에 글자 넣기 말("검색해", "입력해")이 온 뒤에만.
 *   · 되돌릴 수 없을 수 있는 동작(삭제·로그아웃 …)은 여기서 하지 않고 서버(확인 절차가 있는 경로)로 넘긴다.
 */
import { getBrowserRuntime } from './browser-runtime';
import { diag } from './diag-log';
import {
  classify,
  decisionState,
  elementDisplay,
  elementLabel,
  pickElement,
  resolveAction,
  textFromWordAnswers,
  textWordQuestions,
  quotedText,
  type ActionKind,
  type ElementRefs,
} from './fast-act';
import { FORMAT, READY_OPTS, READY_Q, buildScreen, type Screen13 } from './fast-act-e13';
import { decisionPost, originOf, revealForAct, visiblePage, waitSettled } from './fast-act-runner';
import { CHROME_CLOSE_PICK, CHROME_PICK, LANDMARK, TAB_WORD, withChrome, type ChromeAction } from './fast-act-chrome';
import {
  FIELD_LABEL_SCRIPT,
  editableAsTextbox,
  checkOf,
  labelClickables,
  labelFields,
  refOrder,
  withoutLabel,
  withoutLeadingLabel,
  type FieldLabel,
} from './fast-act-labels';
import { NOTICE_SCRIPT, type Notice } from './fast-act-notice';
import { plainNumber } from './fast-act-number';
import { PRESS_LOST_SCRIPT, PRESS_WATCH_SCRIPT } from './fast-act-press';
import { GUARDED, mentions, norm, type Guard, type Outcome, type Thresholds, type VoiceAgent } from './voice-segmenter';

const SCOPE = 'voice-act';
/** 판단에 쓰는 스냅샷의 최대 나이, 뒤에서 새로 읽기 시작하는 나이. */
const SNAP_TTL_MS = 3_000;
const SNAP_REFRESH_MS = 1_000;
/** 페이지 스크립트(칸 이름 읽기·알림창 닫기) 한도 — 보통 수 ms(BO 상품 등록 31칸 1ms), 페이지가 멈추면 포기한다. */
const PAGE_SCRIPT_MS = 1_500;
/** 알림창을 닫고 화면이 돌아올 때까지 — 닫힘 애니메이션. */
const NOTICE_SETTLE_MS = 250;
/** 한 지시에서 닫는 알림창 수 상한 — 닫을 때마다 새 알림이 뜨는 화면에서 멈추지 않게. */
const NOTICE_MAX = 3;
/** 열린 선택 목록의 항목 — 목록을 연 뒤의 지시는 이 중에서 고른다. */
const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox']);
const LIST_LAYER_ROLES = new Set([...OPTION_ROLES, 'listbox', 'menu', 'group', 'separator', 'presentation', 'none']);
/**
 * 화면에 열린 선택 목록만 남았나 — 선택 상자(MUI Select 등)가 목록을 열면 나머지 화면을 aria-hidden 으로 가려
 * 스냅샷에 목록과 항목만 남는다(10/16 BO: 이 상태로 다음 지시 2개가 목록 자체를 눌렀다).
 */
const listLayer = (refs: ElementRefs): boolean => {
  const roles = Object.values(refs).map((r) => r.role);
  return roles.some((r) => OPTION_ROLES.has(r)) && roles.every((r) => LIST_LAYER_ROLES.has(r));
};
/**
 * 선택 상자를 연 뒤 목록 항목을 고르는 확신 하한 — 값을 말하지 않은 지시("구매연령 선택해줘")에도 모델은 아무
 * 항목에나 0.36~0.61 을 준다(10/16 BO). 값을 말한 지시는 0.99 이상("성인으로" → 만 19세 이상 0.989, "5일로" 0.999).
 */
const CHOOSE_PICK = 0.85;
/** 말이 끝났는데 요소 이름만 말했을 때 누르는 확신 하한. */
const NAMED_ONLY_PICK = 0.8;
const now = (): number => performance.now();
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** 선택 상자의 지금 값 — 이름에서 앞의 칸 이름을 뗀 것(labelFields 는 "칸 이름 값" 으로 붙인다). */
const currentValue = (name: string, label?: string): string => {
  const n = squash(name);
  return label && n.startsWith(label) ? n.slice(label.length).trim() : n;
};
/** 탭이 닫혔나 — 닫히는 중이면 잠깐 기다려 한 번 더 본다. */
const closedTab = async (pageId: string): Promise<boolean> => {
  if (!getBrowserRuntime().get(pageId)) return true;
  await new Promise((r) => setTimeout(r, 300));
  return !getBrowserRuntime().get(pageId);
};

/** 글자 넣기를 시키는 말 — 중간 인식에서 넣을 글자가 끝났는지 볼 때 쓴다. */
const TYPING_WORD = /(입력|검색|써|쓰고|쓰기|쳐|적어|적고|넣어|넣고|넣기|라고|type|search|enter|write)/i;
/**
 * 되돌릴 수 없을 수 있는 동작 — 말 자체가 시키거나 고른 대상의 이름이 이런 것이면 서버로.
 * 명사가 아니라 동작으로 본다: "주문/결제" 메뉴·"결제 내역" 은 이동일 뿐이고 "결제하기" 버튼이 위험하다.
 */
const DANGEROUS =
  /(삭제|지우기|비우기|제거|탈퇴|해지|로그아웃|초기화|영구|결제하기|구매하기|주문하기|delete|remove|erase|empty|log ?out|reset|uninstall|purchase|checkout|pay now)/i;
const DANGEROUS_REQUEST = /(삭제|지워|지우|비워|비우|제거|탈퇴|해지|로그아웃|초기화|결제해|구매해|주문해|delete|remove|erase|empty|log ?out|reset)/i;
/** 글자를 넣을 수 있는 역할 — 입력 요청이면 이것만 후보로 둔다(넣을 글자와 이름이 같은 버튼을 고르지 않게). */
const TYPABLE = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
/**
 * 검색칸에 "…검색해줘" 는 넣고 끝이 아니라 검색까지다 — 결정 모델이 '넣기만' 으로 답해도 검색칸이면 제출한다
 * (검색칸은 제출해야 결과가 나온다는 화면 일반 규칙. 역할이 searchbox 이거나 이름에 검색/search 가 있는 칸).
 */
const SEARCH_WORD = /(검색|찾아|search|find|look up)/i;
/** 항목을 고르라는 말·고른 것을 풀라는 말 — 항목 안의 체크박스를 누를지(checkOf). */
const SELECT_WORD = /(선택|체크|고르|골라|check|select)/i;
const UNSELECT_WORD = /(해제|풀어|uncheck|deselect)/i;
const isSearchField = (r: { role: string; name?: string }): boolean => r.role === 'searchbox' || /검색|search/i.test(r.name ?? '');
/** 누르기만 해서는 아무 일도 안 일어나는 입력칸. */
const TEXT_FIELD = new Set(['textbox', 'searchbox']);
/**
 * 가린 팝업·배너를 닫는 요소의 이름 — 화면 일반 관례(닫기·오늘 하루 보지 않기·거부·×). 동의/수락은 넣지 않는다
 * (사용자 대신 동의하지 않는다). 글자 하나는 닫기 기호(×✕✖)만 — 영문 X 는 계정 버튼의 이름 첫 글자이기도 하다
 * (10/16 BO: 머리글 계정 버튼 "X" 를 눌러 계정 메뉴가 열렸고, 다음 지시가 그 메뉴로 다른 화면에 갔다).
 */
const CLOSE_NAME = /(닫기|닫아|close|dismiss|오늘\s*(하루\s*)?(그만\s*)?(보지|열지)|다시\s*보지|그만\s*보기|나중에|no thanks|거부|reject)|^[×✕✖]$/i;
const CLOSE_ROLE = new Set(['button', 'link', 'checkbox', 'img', 'generic']);
/** 누르려던 요소를 다른 요소가 가렸다는 브라우저 응답. */
const COVERED = /is covered by/;
/** 가려서 못 눌렀을 때 다시 해 보기 전 기다림. */
const COVER_WAIT_MS = 600;

export type VoiceAction = {
  said: string;
  label: string;
  /** 사용자에게 보이는 표기: `"장바구니" 링크`. */
  display: string;
  action: ActionKind;
  text: string | null;
  /** 말하는 도중(중간 인식)에 실행했는가. */
  partial: boolean;
  decideMs: number;
  actMs: number;
  /** 세션 시작부터 실행(클릭·입력 완료)까지. */
  at: number;
  url?: string;
  /** 실행 전 페이지 주소 — 답에서 다른 사이트로 갔는지 볼 때 쓴다. */
  from?: string;
  /** 이동한 페이지의 새 제목 — 주소만 바뀌고 제목은 아직 이전 페이지 것이면 없다. */
  title?: string;
  /** 다른 페이지가 열렸는가(같은 탭 이동 또는 새 탭). */
  navigated: boolean;
  /** 누른 링크가 새 탭으로 열렸다 — url·title 은 새 탭의 것. */
  newTab?: boolean;
  /** 누르려던 요소를 가린 팝업을 먼저 닫았으면 그 요소 이름(또는 Escape). */
  dismissed?: string;
  /** 판단 전·실행 뒤에 닫은 알림창의 문구(fast-act-notice) — 답에서 사용자에게 전한다. */
  notices?: string[];
};

/** labels = 칸 이름이 연결되지 않은 입력칸에 화면에서 찾아 붙인 칸 이름(요소 번호별, fast-act-labels). */
type Snap = {
  at: number;
  pageId: string;
  url: string;
  refs: ElementRefs;
  gen: number;
  ms: number;
  labels: Record<string, string>;
  /** 항목(트리 항목·행)별 그 항목을 고르는 체크박스(checkOf). */
  checks: Record<string, { ref: string; checked: boolean }>;
};

export class BrowserVoiceAgent implements VoiceAgent {
  readonly actions: VoiceAction[] = [];
  private snap: Snap | null = null;
  private inflight: Promise<Snap | null> | null = null;
  /** 실행할 때마다 오른다 — 실행 전에 시작한 스냅샷 결과는 화면 기억에 남기지 않는다. */
  private version = 0;
  /**
   * 판단 중인 handle 수. 판단하는 동안에는 새 스냅샷을 뜨지 않는다 — 스냅샷마다 요소 번호(@eN)가 새로
   * 매겨져, 판단에 쓴 스냅샷의 번호로 누르면 만료(browser_stale_ref)로 거절된다.
   */
  private deciding = 0;
  private last: string | null = null;
  /** 이번 판단 전에 닫은 팝업 — 다음 실행 기록에 붙인다. */
  private dismissed: string | null = null;
  /** 이번 지시에서 닫은 알림창 문구 — 다음 실행 기록에 붙인다. */
  private noticed: string[] = [];
  /** 이번 지시에서 열린 선택 목록을 이미 닫았나 — 한 번만. */
  private listClosed = false;
  /** 실행 직전 이 에이전트의 탭 — 누른 링크가 새 탭을 열었는지 볼 때 쓴다. */
  private tabsAtAct = new Set<string>();

  constructor(
    private workflowId: string,
    private t0: number,
    private onAct?: (a: VoiceAction) => void,
  ) {}

  get lastTarget(): string | null {
    return this.last;
  }

  /** 실행 직전 — 조작할 탭을 화면에 꺼내고, 지금 있는 탭을 기억한다. */
  private beforeAct(page: NonNullable<ReturnType<typeof visiblePage>>): void {
    this.tabsAtAct = new Set(getBrowserRuntime().state().pages.filter((p) => p.workflowId === this.workflowId).map((p) => p.pageId));
    revealForAct(page);
  }

  /**
   * 누른 링크가 새 탭을 열었으면 그 탭 — 새 탭은 빈 주소(about:blank)로 생겼다가 이동하므로 잠깐 기다린다.
   * 원래 탭의 주소가 바뀌었으면(같은 탭 이동) 보지 않는다.
   */
  private async openedTab(page: NonNullable<ReturnType<typeof visiblePage>>): Promise<ReturnType<typeof visiblePage>> {
    const t = now();
    for (;;) {
      const front = visiblePage(this.workflowId);
      if (!front || front.pageId === page.pageId || this.tabsAtAct.has(front.pageId)) return null;
      if ((front.url && front.url !== 'about:blank') || now() - t > 1_500) return front;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * 화면을 미리 읽어 둔다 — 말을 듣기 시작할 때와 인식 결과가 올 때마다. 판단은 스냅샷(0.1~0.3초)을
   * 기다리지 않고, 읽어 둔 화면은 1초가 지나면 뒤에서 새로 읽는다(펼치는 중이던 메뉴 등 주소는 같은데
   * 화면이 바뀐 경우를 놓치지 않게).
   */
  prefetch(): void {
    if (this.deciding > 0 || this.inflight || (this.snap && now() - this.snap.at < SNAP_REFRESH_MS)) return;
    this.snap = this.snap && now() - this.snap.at < SNAP_TTL_MS ? this.snap : null;
    void this.snapshot(true).catch(() => undefined);
  }

  /** 지금 보이는 탭의 스냅샷 — 같은 탭·같은 주소면 5초 동안 재사용한다. 읽는 중이면 그 결과를 같이 쓴다. */
  private async snapshot(refresh = false): Promise<{ snap: Snap; page: NonNullable<ReturnType<typeof visiblePage>> } | null> {
    const page = visiblePage(this.workflowId);
    if (!page) return null;
    const fresh = (s: Snap | null): s is Snap =>
      !!s && s.pageId === page.pageId && s.url === page.url && now() - s.at < SNAP_TTL_MS;
    // 읽는 중인 스냅샷이 있으면 그것이 가장 새것이다 — 그걸 쓴다(따로 또 뜨면 요소 번호가 바뀐다).
    if (this.inflight) {
      const s = await this.inflight;
      if (fresh(s)) return { snap: s, page };
    }
    if (!refresh && fresh(this.snap)) return { snap: this.snap, page };
    const t = now();
    const v = this.version;
    const runtime = getBrowserRuntime();
    // 칸 이름이 연결되지 않은 입력칸의 칸 이름 — 스냅샷과 같이 읽는다(수 ms 라 스냅샷 시간 안에 끝난다).
    const fields = runtime
      .pageScript<FieldLabel[]>(this.workflowId, page.pageId, FIELD_LABEL_SCRIPT, PAGE_SCRIPT_MS)
      .catch(() => null);
    const p = runtime
      .runAgentCommand(this.workflowId, page.pageId, ['snapshot', '-i'], 10_000)
      .then(async (run): Promise<Snap> => {
        const data = (run.result as { data?: { refs?: ElementRefs; snapshot?: string } } | undefined)?.data;
        const raw = editableAsTextbox((data?.refs ?? {}) as ElementRefs, data?.snapshot ?? '');
        const found = await fields;
        const named = Array.isArray(found) ? labelFields(raw, refOrder(data?.snapshot ?? ''), found) : { refs: raw, labels: {} };
        // 이름 없는 누름 영역(검색 팝업을 여는 상자 등)은 바로 앞 제목으로.
        const boxes = labelClickables(named.refs, data?.snapshot ?? '');
        const labels = { ...named.labels, ...boxes.labels };
        const checks = checkOf(data?.snapshot ?? '');
        return { at: now(), pageId: page.pageId, url: page.url, refs: boxes.refs, gen: run.page.generation, ms: now() - t, labels, checks };
      });
    this.inflight = p.catch(() => null);
    let got: Snap;
    try {
      got = await p;
    } finally {
      this.inflight = null;
    }
    if (v === this.version) this.snap = got;
    return { snap: got, page };
  }

  /**
   * 이 스냅샷의 E13 화면 — 질문마다 직접 넘긴다. 전역 화면(setScreen)은 쓰지 않는다: 뒤에서 새로 읽은
   * 스냅샷은 요소 번호가 새로 매겨지므로, 판단 도중 전역 화면이 바뀌면 다른 스냅샷의 번호와 섞인다.
   */
  private screenOf(origin: string, refs: ElementRefs): Screen13 | null {
    if (FORMAT !== 'e13') return null;
    return buildScreen(origin, Object.entries(refs).map(([ref, v]) => ({ ref, role: v.role, name: v.name ?? '' })));
  }

  /** 페이지 요소 앞에 브라우저 자체 조작을 붙인 요소 목록(fast-act-chrome). */
  private withChrome(page: NonNullable<ReturnType<typeof visiblePage>>, refs: ElementRefs): { refs: ElementRefs; chrome: Record<string, ChromeAction> } {
    return withChrome(this.workflowId, page, refs);
  }

  /**
   * 다음 요청이 어디서 시작하나 — 이미 실행한 말(done) 뒤의 단어들(rest) 중 새 요청의 첫 단어.
   * '없음'(꼬리말뿐)은 확신이 0.6 이상일 때만 믿는다.
   */
  async boundary(utterance: string, done: string, rest: string[]): Promise<{ start: number; conf: number }> {
    const post = decisionPost();
    if (!post) return { start: -1, conf: 0 };
    const s = await this.snapshot().catch(() => null);
    const origin = s ? originOf(s.page.url) : '';
    const scr = s ? this.screenOf(origin, this.withChrome(s.page, s.snap.refs).refs) : null;
    const criteria: Record<string, string> = {
      none: 'there is no second request — the remaining words only finish the first one',
    };
    rest.forEach((w, i) => (criteria[`w${i}`] = `starts at "${w}"`));
    const a = await post({
      state: decisionState(utterance, origin, scr),
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
    diag(SCOPE, 'boundary', { done, rest, none: Number(none.toFixed(3)), best, p: Number(bestP.toFixed(3)) });
    if (a.q?.choice === 'none' && none >= 0.6) return { start: -1, conf: none };
    return { start: best, conf: bestP };
  }

  async readiness(texts: string[]): Promise<Array<{ ready: string; p: number }>> {
    const post = decisionPost();
    const s = await this.snapshot().catch(() => null);
    if (!post || !s) return texts.map(() => ({ ready: 'wait', p: 0 }));
    const origin = originOf(s.page.url);
    const scr = this.screenOf(origin, this.withChrome(s.page, s.snap.refs).refs);
    return Promise.all(
      texts.map(async (t) => {
        const a = await post({
          state: decisionState(t, origin, scr),
          questions: { ready: { type: 'choice', instructions: READY_Q, criteria: READY_OPTS } },
        }).catch(() => ({}) as Record<string, { choice?: string; probabilities?: Record<string, number> }>);
        return { ready: a.ready?.choice ?? 'wait', p: a.ready?.probabilities?.act_now ?? 0 };
      }),
    );
  }

  /** 확인 하나뿐인 알림창이 떠 있으면 닫는다(fast-act-notice) — 닫았으면 화면을 다시 읽게 하고 문구를 남긴다. */
  private async closeNotice(page: NonNullable<ReturnType<typeof visiblePage>>): Promise<Notice | null> {
    const notice = await getBrowserRuntime()
      .pageScript<Notice | null>(this.workflowId, page.pageId, NOTICE_SCRIPT, PAGE_SCRIPT_MS)
      .catch(() => null);
    if (!notice) return null;
    this.version++;
    this.snap = null;
    await new Promise((r) => setTimeout(r, NOTICE_SETTLE_MS));
    this.version++;
    this.snap = null; // 닫히는 사이 읽은 화면도 버린다
    this.noticed.push(notice.text);
    diag(SCOPE, 'notice', notice);
    return notice;
  }

  /**
   * 누를 요소를 가린 팝업·배너를 닫는다 — 새 화면에서 닫기 요소(CLOSE_NAME)를 찾아 누르고, 여럿이면 결정
   * 모델에 '팝업 닫기' 로 고르게 한다. 닫기 요소가 없으면 Escape. 닫은 것의 이름을 돌려준다.
   */
  private async dismissOverlay(): Promise<string | null> {
    const runtime = getBrowserRuntime();
    this.snap = null;
    const s = await this.snapshot(true).catch(() => null);
    if (!s) return null;
    const closers = Object.entries(s.snap.refs).filter(
      ([, r]) => CLOSE_ROLE.has(r.role) && CLOSE_NAME.test((r.name ?? '').trim()),
    );
    let ref = closers.length === 1 ? closers[0][0] : null;
    if (closers.length > 1) {
      const post = decisionPost();
      const origin = originOf(s.page.url);
      const pick = post
        ? await pickElement(post, '팝업 닫아줘', origin, Object.fromEntries(closers), this.screenOf(origin, s.snap.refs)).catch(() => null)
        : null;
      ref = pick?.ref ?? closers[0][0];
    }
    let closed: string | null = null;
    if (ref) {
      this.beforeAct(s.page);
      try {
        await runtime.runAgentCommand(this.workflowId, s.page.pageId, ['click', `@${ref}`], 10_000, s.snap.gen);
        closed = s.snap.refs[ref].name ?? ref;
      } catch {
        /* 닫기 요소도 가려졌다 — Escape 로 */
      }
    }
    if (!closed) {
      try {
        await runtime.runAgentCommand(this.workflowId, s.page.pageId, ['press', 'Escape'], 10_000);
        closed = 'Escape';
      } catch {
        return null;
      }
    }
    this.version++;
    this.snap = null;
    await waitSettled(s.page.pageId, s.page);
    this.version++;
    this.snap = null;
    diag(SCOPE, 'dismiss-overlay', { closed, candidates: closers.map(([k, r]) => `${k}:${r.role}:${r.name ?? ''}`).slice(0, 8) });
    return closed;
  }

  /** 넣을 글자 — 따옴표 문구, 아니면 발화 전체를 문맥으로 단어마다 묻는다(남은 조각만 주면 앞말에 걸친 글자를 놓친다). */
  private async typedText(post: NonNullable<ReturnType<typeof decisionPost>>, text: string, origin: string, scr: Screen13 | null, utterance?: string): Promise<string | null> {
    const quoted = quotedText(text);
    if (quoted) return quoted;
    const whole = utterance && norm(utterance).endsWith(norm(text)) ? norm(utterance) : norm(text);
    const offset = whole.split(' ').length - norm(text).split(' ').length;
    const wa = await post({ state: decisionState(whole, origin, scr), questions: textWordQuestions(whole) });
    // 인식기가 붙인 끝 문장부호("원피스.")는 넣을 글자가 아니다.
    return textFromWordAnswers(whole, wa, offset)?.replace(/[.,!?。…]+$/, '') || null;
  }

  /** 입력칸의 지금 값 — 못 읽으면 null. */
  private async valueOf(pageId: string, ref: string, generation: number): Promise<string | null> {
    try {
      const run = await getBrowserRuntime().runAgentCommand(this.workflowId, pageId, ['get', 'value', ref], 5_000, generation);
      const value = (run.result as { data?: { value?: unknown } } | undefined)?.data?.value;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  /** 열린 선택 목록을 닫는다(Escape) — 닫았으면 화면을 다시 읽게 한다. */
  private async closeList(page: NonNullable<ReturnType<typeof visiblePage>>): Promise<boolean> {
    try {
      await getBrowserRuntime().runAgentCommand(this.workflowId, page.pageId, ['press', 'Escape'], 10_000);
    } catch {
      return false;
    }
    this.version++;
    this.snap = null;
    await waitSettled(page.pageId, page);
    this.version++;
    this.snap = null;
    this.dismissed = 'Escape';
    diag(SCOPE, 'dismiss-overlay', { closed: 'Escape', list: true });
    return true;
  }

  /**
   * 선택 상자를 눌러 열린 목록에서 말한 값의 항목을 누른다("구매연령 성인으로 바꿔줘"). 목록이 안 열렸거나 고를 확신이
   * 낮으면(값을 말하지 않음) null — 목록은 열어 두고, 다음 지시가 항목을 고르거나 목록을 닫는다.
   */
  private async chooseAfterOpen(post: NonNullable<ReturnType<typeof decisionPost>>, text: string, th: Thresholds, current: string): Promise<VoiceAction | null> {
    let s = await this.snapshot(true).catch(() => null);
    // 목록은 펼치는 애니메이션 뒤에 잡히기도 한다 — 없으면 잠깐 뒤 한 번 더 읽는다.
    if (s && !listLayer(s.snap.refs)) {
      await new Promise((r) => setTimeout(r, 300));
      s = await this.snapshot(true).catch(() => null);
    }
    if (!s || !listLayer(s.snap.refs)) return null;
    const options = Object.fromEntries(Object.entries(s.snap.refs).filter(([, r]) => OPTION_ROLES.has(r.role)));
    const origin = originOf(s.page.url);
    const t0 = now();
    const pick = await pickElement(post, text, origin, options, this.screenOf(origin, s.snap.refs));
    diag(SCOPE, 'choose-after-open', { text, pick: pick && Number(pick.confidence.toFixed(3)), top: pick?.top });
    if (!pick || pick.confidence < Math.max(th.pick, CHOOSE_PICK)) return null;
    const element = s.snap.refs[pick.ref];
    // 지금 값을 다시 고르는 것은 할 일이 아니다 — "배송비정책 선택해줘" 의 '선택' 은 자리표시 항목 "선택" 과 글자가 같을
    // 뿐 고르라는 값이 아니었다(10/16 BO: 1.0). 목록은 열어 둔다.
    if (squash(element.name ?? '') === current) return null;
    this.beforeAct(s.page);
    const tAct = now();
    try {
      await getBrowserRuntime().runAgentCommand(this.workflowId, s.page.pageId, ['click', `@${pick.ref}`], 10_000, s.snap.gen);
    } catch {
      return null;
    }
    return this.record(text, element, 'click', null, th, tAct - t0, now() - tAct, s.page, pick, s.snap.ms);
  }

  /**
   * 입력 요청인데 입력칸이 접혀 있어 여는 버튼("검색창 열기", 돋보기)을 눌렀으면 — 열린 화면에서 입력칸을 골라
   * 마저 넣는다. 열린 칸이 없거나 넣을 글자를 못 찾으면 아무것도 하지 않는다(누른 것은 이미 기록됨).
   */
  private async typeAfterOpen(post: NonNullable<ReturnType<typeof decisionPost>>, text: string, th: Thresholds, utterance?: string): Promise<VoiceAction | null> {
    const typableOf = (refs: ElementRefs): ElementRefs => Object.fromEntries(Object.entries(refs).filter(([, r]) => TYPABLE.has(r.role)));
    let s = await this.snapshot(true).catch(() => null);
    // 펼쳐지는 검색 층은 애니메이션이 끝나야 입력칸이 잡히기도 한다 — 없으면 잠깐 뒤 한 번 더 읽는다.
    if (s && !Object.keys(typableOf(s.snap.refs)).length) {
      await new Promise((r) => setTimeout(r, 400));
      s = await this.snapshot(true).catch(() => null);
    }
    if (!s) return null;
    const typable = typableOf(s.snap.refs);
    if (!Object.keys(typable).length) return null;
    const origin = originOf(s.page.url);
    const scr = this.screenOf(origin, s.snap.refs);
    const t0 = now();
    const pick = await pickElement(post, text, origin, typable, scr);
    if (!pick || pick.confidence < th.pick) return null;
    const element = s.snap.refs[pick.ref];
    const found = await this.typedText(post, text, origin, scr, utterance);
    const typed = found && withoutLeadingLabel(found, s.snap.labels[pick.ref]);
    if (!typed) return null;
    const action: ActionKind = SEARCH_WORD.test(withoutLabel(text, s.snap.labels[pick.ref])) && isSearchField(element) ? 'type_submit' : 'type';
    const runtime = getBrowserRuntime();
    this.beforeAct(s.page);
    const tAct = now();
    try {
      await runtime.runAgentCommand(this.workflowId, s.page.pageId, ['fill', `@${pick.ref}`, typed], 10_000, s.snap.gen);
      if (action === 'type_submit') await runtime.runAgentCommand(this.workflowId, s.page.pageId, ['press', 'Enter'], 10_000);
    } catch {
      return null;
    }
    return this.record(text, element, action, typed, th, tAct - t0, now() - tAct, s.page, pick, s.snap.ms);
  }

  /** 실행을 기록한다 — 화면이 바뀌므로 스냅샷을 버리고 반영을 기다린다. */
  private async record(
    said: string,
    element: ElementRefs[string],
    action: ActionKind,
    typed: string | null,
    th: Thresholds,
    decideMs: number,
    actMs: number,
    page: NonNullable<ReturnType<typeof visiblePage>>,
    pick: { confidence: number; top?: unknown },
    snapMs = 0,
  ): Promise<VoiceAction> {
    const at = now() - this.t0;
    this.version++;
    this.snap = null; // 화면이 바뀐다
    const settled = await waitSettled(page.pageId, page);
    // 실행이 띄운 알림(입력 검사 등) — 닫고 문구를 답에 붙인다.
    if (!settled.navigated) await this.closeNotice(page);
    const opened = settled.navigated ? null : await this.openedTab(page);
    this.version++;
    this.snap = null; // 반영을 기다리는 사이 읽은 화면도 버린다
    const label = elementLabel(element);
    this.last = label;
    const after = opened ?? (settled.navigated ? settled.page : null);
    const title = after?.title?.trim();
    const done: VoiceAction = {
      said,
      label,
      display: elementDisplay(element),
      action,
      text: typed,
      partial: th.partial,
      decideMs: Math.round(decideMs),
      actMs: Math.round(actMs),
      at: Math.round(at),
      url: after?.url ?? settled.page?.url,
      from: page.url,
      ...(title && title !== page.title && !/^[a-z]+:\/\//i.test(title) ? { title } : {}),
      navigated: !!after,
      ...(opened ? { newTab: true } : {}),
      ...(this.dismissed ? { dismissed: this.dismissed } : {}),
      ...(this.noticed.length ? { notices: [...this.noticed] } : {}),
    };
    this.dismissed = null;
    this.noticed = [];
    this.actions.push(done);
    this.onAct?.(done);
    diag(SCOPE, 'act', { ...done, snapMs: Math.round(snapMs), pick: Number(pick.confidence.toFixed(3)), top: pick.top });
    return done;
  }

  /** 브라우저 자체 조작 실행 — 페이지 클릭과 같은 기록·확인 절차, 확신 기준은 더 높게. */
  private async runChrome(
    ch: ChromeAction,
    text: string,
    th: Thresholds,
    guard: Guard,
    page: NonNullable<ReturnType<typeof visiblePage>>,
    pick: { confidence: number; top?: unknown },
    t0: number,
    snapMs: number,
  ): Promise<Outcome> {
    const no = (reason: string): Outcome => ({ acted: false, reason, ms: now() - t0, detail: pick.top });
    if (pick.confidence < CHROME_PICK) return no(`브라우저 조작 확신 낮음 ${pick.confidence.toFixed(2)}`);
    if (ch.close && (th.partial || pick.confidence < CHROME_CLOSE_PICK)) return no(`탭 닫기는 말이 끝난 뒤 확신 ${CHROME_CLOSE_PICK} 이상에서`);
    if (!(await guard(ch.name, 'press', pick.confidence))) return no(GUARDED);
    const decideMs = now() - t0;
    this.beforeAct(page);
    const tAct = now();
    try {
      await ch.run();
    } catch (err) {
      this.version++;
      this.snap = null;
      return no(`실행 실패 ${err instanceof Error ? err.message : String(err)}`);
    }
    const element = { role: ch.role, name: ch.name } as ElementRefs[string];
    const done = await this.record(text, element, 'click', null, th, decideMs, now() - tAct, page, pick, snapMs);
    return { acted: true, kind: 'press', target: done.label, ms: now() - t0, effect: 'ok' };
  }

  async handle(text: string, th: Thresholds, guard: Guard, abort: () => boolean, utterance?: string, pressOnly = false): Promise<Outcome> {
    this.deciding++;
    this.noticed = [];
    this.listClosed = false;
    this.dismissed = null;
    try {
      const o = await this.handleOnce(text, th, guard, abort, utterance, pressOnly);
      // 판단에 쓴 스냅샷이 그사이 바뀌었으면(요소 번호 만료) 화면을 새로 읽어 한 번만 다시 판단한다.
      if (!o.acted && o.reason.includes('browser_stale_ref')) {
        this.snap = null;
        return await this.handleOnce(text, th, guard, abort, utterance, pressOnly);
      }
      // 팝업·배너가 누를 요소를 가렸으면 그것을 닫고 한 번만 다시 판단한다.
      if (!o.acted && COVERED.test(o.reason)) {
        diag(SCOPE, 'covered', { text, reason: o.reason.slice(0, 300) });
        // 잠깐 덮었다 걷히는 막(불러오는 중 표시·화면 전환)일 수 있다 — 기다렸다 그대로 한 번 더 해 보고, 그래도 가리면 닫는다.
        // 바로 닫으려다 엉뚱한 것을 눌렀다(10/16 BO: 협력사 [적용] 직후 가림 → 머리글의 계정 버튼 "X").
        await new Promise((r) => setTimeout(r, COVER_WAIT_MS));
        this.snap = null;
        const retry = await this.handleOnce(text, th, guard, abort, utterance, pressOnly);
        if (retry.acted || !COVERED.test(retry.reason)) return retry;
        this.dismissed = await this.dismissOverlay();
        this.snap = null;
        const again = await this.handleOnce(text, th, guard, abort, utterance, pressOnly);
        this.dismissed = null;
        return again;
      }
      return o;
    } finally {
      this.deciding--;
    }
  }

  /** pressOnly = 누를 것만 고른다(입력칸은 후보에서 뺀다) — 앞 요청의 꼬리말만으로 실행할 때(voice-segmenter). */
  private async handleOnce(text: string, th: Thresholds, guard: Guard, abort: () => boolean, utterance?: string, pressOnly = false): Promise<Outcome> {
    const t0 = now();
    const no = (reason: string, detail?: unknown): Outcome => ({ acted: false, reason, ms: now() - t0, detail });
    const post = decisionPost();
    if (!post) return no('결정 모델 없음');
    let s;
    try {
      s = await this.snapshot();
    } catch (err) {
      return no(`스냅샷 실패 ${String(err)}`);
    }
    if (!s) return no('열린 브라우저 탭 없음');
    const { snap, page } = s;
    const origin = originOf(page.url);
    const { refs: allRefs, chrome } = this.withChrome(page, snap.refs);
    const scr = this.screenOf(origin, allRefs);

    const cls = await classify(post, text, origin, scr);
    const rc = cls.gate.toFixed(2);
    if (cls.ready === 'not_ui') return no(`화면 조작 아님 ${rc}`);
    // 말이 끝났는데 동사 없이 요소 이름만 말한 경우("이달의 블로그 탭", "검색 버튼") — 모델은 '기다림' 으로
    // 답하지만, 더 올 말이 없으니 그 요소를 누르라는 뜻으로 본다. 대신 고른 확신이 높고 말이 그 이름을
    // 가리킬 때만 한다(아래).
    const namedOnly = !th.partial && cls.ready === 'wait';
    // 중간 인식에서는 학습된 실행 준비 판단이 '지금' 이고 확신이 높을 때만, 최종에서는 기준을 낮춘다.
    if ((th.partial && cls.ready !== 'act_now') || (cls.gate < th.intent && !namedOnly)) {
      return no(`기다림 ${cls.ready} ${rc}`);
    }
    if (abort()) return no('판단 취소(새 인식)');
    // 화면 조작 지시인데 알림창이 화면을 막고 있다 — 닫고 새 화면으로 다시 판단한다.
    if (this.noticed.length < NOTICE_MAX && (await this.closeNotice(page))) return this.handleOnce(text, th, guard, abort, utterance, pressOnly);

    // 입력 요청(동작이 입력이고 글자가 있고 말에 글자 넣기 말이 있음)이면 입력칸만 후보로 — 검색 버튼 대신 검색창.
    const wantsType = !pressOnly && cls.action !== 'click' && !!cls.text && TYPING_WORD.test(text);
    const typable = Object.fromEntries(Object.entries(snap.refs).filter(([, r]) => TYPABLE.has(r.role)));
    // 입력칸이 접혀 있으면(입력 가능한 요소 없음) 여는 버튼을 골라야 한다 — 넣을 글자와 이름이 같은 링크·버튼은 넣을 대상이지
    // 누를 대상이 아니다("검색창에 LG 그램 Pro AI 2026 입력해줘" 에 같은 이름의 상품 링크를 누르던 문제).
    const typedKey = (cls.text ?? '').replace(/\s/g, '');
    const pickable = Object.fromEntries(
      Object.entries(allRefs).filter(
        ([k, r]) =>
          !LANDMARK.has(r.role) &&
          !(wantsType && typedKey.length >= 2 && (r.name ?? '').replace(/\s/g, '').includes(typedKey)) &&
          !(chrome[k]?.close && !TAB_WORD.test(text)) &&
          // 입력 요청은 브라우저 자체 조작(뒤로·새로고침·새 탭)으로 풀지 않는다 — 입력칸이 안 보일 때 새로고침을 골라
          // 채우던 폼이 지워졌다(10/16 BO).
          !(wantsType && chrome[k]) &&
          !(pressOnly && TYPABLE.has(r.role)),
      ),
    );
    const candidates = wantsType && Object.keys(typable).length ? typable : pickable;
    const pick = await pickElement(post, text, origin, candidates, scr);
    if (process.env.DEX_VOICE_TEST === '1') {
      diag(SCOPE, 'debug-screen', {
        text,
        url: page.url,
        snapAgeMs: Math.round(now() - snap.at),
        refs: Object.keys(snap.refs).length,
        labeled: Object.keys(snap.labels).length,
        cands: Object.keys(candidates).length,
        all: scr?.all.length,
        names: Object.entries(snap.refs).map(([k, v]) => `${k}:${v.role}:${(v.name ?? '').slice(0, 14)}`).join(' | '),
        top: pick?.top,
        cls: { action: cls.action, text: cls.text },
      });
    }
    // 앞 지시가 연 선택 목록만 보이는데 이 지시는 목록 항목을 고르지 않는다 — 목록을 닫고 뒤 화면으로 다시 판단한다.
    const option = !!pick && pick.confidence >= th.pick && OPTION_ROLES.has(snap.refs[pick.ref]?.role ?? '');
    if (!th.partial && !option && !this.listClosed && listLayer(snap.refs)) {
      this.listClosed = true;
      if (await this.closeList(page)) return this.handleOnce(text, th, guard, abort, utterance, pressOnly);
    }
    if (!pick || pick.confidence < th.pick) return no(`요소 확신 낮음 ${pick?.confidence.toFixed(2)}`, pick?.top);
    const ch = chrome[pick.ref];
    if (ch) return this.runChrome(ch, text, th, guard, page, pick, t0, snap.ms);
    const element = snap.refs[pick.ref];
    if (namedOnly && (pick.confidence < NAMED_ONLY_PICK || !mentions(text, element.name ?? ''))) {
      return no(`기다림 wait ${rc} (이름만 — 확신 ${pick.confidence.toFixed(2)})`, pick.top);
    }
    const resolved = pressOnly ? { action: 'click' as const, text: null } : resolveAction(cls, element);
    const searching = SEARCH_WORD.test(withoutLabel(text, snap.labels[pick.ref]));
    const action = resolved.action === 'type' && searching && isSearchField(element) ? 'type_submit' : resolved.action;
    let typed = resolved.text;
    if (action !== 'click') {
      const found = await this.typedText(post, text, origin, scr, utterance);
      typed = found && withoutLeadingLabel(found, snap.labels[pick.ref]);
      if (!typed) return no(th.partial ? '입력은 글자가 끝난 뒤' : '넣을 글자를 찾지 못함', pick.top);
    }
    if (action === 'click' && TEXT_FIELD.has(element.role)) return no('입력칸 클릭은 하지 않음', pick.top);
    if (action !== 'click' && th.partial && typed) {
      const lastWord = typed.split(' ').pop() ?? typed;
      const after = text.slice(text.lastIndexOf(lastWord) + lastWord.length);
      if (!TYPING_WORD.test(after)) return no('입력은 글자가 끝난 뒤', pick.top);
    }
    if (DANGEROUS_REQUEST.test(text) || DANGEROUS.test(element.name ?? '')) {
      return no('되돌릴 수 없을 수 있는 동작 — 서버로', pick.top);
    }
    // 항목을 고르라는(고른 것을 풀라는) 말인데 그 항목 안에 고르는 체크박스가 있으면 체크박스를 누른다 — 항목 이름은
    // 펼치기만 하는 트리가 있다(10/16 BO 전시카테고리 찾기, checkOf).
    const said = withoutLabel(text, snap.labels[pick.ref]);
    const check = action === 'click' ? snap.checks[pick.ref] : undefined;
    const toggles = !!check && (UNSELECT_WORD.test(said) ? check.checked : !check.checked && SELECT_WORD.test(said));
    const acted = toggles && check ? { role: snap.refs[check.ref]?.role ?? 'checkbox', name: element.name } : element;
    const label = elementLabel(acted);
    if (!(await guard(element.name ?? '', action === 'click' ? 'press' : 'type', pick.confidence))) {
      return no(GUARDED, pick.top);
    }
    const decideMs = now() - t0;

    const runtime = getBrowserRuntime();
    const ref = `@${toggles && check ? check.ref : pick.ref}`;
    this.beforeAct(page);
    const tAct = now();
    let opened = false;
    try {
      if (action === 'click') {
        const watched = await runtime.pageScript<boolean>(this.workflowId, page.pageId, PRESS_WATCH_SCRIPT, PAGE_SCRIPT_MS).catch(() => false);
        try {
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['click', ref], 10_000, snap.gen);
        } catch (err) {
          // 위 메뉴에 숨은 하위 메뉴처럼 가려진 경우 — 그 자리에 마우스를 올려(메뉴가 펼쳐진다) 한 번 더 누른다.
          // 그래도 가려져 있으면 handle() 이 팝업을 닫고 다시 판단한다.
          if (!COVERED.test(err instanceof Error ? err.message : String(err))) throw err;
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['hover', ref], 10_000, snap.gen);
          await new Promise((r) => setTimeout(r, 400));
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['click', ref], 10_000, snap.gen);
        }
        // 입력칸 초점이 빠지며 화면이 다시 그려져 누른 것이 버려졌다(fast-act-press) — 다시 그려진 요소를 한 번 더 누른다.
        if (watched && (await runtime.pageScript<boolean>(this.workflowId, page.pageId, PRESS_LOST_SCRIPT, PAGE_SCRIPT_MS).catch(() => false))) {
          diag(SCOPE, 'press-lost', { text, ref });
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['click', ref], 10_000, snap.gen);
        }
      } else {
        try {
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['fill', ref, typed ?? ''], 10_000, snap.gen);
        } catch (err) {
          // 글자를 받지 않는 선택 상자(목록이나 찾기 팝업을 여는 상자) — 눌러 열고 아래에서 값을 고른다.
          if (element.role !== 'combobox') throw err;
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['click', ref], 10_000, snap.gen);
          opened = true;
        }
        // 숫자 칸이 단위 붙은 말("20000원", "2만 원")을 통째로 거부했으면 숫자만 다시 넣는다.
        const number = !opened && typed ? plainNumber(typed) : null;
        const kept = number ? await this.valueOf(page.pageId, ref, snap.gen) : null;
        if (number && kept !== null && kept !== typed) {
          await runtime.runAgentCommand(this.workflowId, page.pageId, ['fill', ref, number], 10_000, snap.gen);
          typed = number;
        }
        if (!opened && action === 'type_submit') await runtime.runAgentCommand(this.workflowId, page.pageId, ['press', 'Enter'], 10_000);
      }
    } catch (err) {
      this.version++;
      this.snap = null;
      // 누른 것이 그 탭을 닫았다(새 탭으로 뜬 팝업의 [닫기] → window.close) — 명령 도구가 탭과 같이 끝나 실패로
      // 돌아온다(10/16 BO 브랜드 찾기: "agent-browser exited null"). 눌렀으니 실행한 것으로 친다.
      if (action !== 'click' || !(await closedTab(page.pageId))) return no(`실행 실패 ${err instanceof Error ? err.message : String(err)}`);
    }
    const done = opened ? 'click' : action;
    await this.record(text, acted, done, opened ? null : typed, th, decideMs, now() - tAct, page, pick, snap.ms);
    // 선택 상자를 열었고 말에 고를 값이 있다("구매연령 성인으로 바꿔줘") — 열린 목록에서 그 항목을 누른다.
    const chosen =
      done === 'click' && element.role === 'combobox' ? await this.chooseAfterOpen(post, text, th, currentValue(element.name ?? '', snap.labels[pick.ref])) : null;
    // 입력 요청인데 입력칸이 아닌 것(여는 버튼)을 눌렀다 — 열린 입력칸에 마저 넣는다.
    const typedAfter = !chosen && action === 'click' && wantsType && !TYPABLE.has(element.role) ? await this.typeAfterOpen(post, text, th, utterance) : null;
    const after = chosen ?? typedAfter;
    return {
      acted: true,
      kind: typedAfter ? 'type' : done === 'click' ? 'press' : 'type',
      target: after?.label ?? label,
      text: (typedAfter?.text ?? (opened ? null : typed)) ?? undefined,
      ms: now() - t0,
      effect: 'ok',
    };
  }
}
