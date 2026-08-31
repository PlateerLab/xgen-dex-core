import { BrowserWindow, dialog } from 'electron';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { browserPathWithinRoots } from './browser-security';
import { BrowserRuntime, BrowserRuntimeError } from './browser-runtime';
import type {
  LocalToolCallContext,
  LocalToolResult,
  LocalToolSchema,
} from './local-tools';

export const BROWSER_TABS_TOOL = 'BrowserTabs';
export const BROWSER_NAVIGATE_TOOL = 'BrowserNavigate';
export const BROWSER_SNAPSHOT_TOOL = 'BrowserSnapshot';
export const BROWSER_INTERACT_TOOL = 'BrowserInteract';
export const BROWSER_CAPTURE_TOOL = 'BrowserCapture';
export const BROWSER_ADVANCED_TOOL = 'BrowserAdvanced';

export const BROWSER_TOOL_NAMES = new Set([
  BROWSER_TABS_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_INTERACT_TOOL,
  BROWSER_CAPTURE_TOOL,
  BROWSER_ADVANCED_TOOL,
]);

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

export function browserToolSchemas(): LocalToolSchema[] {
  return [
    {
      name: BROWSER_TABS_TOOL,
      description:
        'Manage XGEN browser pages on the user desktop. Use create with mode shared to open and reveal a visible browser tab without asking the user to open it first; background is agent-only. ' +
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
      description: 'Navigate one XGEN browser page: goto/back/forward/reload/stop/wait.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload', 'stop', 'wait'] },
          url: { type: 'string' },
          wait_for: {
            type: 'string',
            description: 'wait: milliseconds, text, URL glob, selector, or load state.',
          },
          timeout_ms: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_SNAPSHOT_TOOL,
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
      description:
        'Interact with a page using refs from BrowserSnapshot: click/fill/type/keypress/select/check/uncheck/hover/drag/scroll/mouse.',
      inputSchema: {
        type: 'object',
        properties: {
          ...commonPageProperties,
          action: {
            type: 'string',
            enum: [
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
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_CAPTURE_TOOL,
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
            description: 'Local output path. Must be within configured allowedRoots.',
          },
          clear: { type: 'boolean' },
          timeout_ms: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: BROWSER_ADVANCED_TOOL,
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

export class BrowserToolProvider {
  private enabled = false;
  private allowedRoots: string[] = [];
  private revealSharedPage: (page: BrowserPageInfo) => void = () => {};

  constructor(private runtime: BrowserRuntime) {}

  configure(
    enabled: boolean,
    allowedRoots: string[] = [],
    revealSharedPage: (page: BrowserPageInfo) => void = () => {},
  ): void {
    this.enabled = enabled;
    this.allowedRoots = allowedRoots;
    this.revealSharedPage = revealSharedPage;
  }

  advertise(): LocalToolSchema[] {
    return this.enabled ? browserToolSchemas() : [];
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
    if (tool === BROWSER_INTERACT_TOOL) return this.interact(args, context);
    if (tool === BROWSER_CAPTURE_TOOL) return this.capture(args, context);
    if (tool === BROWSER_ADVANCED_TOOL) return this.advanced(args, context);
    throw new Error(`unknown browser tool: ${tool}`);
  }

  private async tabs(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? 'list');
    const wid = workflow(args, context);
    if (action === 'list') return result(null, this.runtime.list(wid || undefined));
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
    const command = ['wait'];
    appendValue(command, args.wait_for ?? args.waitFor ?? '1000');
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
      command = [action, ref, String(args.text ?? '')];
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
    );
    return result(run.page, run.result);
  }

  private scopedPath(raw: unknown): string {
    const path = browserPathWithinRoots(raw, this.allowedRoots);
    if (!path)
      throw new BrowserRuntimeError('browser_denied', '파일 경로가 allowedRoots 범위 밖입니다.');
    return path;
  }

  private async capture(
    args: Record<string, unknown>,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    const action = String(args.action ?? 'screenshot');
    let command: string[];
    if (action === 'screenshot' || action === 'full_screenshot' || action === 'pdf') {
      const fallback = action === 'pdf' ? 'browser.pdf' : 'browser.png';
      const path = this.scopedPath(args.path ?? fallback);
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
    return result(run.page, run.result);
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
      for (const path of paths) command.push(this.scopedPath(path));
    } else if (action === 'download') {
      const path = this.scopedPath(args.path);
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
      if (args.path !== undefined) command.push(this.scopedPath(args.path));
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
