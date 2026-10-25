import { BrowserWindow, dialog } from 'electron';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { BrowserFileScopes, BrowserScratch, displayBrowserFileResult } from './browser-file-transfer';
import { BrowserRuntime, BrowserRuntimeError } from './browser-runtime';
import { allowsDeciderAction, type DecisionPost } from './fast-act';
import { BROWSER_STEP_GUIDE, browserStepProperties, executeBrowserStep } from './browser-step';
import { diag } from './diag-log';
import { fastActConfigured } from './fast-act-runner';
import { FORM_VALUES_SCRIPT, formLines } from './fast-act-labels';
import { MAX_FILL_STEPS, briefResults, runSteps } from './fast-act-batch';
import {
  CONFIRM_DIALOG_SCRIPT,
  ConfirmDeclined,
  ConfirmGrants,
  PAGE_MESSAGES_SCRIPT,
  confirmPress,
  declinedMessage,
  isPageDialog,
  type ConfirmAnswer,
  type ConfirmAsker,
  type PageDialog,
  type PageMessages,
} from './browser-confirm';
import type {
  LocalToolCallContext,
  LocalToolResult,
  LocalToolSchema,
} from '@dex/engine/local-tools';

export const BROWSER_TABS_TOOL = 'BrowserTabs';
export const BROWSER_NAVIGATE_TOOL = 'BrowserNavigate';
export const BROWSER_SNAPSHOT_TOOL = 'BrowserSnapshot';
export const BROWSER_INTERACT_TOOL = 'BrowserInteract';
export const BROWSER_CAPTURE_TOOL = 'BrowserCapture';
export const BROWSER_ADVANCED_TOOL = 'BrowserAdvanced';
export const BROWSER_FILL_TOOL = 'BrowserFill';
export const BROWSER_FORM_VALUES_TOOL = 'BrowserFormValues';
/** 경로 없이 캡처하면 저장하는 곳 — 연결 폴더 안의 숨은 폴더(파일 올리기 후보에서도 빠진다). */
const CAPTURE_DIR = '.xgen-captures';
/**
 * 페이지를 옮긴 조작의 결과에 붙이는 스냅샷의 글자 상한. 결과에 화면이 없으면 서버 모델은 이동·클릭마다
 * BrowserSnapshot 을 한 번 더 불렀다 — LLM 한 턴(약 3초)이 더 든다(10/23 BO 시연: 도구 18회 중 2회).
 * BO 상품 등록 폼이 14,440자였다(10/24) — 목표 화면이 잘리면 모델은 결국 전체를 다시 읽는다.
 */
const PAGE_AFTER_MAX_CHARS = 20_000;
/** 붙일 스냅샷 한 번의 시간 상한 — 넘으면 조작 결과만 돌려준다(조작은 이미 끝났다). */
const PAGE_AFTER_TIMEOUT_MS = 8_000;
/** 페이지를 옮길 수 있는 조작. 실제로 옮겨 갔을(generation 이 바뀐) 때만 스냅샷을 붙인다. */
const PAGE_MOVING_ACTIONS = new Set(['click', 'double_click', 'keypress']);
/**
 * 이동 뒤 문서가 준비되고 나서 SPA 가 스크립트를 돌려 첫 데이터 요청을 보내기까지 기다리는 틈 — 이 안에 시작한
 * 요청은 끝날 때까지 기다린 뒤 화면을 읽는다. BO 메인은 문서 준비 뒤 약 250ms 에 메뉴·대시보드 요청을 보냈고,
 * 그 전에 읽은 화면은 버튼 35개 중 7개뿐이었다(10/24 실측). Playwright MCP 의 조작 뒤 기본 대기도 500ms 다.
 */
const DOCUMENT_REQUEST_PROBE_MS = 500;
/**
 * 확인창 카드의 답을 기다리는 상한. 턴 전체가 시작부터 300초 예산이고 기다리는 동안에도 줄어든다(xgen-workflow
 * execution_budget, 10/24 확인) — 늦게 끊겨 결과 없이 취소되느니 이 안에 "답이 없어 누르지 않음" 을 돌려준다.
 */
export const CONFIRM_WAIT_MS = 90_000;
/** 확인창·화면 문구를 읽는 스크립트의 시간 상한 — 그린 화면에서는 수 ms 다. */
const DIALOG_SCRIPT_MS = 1_500;
/** 확인창을 누를 수 있는 agent-browser 명령. */
const PRESS_COMMANDS = new Set(['click', 'dblclick', 'press', 'mouse']);

/** 연결 폴더 안에 그 파일이 이미 있나. */
function exists(target: Awaited<ReturnType<BrowserFileScopes['resolve']>>): boolean {
  try {
    target.grant.openSource(target.relativePath).close();
    return true;
  } catch {
    return false;
  }
}

export const BROWSER_TOOL_NAMES = new Set([
  BROWSER_TABS_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_INTERACT_TOOL,
  BROWSER_CAPTURE_TOOL,
  BROWSER_ADVANCED_TOOL,
  BROWSER_FILL_TOOL,
  BROWSER_FORM_VALUES_TOOL,
]);

/** 공유 탭을 다루는 도구(BrowserFill·BrowserFormValues)의 필수 page_id — 백그라운드로 대신하지 않는다. */
const sharedPageProperties = {
  page_id: {
    type: 'string',
    description: 'page_id of the shared (visible) tab holding the form — from BrowserTabs list (mode shared).',
  },
};

const commonPageProperties = {
  workflow_id: {
    type: 'string',
    description:
      'Legacy compatibility only; omit when the connector supplies caller context automatically.',
  },
  page_id: {
    type: 'string',
    description: 'Exact XGEN browser page id. Omit to use/create the workflow background page.',
  },
};

export function browserToolSchemas(steps = false): LocalToolSchema[] {
  return [
    {
      name: BROWSER_TABS_TOOL,
      title: '브라우저 탭',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Manage XGEN browser pages on the user desktop. Use create with mode shared to open and reveal a visible browser tab without asking the user to open it first; background is agent-only. ' +
        'Site popups appear in list as mode popup with their own page_id; target that page_id to interact with them. ' +
        'For the currently visible page use the entry with active=true, especially when multiple tabs have the same title and URL. ' +
        'A missing page_id on other browser tools uses the workflow default background page.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'close', 'activate'] },
          ...commonPageProperties,
          workflow_name: { type: 'string' },
          mode: {
            type: 'string',
            enum: ['shared', 'background'],
            description:
              'shared opens a visible XGEN browser tab; background stays hidden for autonomous work.',
          },
          url: { type: 'string' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_NAVIGATE_TOOL,
      title: '페이지 이동',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Navigate one XGEN browser page: goto/back/forward/reload/stop/wait. ' +
        'goto/back/forward/reload return once the new document is ready, with its interactive snapshot (snapshot, and generation at the top level) — ' +
        'use those refs directly instead of calling BrowserSnapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload', 'stop', 'wait'] },
          url: { type: 'string' },
          wait_for: {
            type: 'string',
            description:
              'wait: milliseconds ("1500"), load state ("load" | "domcontentloaded" | "networkidle"), URL ("https://…" or "**/path"), visible text ("text:Welcome"), or a CSS selector.',
          },
          timeout_ms: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_SNAPSHOT_TOOL,
      title: '화면 읽기',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Return the accessibility snapshot and fresh @eN refs for a page. Pass the returned generation to ref-based interactions so stale refs are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          interactive_only: { type: 'boolean' },
          compact: { type: 'boolean' },
          depth: { type: 'integer' },
          timeout_ms: { type: 'integer' },
        },
      },
    },
    {
      name: BROWSER_INTERACT_TOOL,
      title: '화면 조작',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        (steps ? `${BROWSER_STEP_GUIDE} ` : '') +
        'Interact with a page using refs from BrowserSnapshot: click/fill/type/keypress/select/check/uncheck/hover/drag/scroll/mouse. ' +
        'If opened_pages is returned, inspect that page_id with BrowserSnapshot instead of clicking the opener again or listing tabs. ' +
        'When a click or keypress takes the page to a new document or route, the result carries the new page\'s snapshot and its generation — use those refs; earlier refs are no longer valid. ' +
        'When the page stays, no snapshot is attached and earlier refs keep working; a dialog or alert left on the page comes back as dialog/alerts. ' +
        'Pressing the confirm button of a site confirmation dialog (취소·닫기 plus another button) first asks the user on this PC; on refusal you get user_denied or their instructions — never press it another way.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: {
            type: 'string',
            enum: [
              ...(steps ? ['step'] : []),
              'click',
              'double_click',
              'fill',
              'type',
              'keypress',
              'select',
              'check',
              'uncheck',
              'hover',
              'drag',
              'scroll',
              'mouse',
            ],
          },
          ref: { type: 'string', description: 'Snapshot ref such as @e4.' },
          target_ref: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          value: {},
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer' },
          generation: { type: 'integer', description: 'Generation returned with the snapshot whose refs you use.' },
          timeout_ms: { type: 'integer' },
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string' },
          operation: { type: 'string', description: 'mouse: move/down/up/wheel.' },
          ...(steps ? browserStepProperties : {}),
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_CAPTURE_TOOL,
      title: '화면 캡처',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description: 'Capture screenshot/full screenshot/PDF or inspect console/page errors.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: {
            type: 'string',
            enum: ['screenshot', 'full_screenshot', 'pdf', 'console', 'errors'],
          },
          path: {
            type: 'string',
            description:
              'Output file on the user\'s computer, inside a folder connected to this conversation ' +
              '(relative paths start from the first connected folder). Omit it for a quick look: the capture goes to a new file ' +
              'under the hidden .xgen-captures folder and never overwrites the user\'s files.',
          },
          clear: { type: 'boolean' },
          timeout_ms: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_ADVANCED_TOOL,
      title: '브라우저 고급 조작',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Advanced browser controls: cookies, storage, upload/download, viewport/device, geolocation, offline, headers, credentials, media, network/HAR/interception, clipboard, or eval. Sensitive operations always require a local confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: {
            type: 'string',
            enum: [
              'cookies',
              'storage',
              'upload',
              'download',
              'viewport',
              'device',
              'geolocation',
              'offline',
              'headers',
              'credentials',
              'media',
              'network',
              'har',
              'intercept',
              'clipboard',
              'eval',
            ],
          },
          operation: { type: 'string' },
          ref: { type: 'string' },
          value: {},
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          expression: { type: 'string' },
          options: { type: 'object' },
          generation: { type: 'integer' },
          timeout_ms: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_FILL_TOOL,
      title: '칸 채우기',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Fill many fields of a form on a shared browser tab fast — pass that tab\'s page_id (BrowserTabs list, mode shared); it is brought to the front while filling. ' +
        'Each step is one short instruction in the user\'s language for EXACTLY ONE field ' +
        '(e.g. "판매가에 「12900」 입력해줘", "구매연령 전체로 바꿔줘", "협력사를 「플래티어 협력사」로 지정해줘", "대표이미지에 INNO-001_대표이미지.png 올려줘"). ' +
        'A local decision model runs the steps in order (a few seconds each, versus many seconds per BrowserInteract), handling dropdowns, ' +
        `search popups, collapsed sections and file uploads from the connected folders. Use at most ${MAX_FILL_STEPS} steps per call. ` +
        'Use it to put values into fields of the page that is open now — not for going to another page, pressing buttons that are not a field value, or reading the page. ' +
        'Every step names the field and the exact value, never a vague one ("자료에 맞는 것", "적절한 값"). ' +
        'A value you already have (from the data or the user) goes straight into a step as written — do not open a list, popup or tree first to see its choices; ' +
        'the step opens it, finds that value and picks it. ' +
        'Look at the choices with the other browser tools only when no value is given and you must choose one yourself, then put the chosen value in a step. ' +
        'Put the remaining fields in this call too rather than filling them one by one with BrowserInteract. ' +
        'A step naming two fields fills only one of them: write "공급원가에 「17430」 입력해줘" and "정상가에 「29900」 입력해줘" as two steps, not "공급원가 17430원, 정상가 29900원 입력해줘"; ' +
        'for checkbox groups, one step per box. ' +
        'Fields that already show the wanted value (a default radio or a box named "… (현재: 일반상품)") need no step; one sent anyway with its value in 「」 is left untouched and reported done with unchanged: true. ' +
        'Steps run in the order given: list the fields in screen order, top to bottom, so search-popup fields such as 협력사 and 표준카테고리 come before prices. ' +
        'A field that another choice turns on gets its own step after that choice: "구매제한을 제한으로 설정해줘", then "최대 구매제한 수량에 「5」 입력해줘" — not both in one step. ' +
        'Put every value to type inside 「」 so it is typed exactly ("제조사에 「이노데모 제조사 (가상)」 입력해줘") — unquoted, words that repeat the field name are dropped. ' +
        'For fields with a shown format (placeholder such as "YYYY.MM.DD. – YYYY.MM.DD."), write the value in that format ("판매기간에 「2026.11.10. – 2027.03.31.」 입력해줘"). ' +
        'Fields picked in a search popup (협력사, 브랜드 …) and file uploads are steps too ("브랜드를 「플래티어」로 지정해줘", "대표이미지에 상품이미지/a.png 올려줘") — ' +
        'the step opens the popup, searches, picks and applies — you do not need to do it by hand. ' +
        'For a supplied supplier/brand code, keep it with the name inside the value ("협력사를 「플래티어 협력사(1000002)」로 지정해줘"); the picker searches the name and matches both name and code. ' +
        'Never send verification requests such as 선택되어 있는지 확인해줘; use returned form_values. ' +
        'Returns complete, per-step results (done / failed / skipped), remaining_steps, and form_values read once after the batch. ' +
        'Results list a done step by its number i, the field it acted on and the value read from it (value, cut at 40 characters) — a later done row supersedes an earlier failed row for the same field; failed or skipped steps keep the step, the reason, the requested value and the value observed in the field. ' +
        'form_values has one line per field: name [type] [비활성] [형식 "…"]: "value" (type text and enabled fields carry no tag). ' +
        'Use these returned values directly; do not call BrowserFormValues or BrowserSnapshot just to recheck a completed batch. ' +
        'Do not replay done steps. For remaining_steps, compare form_values first: a failed step may already have applied. Retry only missing or incorrect values, grouping them in BrowserFill. ' +
        'Use BrowserSnapshot + BrowserInteract only when the returned values are unavailable or insufficient to resolve a remaining field. complete describes this batch, not whether the whole form is ready to save. ' +
        'Never include save/submit/approval steps (임시저장, 등록, 승인요청): ask the user first. ' +
        'Long text you write yourself (product detail, 상품상세) also goes in as a step with the text inside 「」 ("상품상세 내용에 「…」 입력해줘"), ' +
        'using real line breaks between paragraphs (not the two characters \\ and n) — it replaces the editor content and each line becomes a paragraph. ' +
        'Category trees are steps too, with the full path: "표준카테고리를 「문구/오피스 > 사무용품 전문관」으로 지정해줘" — the step opens the tree, expands each level and applies.',
      inputSchema: {
        type: 'object',
        properties: {
          ...sharedPageProperties,
          steps: { type: 'array', minItems: 1, maxItems: MAX_FILL_STEPS, items: { type: 'string' }, description: 'One instruction per field, in order.' },
        },
        required: ['page_id', 'steps'],
      },
    },
    {
      name: BROWSER_FORM_VALUES_TOOL,
      title: '입력값 확인',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Read every field of the form on a page: field label, current value, chosen radio/checkbox/option, placeholder and disabled state, ' +
        'plus fields picked in a search popup (협력사, 브랜드 …). Read-only. ' +
        'Use it before planning inputs, or when BrowserFill reports form_values_error. BrowserFill already returns current form_values; do not read them again after a batch. ' +
        'Pass the page_id of the tab to read (BrowserTabs list shows it).',
      inputSchema: {
        type: 'object',
        properties: { ...sharedPageProperties },
        required: ['page_id'],
      },
    },
  ];
}

const sensitiveSessionApprovals = new Set<string>();
const sensitive = new Set([
  'cookies',
  'storage',
  'upload',
  'download',
  'geolocation',
  'headers',
  'credentials',
  'intercept',
  'clipboard',
  'eval',
]);

async function approve(action: string, detail: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!sensitive.has(action) || sensitiveSessionApprovals.has(action)) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['거부', '이번만 허용', '이 앱 세션 동안 허용'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '브라우저 민감 작업 확인',
    message: `XGEN 에이전트가 브라우저의 ${action} 기능을 사용하려 합니다.`,
    detail: detail.slice(0, 1_000),
    signal,
  };
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.isVisible());
  // macOS cannot cancel an unparented message box.
  if (signal && !win && process.platform === 'darwin') return false;
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (signal?.aborted) return false;
  if (result.response === 2) sensitiveSessionApprovals.add(action);
  return result.response === 1 || result.response === 2;
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function workflow(
  args: Record<string, unknown>,
  context?: LocalToolCallContext,
): string {
  const trusted = String(context?.workflowId ?? '').trim();
  const requested = String(args.workflow_id ?? args.workflowId ?? '').trim();
  if (trusted && requested && trusted !== requested) {
    throw new BrowserRuntimeError(
      'browser_denied',
      '호출 workflow와 브라우저 workflow_id가 일치하지 않습니다.',
    );
  }
  const resolved = trusted || requested;
  if (!resolved) {
    throw new BrowserRuntimeError(
      'browser_no_page',
      '브라우저 호출 컨텍스트가 없습니다. 서버가 mcp_call.context.workflow_id를 전달해야 합니다.',
    );
  }
  return resolved;
}

function workflowName(
  args: Record<string, unknown>,
  context: LocalToolCallContext | undefined,
  workflowId: string,
): string {
  return String(
    context?.workflowName ?? args.workflow_name ?? args.workflowName ?? workflowId,
  ).trim() || workflowId;
}

function pageId(args: Record<string, unknown>): string | undefined {
  const value = String(args.page_id ?? args.pageId ?? '').trim();
  return value || undefined;
}

function timeout(args: Record<string, unknown>): number | undefined {
  const value = Number(args.timeout_ms ?? args.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 조작이 새 탭(팝업)을 열었으면 명령 결과에 붙인다. */
function runResult(run: { page: BrowserPageInfo; result: unknown; openedPages?: BrowserPageInfo[] }): LocalToolResult {
  if (!run.openedPages?.length) return result(run.page, run.result);
  return result(run.page, {
    ...(run.result as object),
    opened_pages: run.openedPages.map((page) => ({
      page_id: page.pageId, title: page.title, url: page.url, loading: page.loading,
    })),
    next_step: 'A new page opened. Use BrowserSnapshot with its opened_pages page_id. Do not click the opener again or call BrowserTabs to rediscover it.',
  });
}

function result(page: BrowserPageInfo | null, payload: unknown): LocalToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            workflow_id: page?.workflowId,
            page_id: page?.pageId,
            url: page?.url,
            title: page?.title,
            generation: page?.generation,
            result: payload,
          },
        ),
      },
    ],
  };
}

function appendValue(command: string[], value: unknown): void {
  if (value === undefined) return;
  command.push(typeof value === 'string' ? value : JSON.stringify(value));
}

function browserFileError(error: unknown, scratch: BrowserScratch, paths: ReadonlyMap<string, string>): BrowserRuntimeError {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = displayBrowserFileResult(raw, scratch, paths) as string;
  const code = error instanceof BrowserRuntimeError ? error.code : 'browser_denied';
  return new BrowserRuntimeError(code, clean.replace(/^browser_[a-z_]+:\s*/, ''));
}

async function runWithFileAbort<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
  cancel: () => Promise<void>,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  let cancelTask: Promise<void> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancelTask = cancel().catch(() => undefined);
      void cancelTask.then(() => reject(signal.reason ?? new Error('브라우저 파일 작업이 취소되었습니다.')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([run(), aborted]);
    if (signal.aborted) await cancelTask;
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (signal.aborted) await cancelTask;
    throw error;
  }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

const LOAD_STATES = new Set(['load', 'domcontentloaded', 'networkidle']);

/**
 * BrowserNavigate `wait` → agent-browser `wait` 인자. agent-browser 는 위치 인자를 **밀리초 아니면 선택자**로만
 * 읽어서, 도구 설명대로 `wait_for: "load"` 를 그대로 넘기면 `<load>` 요소를 25초 기다리다 실패했다(dev 30일
 * `wait load` 10번 모두 실패). 로드 상태는 `--load`, URL 은 `--url`, `text:` 를 붙인 글은 `--text` 로 옮긴다.
 */
export function browserWaitCommand(waitFor: unknown): string[] {
  const raw = waitFor === undefined ? '1000' : typeof waitFor === 'string' ? waitFor.trim() : JSON.stringify(waitFor);
  const lower = raw.toLowerCase();
  if (LOAD_STATES.has(lower)) return ['wait', '--load', lower];
  if (/^text:/i.test(raw)) return ['wait', '--text', raw.slice(5).trim()];
  if (/^url:/i.test(raw)) return ['wait', '--url', raw.slice(4).trim()];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('**')) return ['wait', '--url', raw];
  return ['wait', raw];
}

/** 대화 → 파일을 읽고 쓸 수 있는 폴더(그 대화에 연결된 폴더). */
export type BrowserFileRoots = (context?: LocalToolCallContext) => string[];

export class BrowserToolProvider {
  private enabled = false;
  private fileRoots: BrowserFileRoots = () => [];
  private fileScopes = new BrowserFileScopes();
  private revealSharedPage: (page: BrowserPageInfo) => void = () => {};
  private stepPost: () => DecisionPost | null = () => null;
  private stepping = new Set<string>();
  private askConfirm: ConfirmAsker | null = null;
  private confirmGrants = new ConfirmGrants();

  constructor(private runtime: BrowserRuntime) {}

  /**
   * 브라우저 도구 자체는 자기 설정(`enabled`)이 켠다. 다만 스크린샷·PDF·업로드·
   * 다운로드처럼 **이 PC 의 파일**을 만지는 동작은 파일 도구와 같은 범위 — 그
   * 대화에 연결된 폴더 — 안에서만 된다.
   */
  configure(
    enabled: boolean,
    fileRoots: BrowserFileRoots = () => [],
    revealSharedPage: (page: BrowserPageInfo) => void = () => {},
    stepPost: () => DecisionPost | null = () => null,
    askConfirm: ConfirmAsker | null = null,
  ): void {
    if (!enabled) this.fileScopes.clear();
    this.enabled = enabled;
    this.fileRoots = fileRoots;
    this.revealSharedPage = revealSharedPage;
    this.stepPost = stepPost;
    this.askConfirm = askConfirm;
  }

  /** 그 대화에 연결된 폴더 — 빠른 조작이 올릴 파일을 찾을 때(fast-act-upload). */
  roots(context?: LocalToolCallContext): string[] {
    return this.fileRoots(context);
  }

  clearBrowserFileGrants(interactionId?: string): void {
    this.fileScopes.clear(interactionId);
    this.confirmGrants.clear(interactionId);
  }

  /** 맨 위 대화상자가 사이트 확인창이면 그 문구·버튼. 읽지 못하면 null(그린 화면에서는 실패하지 않는다). */
  private async confirmDialog(wid: string, id: string): Promise<PageDialog | null> {
    try {
      const found = await this.runtime.pageScript<unknown>(wid, id, CONFIRM_DIALOG_SCRIPT, DIALOG_SCRIPT_MS);
      return isPageDialog(found) ? found : null;
    } catch (error) {
      diag('browser-confirm', `확인창 검사 생략 page=${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 조작 뒤 화면에 남은 대화상자와 경고 문구 — 없거나 읽지 못하면 빈 객체. */
  private async pageMessages(wid: string, id: string): Promise<PageMessages> {
    try {
      return (await this.runtime.pageScript<PageMessages>(wid, id, PAGE_MESSAGES_SCRIPT, DIALOG_SCRIPT_MS)) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * 확인창의 확정 버튼을 누를 명령이면 사용자에게 카드로 묻는다(browser-confirm). 허락하지 않으면 browser_denied 로 던진다 —
   * 다른 화면에서 보낸 턴, 카드를 띄울 수 없을 때, CONFIRM_WAIT_MS 안에 답이 없을 때도 누르지 않는다.
   */
  private async confirmGate(
    tool: string,
    wid: string,
    id: string | undefined,
    command: string[],
    context?: LocalToolCallContext,
  ): Promise<void> {
    if (!PRESS_COMMANDS.has(command[0] ?? '')) return;
    const page = await this.runtime.resolvePage(wid, id, true);
    const dialog = await this.confirmDialog(wid, page.info.pageId);
    if (!dialog) return;
    const press = confirmPress(dialog, { command, target: this.runtime.refTarget(page.info.pageId, command[1]) });
    if (!press || this.confirmGrants.has(wid, context?.interactionId, dialog)) return;
    diag('browser-confirm', 'ask', { tool, press, dialog: dialog.text.slice(0, 80), remote: !!context?.remote });
    if (context?.remote)
      throw new BrowserRuntimeError('browser_denied', declinedMessage(press, dialog, undefined, '다른 화면에서 보낸 요청이라 이 PC 에서 확인받지 못해'));
    const answer = await this.waitConfirm(
      {
        workflowId: wid,
        workflowName: context?.workflowName,
        interactionId: context?.interactionId,
        tool,
        dialog,
        press,
        pageTitle: page.info.title,
        pageUrl: page.info.url,
      },
      context?.signal,
    );
    diag('browser-confirm', 'answer', { choice: answer.choice, timedOut: !!answer.timedOut, said: !!answer.message });
    if (answer.choice === 'conversation') this.confirmGrants.add(wid, context?.interactionId, dialog);
    if (answer.choice !== 'deny') return;
    // 할 말을 남겼으면 그 말대로 하게 둔다(다시 눌러도 된다고 했을 수 있다). 말 없이 거절했거나 답이 없으면 사람의 거부로
    // 알려 같은 턴에 다시 묻지 않게 한다.
    if (answer.message) throw new BrowserRuntimeError('browser_denied', declinedMessage(press, dialog, answer.message));
    throw new ConfirmDeclined(declinedMessage(press, dialog, undefined, answer.timedOut ? `사용자가 ${CONFIRM_WAIT_MS / 1000}초 안에 답하지 않아` : undefined));
  }

  private async waitConfirm(request: Parameters<ConfirmAsker>[0], signal?: AbortSignal): Promise<ConfirmAnswer> {
    if (!this.askConfirm) return { choice: 'deny' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.askConfirm(request, controller.signal),
        new Promise<ConfirmAnswer>((resolve) => {
          timer = setTimeout(() => resolve({ choice: 'deny', timedOut: true }), CONFIRM_WAIT_MS);
        }),
      ]);
    } catch (error) {
      diag('browser-confirm', `카드 실패: ${error instanceof Error ? error.message : String(error)}`);
      return { choice: 'deny' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private scopeKey(context?: LocalToolCallContext): string {
    return context?.interactionId ?? context?.workflowId ?? 'legacy';
  }

  private fileSignal(context?: LocalToolCallContext): AbortSignal {
    const grantSignal = this.fileScopes.signal(this.scopeKey(context));
    return context?.signal ? AbortSignal.any([grantSignal, context.signal]) : grantSignal;
  }

  advertise(): LocalToolSchema[] {
    if (!this.enabled) return [];
    // BrowserFill·BrowserFormValues 는 빠른 조작(설정 fastAct·판단 모델)이 켜졌을 때만 — 꺼져 있으면 LLM 이 불렀다가 '판단 모델을 쓸 수 없다' 만 받는다.
    // BrowserFormValues 는 모델이 필요 없지만 BrowserFill 결과 확인용이라 같이 켜고 끈다.
    const fastOnly = [BROWSER_FILL_TOOL, BROWSER_FORM_VALUES_TOOL];
    // 단계 실행(step)은 광고하지 않는다 — 광고하면 LLM 이 BrowserFill 전에 step 으로 화면을 먼저 눌러 바꿨다(10/20 BO: 전시카테고리에
    // "플래티어" 줄이 생겨 협력사 지정이 그 칸을 눌렀다). 9d39783 처럼 BrowserFill 을 먼저 쓰게 한다.
    const schemas = browserToolSchemas();
    return fastActConfigured() ? schemas : schemas.filter((tool) => !fastOnly.includes(tool.name));
  }

  owns(tool: string): boolean {
    return BROWSER_TOOL_NAMES.has(tool);
  }

  async callTool(
    tool: string,
    raw: unknown,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    if (!this.enabled)
      throw new BrowserRuntimeError('browser_disabled', '브라우저 접근이 꺼져 있습니다.');
    const args = objectArgs(raw);
    if (tool === BROWSER_TABS_TOOL) return this.tabs(args, context);
    if (tool === BROWSER_NAVIGATE_TOOL) return this.navigate(args, context);
    if (tool === BROWSER_SNAPSHOT_TOOL) return this.snapshot(args, context);
    if (tool === BROWSER_INTERACT_TOOL) {
      if (args.action === 'step') return this.step(args, context);
      return this.interact(args, context);
    }
    if (tool === BROWSER_CAPTURE_TOOL) return this.capture(args, context);
    if (tool === BROWSER_ADVANCED_TOOL) return this.advanced(args, context);
    if (tool === BROWSER_FILL_TOOL) return this.fill(args, context);
    if (tool === BROWSER_FORM_VALUES_TOOL) return this.formValues(args, context);
    throw new Error(`unknown browser tool: ${tool}`);
  }

  private async tabs(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? 'list');
    const wid = workflow(args, context);
    if (action === 'list') {
      const active = this.runtime.state().activeByWorkflow;
      return result(null, this.runtime.list(wid || undefined).map(page => ({ ...page, active: active[page.workflowId] === page.pageId })));
    }
    if (action === 'create') {
      const mode = args.mode === 'shared' ? 'shared' : 'background';
      const page = await this.runtime.create({
        workflowId: wid,
        workflowName: workflowName(args, context, wid),
        mode,
        url: typeof args.url === 'string' ? args.url : undefined,
      });
      if (mode === 'shared') this.revealSharedPage(page);
      return result(page, { created: true });
    }
    const id = pageId(args);
    if (!id) throw new BrowserRuntimeError('browser_no_page', 'page_id가 필요합니다.');
    const page = this.runtime.get(id);
    if (!page || (wid && page.workflowId !== wid))
      throw new BrowserRuntimeError('browser_page_not_found', `페이지 ${id}를 찾지 못했습니다.`);
    if (action === 'close') {
      await this.runtime.close(id);
      return result(page, { closed: true });
    }
    if (action === 'activate') return result(this.runtime.activate(id), { activated: true });
    throw new BrowserRuntimeError('browser_denied', `지원하지 않는 BrowserTabs action: ${action}`);
  }

  private async navigate(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const wid = workflow(args, context);
    const id = pageId(args);
    const action = String(args.action ?? 'goto');
    const page = await this.runtime.resolvePage(wid, id, true);
    if (action !== 'wait') {
      const since = this.runtime.requestMark();
      const updated = await this.runtime.navigate({
        pageId: page.info.pageId,
        action: action as 'goto' | 'back' | 'forward' | 'reload' | 'stop',
        url: typeof args.url === 'string' ? args.url : undefined,
      });
      const after = action === 'stop' ? null : await this.pageAfter(wid, updated.pageId, { since, probeMs: DOCUMENT_REQUEST_PROBE_MS });
      return result(after?.page ?? updated, { navigated: action, ...after?.fields });
    }
    const command = browserWaitCommand(args.wait_for ?? args.waitFor);
    const run = await this.runtime.runAgentCommand(wid, page.info.pageId, command, timeout(args));
    return runResult(run);
  }

  private async snapshot(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const command = ['snapshot'];
    if (args.interactive_only !== false) command.push('-i');
    if (args.compact === true) command.push('-c');
    if (Number.isFinite(Number(args.depth)))
      command.push('--depth', String(Math.trunc(Number(args.depth))));
    const run = await this.runtime.runAgentCommand(
      workflow(args, context),
      pageId(args),
      command,
      timeout(args),
    );
    // refs 는 스냅샷 글의 [ref=eN] 줄을 역할·이름과 함께 한 번 더 적은 것이다 — 서버 LLM 에는 글만 준다.
    // 네이버 메일쓰기 화면 한 번에 15,000자 중 8,700자였고, 한 차례에 스냅샷이 여섯 번 쌓였다(10/20).
    const data = (run.result as { data?: Record<string, unknown> } | undefined)?.data;
    if (data && typeof data.snapshot === 'string') delete data.refs;
    return runResult(run);
  }

  private async interact(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? 'click');
    const ref = String(args.ref ?? '').trim();
    let command: string[];
    if (
      action === 'click' ||
      action === 'double_click' ||
      action === 'hover' ||
      action === 'check' ||
      action === 'uncheck'
    ) {
      if (!ref) throw new BrowserRuntimeError('browser_stale_ref', 'ref가 필요합니다.');
      command = [action === 'double_click' ? 'dblclick' : action, ref];
    } else if (action === 'fill' || action === 'type') {
      if (!ref) throw new BrowserRuntimeError('browser_stale_ref', 'ref가 필요합니다.');
      const text = args.text ?? args.value;
      if (typeof text !== 'string') throw new BrowserRuntimeError('browser_denied', `${action}: 입력할 문자열을 text에 지정하세요.`);
      command = [action, ref, text];
    } else if (action === 'keypress') {
      command = ['press', String(args.key ?? args.value ?? '')];
    } else if (action === 'select') {
      if (!ref) throw new BrowserRuntimeError('browser_stale_ref', 'ref가 필요합니다.');
      command = ['select', ref];
      appendValue(command, args.value);
    } else if (action === 'drag') {
      command = ['drag', ref, String(args.target_ref ?? args.targetRef ?? '')];
    } else if (action === 'scroll') {
      command = ref
        ? ['scrollintoview', ref]
        : ['scroll', String(args.direction ?? 'down'), String(Number(args.amount) || 500)];
    } else if (action === 'mouse') {
      command = ['mouse', String(args.operation ?? 'move')];
      for (const value of [args.x, args.y, args.button]) appendValue(command, value);
    } else {
      throw new BrowserRuntimeError(
        'browser_denied',
        `지원하지 않는 BrowserInteract action: ${action}`,
      );
    }
    const generation = Number.isFinite(Number(args.generation))
      ? Number(args.generation)
      : undefined;
    const wid = workflow(args, context);
    await this.confirmGate(BROWSER_INTERACT_TOOL, wid, pageId(args), command, context);
    const before = PAGE_MOVING_ACTIONS.has(action)
      ? (await this.runtime.resolvePage(wid, pageId(args), true)).info.generation
      : undefined;
    const since = before === undefined ? undefined : this.runtime.requestMark();
    const run = await this.runtime.runAgentCommand(
      wid,
      pageId(args),
      command,
      timeout(args),
      generation,
      { signal: context?.signal },
    );
    if (before === undefined || run.openedPages?.length || (run.result as { popup_closed?: unknown } | null)?.popup_closed)
      return runResult(run);
    const after = await this.pageAfter(wid, run.page.pageId, { before, since, signal: context?.signal });
    // 누른 뒤 뜬 창·경고 문구 — 없으면 막힌 저장을 모델이 모른 채 다시 눌렀다(10/22 trace 54448: 필수 칸 검사에 두 번 막힘).
    const messages = context?.signal?.aborted ? {} : await this.pageMessages(wid, (after?.page ?? run.page).pageId);
    if (after) return result(after.page, { ...(run.result as object), ...after.fields, ...messages });
    return Object.keys(messages).length ? result(run.page, { ...(run.result as object), ...messages }) : runResult(run);
  }

  /**
   * 페이지를 옮긴 조작 뒤의 화면 — 조작이 시작한 문서·요청이 끝나면(settle) interactive 스냅샷을 떠서 결과에
   * 붙일 값으로 돌려준다. before(조작 전 generation)를 주면 페이지가 그대로일 때 null: 스냅샷은 generation 을
   * 올려 앞 스냅샷의 ref 를 무효로 만드니, 페이지가 안 바뀌었으면 모델이 들고 있는 ref 를 살려 둔다. 스냅샷이
   * 실패하거나 사용자가 멈춰도 null — 조작은 이미 끝났으니 조작 결과만 돌려준다.
   */
  private async pageAfter(
    wid: string,
    id: string,
    options: { before?: number; since?: number; probeMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ page: BrowserPageInfo; fields: Record<string, unknown> } | null> {
    const { before, since, probeMs, signal } = options;
    await this.runtime.settle(id, { since, probeMs, signal });
    if (before !== undefined) {
      if (this.runtime.get(id)?.generation === before) return null;
      // 옮겨 간 화면도 이동과 같다 — 새 화면의 스크립트가 데이터를 부를 틈을 준다. BO 공지 '더보기'는 경로가 바뀐
      // 직후 읽으면 22자(목록 없음), 1.5초 뒤엔 5,645자였다(10/24 실측).
      await this.runtime.settle(id, { since, probeMs: DOCUMENT_REQUEST_PROBE_MS, signal });
    }
    if (signal?.aborted) return null;
    try {
      const run = await this.runtime.runAgentCommand(wid, id, ['snapshot', '-i', '-c'], PAGE_AFTER_TIMEOUT_MS);
      const text = (run.result as { data?: { snapshot?: unknown } } | null)?.data?.snapshot;
      if (typeof text !== 'string') return null;
      if (text.length <= PAGE_AFTER_MAX_CHARS) return { page: run.page, fields: { snapshot: text } };
      const cut = text.lastIndexOf('\n', PAGE_AFTER_MAX_CHARS);
      return {
        page: run.page,
        fields: {
          snapshot: text.slice(0, cut > 0 ? cut : PAGE_AFTER_MAX_CHARS),
          snapshot_truncated: `Showing the first ${PAGE_AFTER_MAX_CHARS} of ${text.length} characters. Call BrowserSnapshot for the whole page.`,
        },
      };
    } catch (error) {
      diag('browser-agent', `조작 뒤 스냅샷 생략 page=${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async step(args: Record<string, unknown>, context?: LocalToolCallContext): Promise<LocalToolResult> {
    const wid = workflow(args, context);
    const post = this.stepPost();
    if (!post) throw new BrowserRuntimeError('browser_disabled', '단계 실행에 사용할 decider가 없습니다. 단계별 브라우저 조작 설정과 판단 API를 확인하세요.');
    if (this.stepping.has(wid)) throw new BrowserRuntimeError('browser_denied', '이 브라우저의 이전 단계 결과를 기다린 뒤 다음 단계를 호출하세요.');
    this.stepping.add(wid);
    try {
      if (context?.signal?.aborted) throw new Error('Browser step cancelled.');
      const state = this.runtime.state();
      const id = pageId(args) ?? state.activeByWorkflow[wid];
      const page = await this.runtime.resolvePage(wid, id, false);
      // 판단 모델이 고르는 단계는 확인창 버튼을 묻지 않고 누를 수 있다 — 확인창이 떠 있으면 BrowserInteract 로 넘긴다.
      const dialog = await this.confirmDialog(wid, page.info.pageId);
      if (dialog)
        throw new BrowserRuntimeError('browser_denied', `확인창이 떠 있습니다("${dialog.text.slice(0, 80)}", 버튼 ${dialog.buttons.join('·')}). 누르려면 BrowserInteract click 을 쓰세요 — 확정 버튼은 사용자 확인을 받습니다.`);
      const done = await executeBrowserStep(this.runtime, post, page.info, args, this.revealSharedPage, allowsDeciderAction, context?.signal);
      diag('browser-step', 'result', { operation: args.operation, status: done.result.status, mutation_attempted: done.result.mutation_attempted });
      return { ...result(done.page, done.result), isError: done.result.status !== 'completed' };
    } finally {
      this.stepping.delete(wid);
    }
  }

  private async scopedPath(raw: unknown, context: LocalToolCallContext | undefined, allowMissing: boolean) {
    const roots = this.fileRoots(context);
    if (!roots.length) {
      throw new BrowserRuntimeError(
        'browser_denied',
        '이 대화에 연결된 폴더가 없어 이 PC 에 파일을 저장하거나 올릴 수 없습니다.',
      );
    }
    try {
      return await this.fileScopes.resolve(raw, this.scopeKey(context), roots, allowMissing);
    } catch (error) {
      throw new BrowserRuntimeError('browser_denied', error instanceof Error ? error.message : String(error));
    }
  }

  private async capture(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? 'screenshot');
    let command: string[];
    if (action === 'screenshot' || action === 'full_screenshot' || action === 'pdf') {
      // 경로를 안 주면 숨은 폴더에 새 이름으로 — 예전 기본값 browser.png 는 연결 폴더 맨 위의 같은 파일을 캡처마다 덮어썼다(10/19).
      // LLM 은 결과로 이미지를 받지 못해 그 파일을 가져가 보므로 연결 폴더 안이어야 한다.
      // ponytail: 캡처가 쌓이기만 한다 — 많아지면 오래된 것을 지운다.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fallback = `${CAPTURE_DIR}/${action}-${stamp}.${action === 'pdf' ? 'pdf' : 'png'}`;
      let target = await this.scopedPath(args.path ?? fallback, context, true);
      // 있는 파일은 덮어쓰지 않는다 — LLM 이 경로를 browser.png 로 정해 캡처마다 같은 파일을 덮어썼다(10/19). 결과의 path 로 알린다.
      if (args.path !== undefined && exists(target)) {
        target = await this.scopedPath(String(args.path).replace(/(\.[^./\\]+)?$/, `-${stamp}$1`), context, true);
      }
      const signal = this.fileSignal(context);
      const page = await runWithFileAbort(signal, () =>
        this.runtime.resolvePage(workflow(args, context), pageId(args), true), async () => undefined);
      const scratch = await BrowserScratch.create();
      const privatePath = scratch.path(action === 'pdf' ? 'capture.pdf' : 'capture.png');
      command = [action === 'full_screenshot' ? 'screenshot' : action, privatePath];
      if (action === 'full_screenshot') command.push('--full');
      try {
        const run = await runWithFileAbort(signal, () => this.runtime.runAgentCommand(
          workflow(args, context), page.info.pageId, command, timeout(args),
        ), () => this.runtime.cancelAgentCommand(page.info.pageId));
        await scratch.commit(action === 'pdf' ? 'capture.pdf' : 'capture.png', target, signal);
        return result(run.page, displayBrowserFileResult(run.result, scratch, new Map([[privatePath, target.displayPath]])));
      } catch (error) {
        throw browserFileError(error, scratch, new Map([[privatePath, target.displayPath]]));
      } finally {
        await scratch.cleanup();
      }
    } else if (action === 'console' || action === 'errors') {
      command = [action];
      if (args.clear === true) command.push('--clear');
    } else {
      throw new BrowserRuntimeError(
        'browser_denied',
        `지원하지 않는 BrowserCapture action: ${action}`,
      );
    }
    const run = await this.runtime.runAgentCommand(
      workflow(args, context),
      pageId(args),
      command,
      timeout(args),
    );
    return result(run.page, command[1] && action !== 'console' && action !== 'errors' ? { path: command[1], ...objectArgs(run.result) } : run.result);
  }

  private async fill(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    if (context?.remote) throw new BrowserRuntimeError('browser_denied', 'BrowserFill 은 이 PC에서 보낸 요청에서만 실행할 수 있습니다.');
    if (!Array.isArray(args.steps) || args.steps.some(s => typeof s !== 'string') || args.steps.length > MAX_FILL_STEPS)
      throw new BrowserRuntimeError('browser_denied', `steps 는 ${MAX_FILL_STEPS}줄 이하의 문자열 배열이어야 합니다.`);
    const steps = (Array.isArray(args.steps) ? args.steps : []).map((s) => String(s).trim()).filter(Boolean);
    if (!steps.length) throw new BrowserRuntimeError('browser_denied', 'steps 가 비었습니다.');
    const wid = workflow(args, context);
    // 공유 탭은 page_id 를 밝혀야만 다룬다(formValues 와 같다) — 보이는 탭을 짐작해 바꾸지 않는다.
    const id = pageId(args);
    if (!id) throw new BrowserRuntimeError('browser_no_page', 'page_id 가 필요합니다 — BrowserTabs list 로 폼이 열린 공유 탭의 page_id 를 확인하세요.');
    const originalPage = this.runtime.get(id);
    if (this.stepping.has(wid)) throw new BrowserRuntimeError('browser_denied', '이 브라우저의 이전 단계 결과를 기다린 뒤 다음 단계를 호출하세요.');
    this.stepping.add(wid);
    try {
      const results = await runSteps(wid, id, context?.interactionId, steps, context?.signal, context?.deadlineAt);
      let form_values: unknown = null;
      let form_values_error: string | undefined;
      try {
        const remainingMs = (context?.deadlineAt ?? Infinity) - Date.now();
        if (context?.signal?.aborted || remainingMs <= 0) throw new Error('입력이 중단되었거나 시간 한도에 도달했습니다.');
        form_values = await this.runtime.pageScript(wid, id, FORM_VALUES_SCRIPT, Math.min(5_000, remainingMs));
      } catch (error) {
        // Reading the final state must not erase partial input results or invite a full replay.
        form_values_error = error instanceof Error ? error.message : String(error);
      }
      const messages = context?.signal?.aborted ? {} : await this.pageMessages(wid, id);
      return result(this.runtime.get(id) ?? originalPage ?? null, {
        ...messages,
        complete: results.every((r) => r.status === 'done'),
        results: briefResults(results),
        remaining_steps: results.filter((r) => r.status !== 'done' && !r.read_only).map((r) => r.step),
        form_values: formLines(form_values),
        ...(form_values_error ? { form_values_error } : {}),
        recovery: 'For read_only steps, inspect the returned form_values; do not retry them as mutations. Use form_values as the final observed state; do not read the whole form again. Do not repeat done steps. For remaining_steps, retry only values still missing or incorrect; failed steps may already have applied. If form_values_error is present, read current values before retrying. If complete, report the result without another verification call.',
      });
    } finally {
      this.stepping.delete(wid);
    }
  }

  private async formValues(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const wid = workflow(args, context);
    // 공유 탭은 page_id 를 밝혀야만 읽는다(browser-runtime resolvePage 와 같은 원칙) — 보이는 탭을 짐작해 읽지 않는다.
    const id = pageId(args);
    if (!id) throw new BrowserRuntimeError('browser_no_page', 'page_id 가 필요합니다 — BrowserTabs list 로 읽을 탭의 page_id 를 확인하세요.');
    const page = await this.runtime.resolvePage(wid, id, false);
    const fields = await this.runtime.pageScript(wid, page.info.pageId, FORM_VALUES_SCRIPT, timeout(args) ?? 5_000);
    return result(page.info, formLines(fields));
  }

  private async advanced(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const requestedAction = String(args.action ?? '');
    const supportedActions = new Set([
      'cookies', 'storage', 'upload', 'download', 'viewport', 'device', 'geolocation', 'offline',
      'headers', 'credentials', 'media', 'network', 'har', 'intercept', 'clipboard', 'eval',
    ]);
    if (!supportedActions.has(requestedAction)) {
      throw new BrowserRuntimeError('browser_denied', '지원하지 않는 브라우저 고급 작업입니다.');
    }
    // The helper also accepts network har; normalize that alias before any path handling.
    const harAlias = requestedAction === 'network' && String(args.operation ?? '').trim() === 'har';
    const action = harAlias ? 'har' : requestedAction;
    if (!(await approve(action, JSON.stringify(args), this.runtime.actionSignal ?? context?.signal))) {
      throw new BrowserRuntimeError('browser_denied', `사용자가 ${action} 작업을 거부했습니다.`);
    }
    const operation = String(harAlias ? args.value ?? '' : args.operation ?? '').trim();
    let command: string[] = [action];
    if (operation) command.push(operation);

    let scratch: BrowserScratch | undefined;
    let outputTarget: Awaited<ReturnType<BrowserFileScopes['resolve']>> | undefined;
    let outputName = '';
    let electronName = '';
    let fileSignal: AbortSignal | undefined;
    const pathDisplays = new Map<string, string>();
    if (action === 'upload') {
      const paths = Array.isArray(args.paths) ? args.paths : [args.path];
      if (!paths.length || paths.some((path) => typeof path !== 'string' || !path.trim())) {
        throw new BrowserRuntimeError('browser_denied', '업로드할 파일 경로가 필요합니다.');
      }
      const sources = await Promise.all(paths.map((path) => this.scopedPath(path, context, false)));
      fileSignal = this.fileSignal(context);
      scratch = await BrowserScratch.create();
      command = ['upload', String(args.ref ?? '')];
      try {
        for (let i = 0; i < sources.length; i++) {
          const privatePath = await scratch.uploadFrom(sources[i], i, fileSignal);
          pathDisplays.set(privatePath, sources[i].displayPath);
          command.push(privatePath);
        }
      } catch (error) {
        await scratch.cleanup();
        throw error;
      }
    } else if (action === 'download') {
      outputTarget = await this.scopedPath(args.path, context, true);
      fileSignal = this.fileSignal(context);
      const page = await runWithFileAbort(fileSignal, () =>
        this.runtime.resolvePage(workflow(args, context), pageId(args), true), async () => undefined);
      scratch = await BrowserScratch.create();
      outputName = 'helper-download';
      electronName = 'electron-download';
      command = ['download', String(args.ref ?? ''), scratch.path(outputName)];
      pathDisplays.set(scratch.path(outputName), outputTarget.displayPath);
      pathDisplays.set(scratch.path(electronName), outputTarget.displayPath);
      args = { ...args, page_id: page.info.pageId };
    } else if (action === 'eval') {
      command = ['eval', String(args.expression ?? args.value ?? '')];
    } else if (action === 'cookies') {
      const options = objectArgs(args.options);
      if (operation === 'set') {
        command = ['cookies', 'set', String(options.name ?? ''), String(options.value ?? '')];
        for (const [key, flag] of [
          ['url', '--url'],
          ['domain', '--domain'],
          ['path', '--path'],
          ['sameSite', '--sameSite'],
          ['expires', '--expires'],
        ] as const) {
          if (options[key] !== undefined) command.push(flag, String(options[key]));
        }
        if (options.httpOnly === true) command.push('--httpOnly');
        if (options.secure === true) command.push('--secure');
      } else {
        command = ['cookies', operation || 'get'];
      }
    } else if (action === 'storage') {
      const options = objectArgs(args.options);
      const kind = String(options.kind ?? 'local');
      command = ['storage', kind, operation || 'get'];
      appendValue(command, options.key);
      if ((operation || 'get') === 'set') appendValue(command, options.value ?? args.value);
    } else if (action === 'viewport') {
      const options = objectArgs(args.options);
      command = ['set', 'viewport', String(options.width ?? 1280), String(options.height ?? 720)];
    } else if (action === 'device') {
      command = ['set', 'device', String(args.value ?? objectArgs(args.options).name ?? '')];
    } else if (action === 'geolocation') {
      const options = objectArgs(args.options);
      command = ['set', 'geo', String(options.latitude ?? ''), String(options.longitude ?? '')];
    } else if (action === 'offline') {
      command = ['set', 'offline', String(args.value ?? true)];
    } else if (action === 'headers') {
      command = ['set', 'headers', JSON.stringify(args.value ?? args.options ?? {})];
    } else if (action === 'credentials') {
      const options = objectArgs(args.options);
      command = [
        'set',
        'credentials',
        String(options.username ?? ''),
        String(options.password ?? ''),
      ];
    } else if (action === 'media') {
      command = ['set', 'media', String(args.value ?? operation ?? '')];
    } else if (action === 'har') {
      if (operation !== 'start' && operation !== 'stop') {
        throw new BrowserRuntimeError('browser_denied', 'HAR 작업은 start 또는 stop이어야 합니다.');
      }
      command = ['network', 'har', operation];
      if (operation === 'stop') {
        outputTarget = await this.scopedPath(args.path ?? 'browser.har', context, true);
        fileSignal = this.fileSignal(context);
        scratch = await BrowserScratch.create();
        outputName = 'capture.har';
        command.push(scratch.path(outputName));
        pathDisplays.set(scratch.path(outputName), outputTarget.displayPath);
      }
    } else if (action === 'intercept') {
      command = ['network', 'route'];
      appendValue(command, args.value ?? args.options);
    } else if (action === 'network') {
      if (operation && operation !== 'requests' && operation !== 'request') {
        throw new BrowserRuntimeError('browser_denied', '지원하지 않는 네트워크 조회 작업입니다.');
      }
      command = ['network', operation || 'requests'];
      appendValue(command, args.value ?? args.options);
    } else if (action === 'clipboard') {
      command = ['clipboard', operation || 'read'];
      appendValue(command, args.value);
    } else {
      appendValue(command, args.value ?? args.options);
    }
    const generation = Number.isFinite(Number(args.generation))
      ? Number(args.generation)
      : undefined;
    try {
      const pinnedPage = scratch ? await runWithFileAbort(fileSignal!, () =>
        this.runtime.resolvePage(workflow(args, context), pageId(args), true), async () => undefined) : undefined;
      const run = action === 'download'
        ? await runWithFileAbort(fileSignal!, () => this.runtime.runDownloadCommand(
          workflow(args, context), pinnedPage!.info.pageId, command, scratch!.path(electronName), timeout(args), generation,
        ), () => this.runtime.cancelAgentCommand(pinnedPage!.info.pageId))
        : scratch
          ? await runWithFileAbort(fileSignal!, () => this.runtime.runAgentCommand(
            workflow(args, context), pinnedPage!.info.pageId, command, timeout(args), generation,
          ), () => this.runtime.cancelAgentCommand(pinnedPage!.info.pageId))
          : await this.runtime.runAgentCommand(
            workflow(args, context), pageId(args), command, timeout(args), generation,
          );
      if (outputTarget && scratch) {
        const committedName = action === 'download' && 'electronSaved' in run && run.electronSaved
          ? electronName : outputName;
        await scratch.commit(committedName, outputTarget, fileSignal);
      }
      return scratch ? result(run.page, displayBrowserFileResult(run.result, scratch, pathDisplays)) : runResult(run);
    } catch (error) {
      if (scratch) throw browserFileError(error, scratch, pathDisplays);
      throw error;
    } finally {
      await scratch?.cleanup();
    }
  }
}

let provider: BrowserToolProvider | null = null;

export function getBrowserToolProvider(runtime: BrowserRuntime): BrowserToolProvider {
  if (!provider) provider = new BrowserToolProvider(runtime);
  return provider;
}
