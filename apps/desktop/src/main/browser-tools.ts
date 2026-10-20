import { BrowserWindow, dialog } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { browserPathWithinRoots } from './browser-security';
import { BrowserRuntime, BrowserRuntimeError } from './browser-runtime';
import { allowsDeciderAction, type DecisionPost } from './fast-act';
import { BROWSER_STEP_GUIDE, browserStepProperties, executeBrowserStep } from './browser-step';
import { diag } from './diag-log';
import { BROWSER_COMMIT_GUIDE } from './browser-action-guard';
import { fastActConfigured } from './fast-act-runner';
import { FORM_VALUES_SCRIPT } from './fast-act-labels';
import { MAX_FILL_STEPS } from './fast-act-batch';
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
      annotations: { readOnlyHint: false, openWorldHint: true },
      description: 'Navigate one XGEN browser page: goto/back/forward/reload/stop/wait.',
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
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        (steps ? `${BROWSER_STEP_GUIDE} ` : '') +
        'Interact with a page using refs from BrowserSnapshot: click/fill/type/keypress/select/check/uncheck/hover/drag/scroll/mouse. ' + BROWSER_COMMIT_GUIDE,
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
          generation: { type: 'integer', description: 'Generation returned by BrowserSnapshot.' },
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
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Advanced browser controls: cookies, storage, upload/download, viewport/device, geolocation, offline, headers, credentials, media, network/HAR/interception, clipboard, or eval. Sensitive operations always require a local confirmation. ' + BROWSER_COMMIT_GUIDE,
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
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Fill many fields of a form on a shared browser tab fast — pass that tab\'s page_id (BrowserTabs list, mode shared); it is brought to the front while filling. ' +
        'Each step is one short instruction in the user\'s language for EXACTLY ONE field ' +
        '(e.g. "판매가에 「12900」 입력해줘", "구매연령 전체로 바꿔줘", "협력사를 플래티어 협력사로 지정해줘", "대표이미지에 INNO-001_대표이미지.png 올려줘"). ' +
        'A local decision model runs the steps in order (a few seconds each, versus many seconds per BrowserInteract), handling dropdowns, ' +
        `search popups, collapsed sections and file uploads from the connected folders. Use at most ${MAX_FILL_STEPS} steps per call. ` +
        'Use it to put values into fields of the page that is open now — not for going to another page, pressing buttons that are not a field value, or reading the page. ' +
        'Every step names the field and the exact value, never a vague one ("자료에 맞는 것", "적절한 값"). ' +
        'If you need to look at the choices to decide a value (a list, popup or tree), look first with the other browser tools, then put the decided value in a step — the step makes the pick itself. ' +
        'Put the remaining fields in this call too rather than filling them one by one with BrowserInteract. ' +
        'A step naming two fields fills only one of them: write "공급원가에 「17430」 입력해줘" and "정상가에 「29900」 입력해줘" as two steps, not "공급원가 17430원, 정상가 29900원 입력해줘"; ' +
        'for checkbox groups, one step per box. ' +
        'Skip fields that already show the wanted value (a default radio or a box named "… (현재: 일반상품)") — each step costs seconds. ' +
        'A field that another choice turns on gets its own step after that choice: "구매제한을 제한으로 설정해줘", then "최대 구매제한 수량에 「5」 입력해줘" — not both in one step. ' +
        'Put every value to type inside 「」 so it is typed exactly ("제조사에 「이노데모 제조사 (가상)」 입력해줘") — unquoted, words that repeat the field name are dropped. ' +
        'For fields with a shown format (placeholder such as "YYYY.MM.DD. – YYYY.MM.DD."), write the value in that format ("판매기간에 「2026.11.10. – 2027.03.31.」 입력해줘"). ' +
        'Fields picked in a search popup (협력사, 브랜드 …) and file uploads are steps too ("브랜드를 플래티어로 지정해줘", "대표이미지에 상품이미지/a.png 올려줘") — ' +
        'the step opens the popup, searches, picks and applies — you do not need to do it by hand. ' +
        'Returns complete (true only when every step is done — a step is done only when the value was read back on the page) and per-step status: done / failed / skipped (with the reason). Unless complete, the request is not finished — finish the failed steps yourself with BrowserSnapshot + BrowserInteract. ' +
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Read every field of the form on a page: field label, current value, chosen radio/checkbox/option, placeholder and disabled state, ' +
        'plus fields picked in a search popup (협력사, 브랜드 …). Read-only. ' +
        'Use it to see what a form holds before deciding steps, and to check the result after BrowserFill — instead of BrowserAdvanced eval. ' +
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

async function approve(action: string, detail: string): Promise<boolean> {
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
  };
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.isVisible());
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
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
          null,
          2,
        ),
      },
    ],
  };
}

function appendValue(command: string[], value: unknown): void {
  if (value === undefined) return;
  command.push(typeof value === 'string' ? value : JSON.stringify(value));
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
  private revealSharedPage: (page: BrowserPageInfo) => void = () => {};
  private stepPost: () => DecisionPost | null = () => null;
  private stepping = new Set<string>();

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
  ): void {
    this.enabled = enabled;
    this.fileRoots = fileRoots;
    this.revealSharedPage = revealSharedPage;
    this.stepPost = stepPost;
  }

  /** 그 대화에 연결된 폴더 — 빠른 조작이 올릴 파일을 찾을 때(fast-act-upload). */
  roots(context?: LocalToolCallContext): string[] {
    return this.fileRoots(context);
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
      const updated = await this.runtime.navigate({
        pageId: page.info.pageId,
        action: action as 'goto' | 'back' | 'forward' | 'reload' | 'stop',
        url: typeof args.url === 'string' ? args.url : undefined,
      });
      return result(updated, { navigated: action });
    }
    const command = browserWaitCommand(args.wait_for ?? args.waitFor);
    const run = await this.runtime.runAgentCommand(wid, page.info.pageId, command, timeout(args));
    return result(run.page, run.result);
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
    return result(run.page, run.result);
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
    const run = await this.runtime.runAgentCommand(
      workflow(args, context),
      pageId(args),
      command,
      timeout(args),
      generation,
      { interactionId: context?.interactionId, signal: context?.signal },
    );
    return result(run.page, run.result);
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
      const done = await executeBrowserStep(this.runtime, post, page.info, args, this.revealSharedPage, allowsDeciderAction, context?.signal, context?.interactionId);
      diag('browser-step', 'result', { operation: args.operation, status: done.result.status, mutation_attempted: done.result.mutation_attempted });
      return { ...result(done.page, done.result), isError: done.result.status !== 'completed' };
    } finally {
      this.stepping.delete(wid);
    }
  }

  private scopedPath(raw: unknown, context?: LocalToolCallContext): string {
    const roots = this.fileRoots(context);
    if (!roots.length) {
      throw new BrowserRuntimeError(
        'browser_denied',
        '이 대화에 연결된 폴더가 없어 이 PC 에 파일을 저장하거나 올릴 수 없습니다.',
      );
    }
    const path = browserPathWithinRoots(raw, roots);
    if (!path)
      throw new BrowserRuntimeError('browser_denied', '파일 경로가 이 대화에 연결된 폴더 밖입니다.');
    return path;
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
      let path = this.scopedPath(args.path ?? fallback, context);
      // 있는 파일은 덮어쓰지 않는다 — LLM 이 경로를 browser.png 로 정해 캡처마다 같은 파일을 덮어썼다(10/19). 결과의 path 로 알린다.
      if (existsSync(path)) path = path.replace(/(\.[^./\\]+)?$/, `-${stamp}$1`);
      mkdirSync(dirname(path), { recursive: true });
      command = [action === 'full_screenshot' ? 'screenshot' : action, path];
      if (action === 'full_screenshot') command.push('--full');
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
    // fast-act-voice 가 이 파일을 가져다 쓰므로 부를 때 가져온다(순환 참조).
    const { runSteps } = await import('./fast-act-batch');
    const wid = workflow(args, context);
    // 공유 탭은 page_id 를 밝혀야만 다룬다(formValues 와 같다) — 보이는 탭을 짐작해 바꾸지 않는다.
    const id = pageId(args);
    if (!id) throw new BrowserRuntimeError('browser_no_page', 'page_id 가 필요합니다 — BrowserTabs list 로 폼이 열린 공유 탭의 page_id 를 확인하세요.');
    const originalPage = this.runtime.get(id);
    if (this.stepping.has(wid)) throw new BrowserRuntimeError('browser_denied', '이 브라우저의 이전 단계 결과를 기다린 뒤 다음 단계를 호출하세요.');
    this.stepping.add(wid);
    let results;
    try {
      results = await runSteps(wid, id, context?.interactionId, steps, context?.signal, context?.deadlineAt);
    } finally {
      this.stepping.delete(wid);
    }
    // 요청 전체는 모든 줄이 done 일 때만 마친 것이다 — 한 줄이라도 못 했으면 LLM 이 마저 해야 한다.
    const page = this.runtime.get(id);
    return result(page ?? originalPage ?? null, { complete: results.every((r) => r.status === 'done'), results,
      recovery: 'done 줄은 반복하지 마세요. failed 줄은 일부 반영됐을 수 있으므로 현재 값을 먼저 읽고, failed·skipped의 남은 작업만 BrowserSnapshot과 BrowserInteract로 완료하세요.' });
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
    return result(page.info, fields);
  }

  private async advanced(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? '');
    if (!(await approve(action, JSON.stringify(args)))) {
      throw new BrowserRuntimeError('browser_denied', `사용자가 ${action} 작업을 거부했습니다.`);
    }
    const operation = String(args.operation ?? '').trim();
    let command: string[] = [action];
    if (operation) command.push(operation);

    if (action === 'upload') {
      const paths = Array.isArray(args.paths) ? args.paths : [args.path];
      command = ['upload', String(args.ref ?? '')];
      for (const path of paths) command.push(this.scopedPath(path, context));
    } else if (action === 'download') {
      const path = this.scopedPath(args.path, context);
      const page = await this.runtime.resolvePage(workflow(args, context), pageId(args), true);
      this.runtime.allowNextDownload(page.info.pageId, path);
      command = ['download', String(args.ref ?? ''), path];
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
      command = ['network', operation || 'har'];
      if (args.path !== undefined) command.push(this.scopedPath(args.path, context));
    } else if (action === 'intercept') {
      command = ['network', 'route'];
      appendValue(command, args.value ?? args.options);
    } else if (action === 'network') {
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
    const run = await this.runtime.runAgentCommand(
      workflow(args, context),
      pageId(args),
      command,
      timeout(args),
      generation,
    );
    return result(run.page, run.result);
  }
}

let provider: BrowserToolProvider | null = null;

export function getBrowserToolProvider(runtime: BrowserRuntime): BrowserToolProvider {
  if (!provider) provider = new BrowserToolProvider(runtime);
  return provider;
}
