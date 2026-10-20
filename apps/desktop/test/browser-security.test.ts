import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  browserOrigin,
  normalizeBrowserUrl,
  resolveBrowserAddress,
  type BrowserConnectionEvent,
  type BrowserPageInfo,
} from '@dex/protocol/browser';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { configureFastAct } from '../src/main/fast-act-runner';
import { EventEmitter } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserPane } from '../src/renderer/src/views/BrowserPane';
import { browserStateStore } from '../src/renderer/src/browser-state';
import {
  BROWSER_TABS_TOOL,
  BROWSER_FILL_TOOL,
  BROWSER_FORM_VALUES_TOOL,
  BrowserToolProvider,
  browserWaitCommand,
  browserToolSchemas,
  BROWSER_INTERACT_TOOL,
  BROWSER_SNAPSHOT_TOOL,
} from '../src/main/browser-tools';
import {
  BROWSER_PARTITION_PREFIX,
  allowedBrowserUrl,
  browserPartition,
  browserPathWithinRoots,
} from '../src/main/browser-security';

test('step execution is advertised only with a decider and dispatched with trusted workflow context', async () => {
  const page: BrowserPageInfo = { pageId: 'step-page', workflowId: 'step-workflow', workflowName: 'Step', mode: 'shared', url: 'https://example.com/', title: 'Step', loading: 'idle', canGoBack: false, canGoForward: false, partition: 'test', generation: 1 };
  let pending: Promise<void> | null = null;
  const runtime = {
    state: () => ({ pages: [page], activeByWorkflow: { 'step-workflow': page.pageId } }),
    get: (id: string) => id === page.pageId ? page : null,
    resolvePage: async (wid: string, id: string, create: boolean) => {
      assert.equal(wid, page.workflowId);
      assert.equal(id, page.pageId);
      assert.equal(create, false);
      if (pending) await pending;
      return { info: page };
    },
    runAgentCommand: async () => ({ page, result: { data: { refs: {}, snapshot: 'Step page' } } }),
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const disabled = browserToolSchemas().find((t) => t.name === BROWSER_INTERACT_TOOL)!;
  assert.doesNotMatch(disabled.description!, /action="step"/);
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, { action: 'step' }, { workflowId: page.workflowId }), /decider/);
  provider.configure(true, () => [], () => {}, () => async () => ({}));
  const schema = provider.advertise().find((t) => t.name === BROWSER_INTERACT_TOOL)!;
  assert.match(schema.description!, /current conversation model/);
  const properties = schema.inputSchema!.properties as Record<string, { enum?: string[] }>;
  assert.ok(properties.action.enum!.includes('step'));
  assert.ok(properties.operation.enum!.includes('move'), 'legacy mouse operations stay valid');
  const args = { action: 'step', operation: 'observe', instruction: '주소 확인', expect: [{ kind: 'url', value: page.url }] };
  const output = await provider.callTool(BROWSER_INTERACT_TOOL, args, { workflowId: page.workflowId });
  assert.match(JSON.stringify(output), /completed/);
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, { ...args, workflow_id: 'other' }, { workflowId: page.workflowId }), /일치하지/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, args, { workflowId: page.workflowId, signal: controller.signal }), /cancelled/);
  let release!: () => void;
  pending = new Promise<void>((resolve) => { release = resolve; });
  const first = provider.callTool(BROWSER_INTERACT_TOOL, args, { workflowId: page.workflowId });
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, args, { workflowId: page.workflowId }), /이전 단계/);
  release();
  await first;
});

test('browser scheme allowlist normalizes host input and blocks privileged schemes', () => {
  assert.equal(allowedBrowserUrl('example.com')?.startsWith('https://example.com'), true);
  assert.equal(allowedBrowserUrl('about:blank'), 'about:blank');
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.test']) {
    assert.equal(allowedBrowserUrl(url), null, url);
  }
});

test('browser URL input adds https only when a protocol was omitted', () => {
  assert.equal(normalizeBrowserUrl('example.com/path'), 'https://example.com/path');
  assert.equal(normalizeBrowserUrl('http://example.com/path'), 'http://example.com/path');
  assert.equal(normalizeBrowserUrl('https://example.com/path'), 'https://example.com/path');
});

test('popup permission keys use exact normalized http(s) origins', () => {
  assert.equal(browserOrigin('https://Example.COM:443/path?q=1'), 'https://example.com');
  assert.equal(browserOrigin('http://example.com:8080/path'), 'http://example.com:8080');
  assert.equal(browserOrigin('about:blank'), null);
  assert.equal(browserOrigin('javascript:alert(1)'), null);
});

test('shared webviews forward popup requests to the main-process permission handler', async () => {
  const source = await readFile(
    new URL('../src/renderer/src/views/BrowserSurface.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /allowpopups:\s*['"]true['"]/);
});

test('address search falls back to Google only when enabled', () => {
  assert.equal(resolveBrowserAddress('example.com', { enabled: false }), 'https://example.com/');
  assert.equal(resolveBrowserAddress('오늘 날씨', { enabled: false }), null);
  assert.equal(
    resolveBrowserAddress('오늘 날씨', { enabled: true, provider: 'google' }),
    `https://www.google.com/search?q=${encodeURIComponent('오늘 날씨')}`,
  );
  assert.equal(
    resolveBrowserAddress('javascript:alert(1)', { enabled: true, provider: 'google' }),
    null,
  );
});

test('shared navigation asks for its agent and resumes after the webview connects', async () => {
  const runtime = new BrowserRuntime();
  const page = {
    info: {
      pageId: 'shared-page',
      workflowId: 'workflow-25',
      workflowName: 'Agentflow (25)',
      mode: 'shared',
      url: 'about:blank',
      title: '새 탭',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:test',
      generation: 0,
    } satisfies BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  };
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, typeof page>;
    resolvePendingConnection: (runtimePage: typeof page, contents: unknown) => void;
  };
  internals.enabled = true;
  internals.accountPartition = 'persist:test';
  internals.pages.set(page.info.pageId, page);

  const events: BrowserConnectionEvent[] = [];
  runtime.setConnectionListener((event) => events.push(event));
  let loaded = '';
  const contents = {
    isDestroyed: () => false,
    loadURL: async (url: string) => {
      loaded = url;
    },
  };
  const navigating = runtime.navigate({
    pageId: page.info.pageId,
    action: 'goto',
    url: 'example.com',
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(events.at(-1)?.phase, 'required');
  internals.resolvePendingConnection(page, contents);
  await navigating;

  assert.equal(loaded, 'https://example.com/');
  assert.deepEqual(
    events.map((event) => event.phase),
    ['required', 'connected'],
  );
});

test('popup approval preserves the next original window.open instead of replaying its URL', async () => {
  const runtime = new BrowserRuntime();
  const page = {
    info: {
      pageId: 'popup-opener',
      workflowId: 'workflow-popup',
      workflowName: 'Popup Agent',
      mode: 'shared',
      url: 'https://source.example.com/page',
      title: 'Source',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:test',
      generation: 0,
    } satisfies BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  };
  let popupHandler:
    | ((details: { url: string; postBody?: object | null }) => {
        action: string;
        overrideBrowserWindowOptions?: { webPreferences: Record<string, unknown> };
      })
    | undefined;
  const contents = {
    id: 77,
    isDestroyed: () => false,
    getURL: () => page.info.url,
    getTitle: () => page.info.title,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
    setWindowOpenHandler: (handler: typeof popupHandler) => {
      popupHandler = handler;
    },
    executeJavaScript: async () => true,
    mainFrame: { frameTreeNodeId: 1 },
    on: () => undefined,
    once: () => undefined,
  };
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, typeof page>;
    popupPermissions: Map<string, 'allow' | 'block'>;
    sessionPopupPermissions: Set<string>;
    agentGestureUntil: Map<string, number>;
    popupHostWindow: { isDestroyed: () => boolean };
    bindContents: (runtimePage: typeof page, webContents: unknown) => void;
  };
  internals.enabled = true;
  internals.popupHostWindow = { isDestroyed: () => false };
  internals.accountPartition = 'persist:test';
  internals.pages.set(page.info.pageId, page);
  internals.bindContents(page, contents);

  assert.ok(popupHandler);
  assert.equal(popupHandler({ url: 'https://post.example.com/', postBody: {} }).action, 'deny');
  assert.equal(runtime.state().popupRequests.length, 0);
  const response = popupHandler({
    url: 'https://labs.plateer.com/path?token=secret#fragment',
    postBody: null,
  });
  assert.equal(response.action, 'deny');
  const pending = runtime.state().popupRequests[0];
  assert.equal(pending.openerOrigin, 'https://source.example.com');
  assert.equal(pending.targetOrigin, 'https://labs.plateer.com');
  assert.equal(pending.targetDisplayUrl, 'https://labs.plateer.com/path');
  assert.ok(!pending.targetDisplayUrl.includes('secret'));

  const persisted: string[] = [];
  runtime.setPopupPermissionListener((partition, origin, permission) => {
    persisted.push(`${partition}|${origin}|${permission}`);
  });
  assert.equal(
    await runtime.resolvePopup({ requestId: pending.requestId, decision: 'allow_always' }),
    true,
  );
  assert.deepEqual(persisted, ['persist:test|https://source.example.com|allow']);
  assert.equal(runtime.state().popupRequests.length, 0);
  assert.equal(runtime.list('workflow-popup').length, 1, 'approval must not replay a detached URL');

  const allowed = popupHandler({ url: 'https://labs.plateer.com/second' });
  assert.equal(allowed.action, 'allow');
  assert.deepEqual(allowed.overrideBrowserWindowOptions?.webPreferences, {
    partition: 'persist:test',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  });
  assert.equal(runtime.state().popupRequests.length, 0);
  assert.equal(runtime.list('workflow-popup').length, 1);
  for (const url of ['about:blank', 'file:///tmp/secret', 'javascript:alert(1)']) {
    assert.equal(popupHandler({ url }).action, 'deny');
  }
  assert.equal(popupHandler({ url: 'https://post.example.com/', postBody: {} }).action, 'deny');

  internals.popupPermissions.clear();
  const beforeBlock = runtime.list('workflow-popup').length;
  popupHandler({ url: 'https://blocked.example.com/' });
  const blocked = runtime.state().popupRequests[0];
  assert.equal(
    await runtime.resolvePopup({ requestId: blocked.requestId, decision: 'block' }),
    true,
  );
  assert.equal(runtime.list('workflow-popup').length, beforeBlock);
  assert.equal(persisted.at(-1), 'persist:test|https://source.example.com|block');
  internals.agentGestureUntil.set(page.info.pageId, Date.now() + 3000);
  assert.equal(popupHandler({ url: 'https://blocked.example.com/' }).action, 'deny');

  await runtime.resolvePopup({
    requestId: runtime.state().popupRequests[0].requestId,
    decision: 'block',
  });
  internals.popupPermissions.clear();
  internals.sessionPopupPermissions.clear();
  popupHandler({ url: 'https://temporary.example.com/first' });
  const temporary = runtime.state().popupRequests[0];
  const persistedCount = persisted.length;
  assert.equal(
    await runtime.resolvePopup({ requestId: temporary.requestId, decision: 'allow_session' }),
    true,
  );
  assert.equal(persisted.length, persistedCount);
  assert.equal(popupHandler({ url: 'https://temporary.example.com/second' }).action, 'allow');
  assert.equal(runtime.state().popupRequests.length, 0);
  assert.equal(runtime.list('workflow-popup').length, 1);
});

test('popup tabs keep their WebContents, agent ownership and parent lifecycle', async () => {
  class Contents extends EventEmitter {
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    destroyed = false;
    session = 'test-session';
    handler?: (request: { url: string }) => { action: string };
    focused = false;
    constructor(
      readonly id: number,
      readonly url: string,
    ) {
      super();
    }
    isDestroyed = () => this.destroyed;
    getURL = () => this.url;
    getTitle = () => 'Vendor';
    close = () => {
      this.destroyed = true;
      this.emit('destroyed');
    };
    focus = () => {
      this.focused = true;
    };
    setWindowOpenHandler = (handler: typeof this.handler) => {
      this.handler = handler;
    };
  }
  class PopupView {
    visible = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    constructor(readonly webContents: Contents) {}
    setVisible = (visible: boolean) => {
      this.visible = visible;
    };
    setBounds = (bounds: typeof this.bounds) => {
      this.bounds = bounds;
    };
  }
  const views = new Set<PopupView>();
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 2 },
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      addChildView: (view: PopupView) => views.add(view),
      removeChildView: (view: PopupView) => views.delete(view),
    },
  });
  const runtime = new BrowserRuntime();
  const contents = new Contents(10, 'https://example.com/form');
  const page = {
    info: {
      pageId: 'parent',
      workflowId: 'workflow',
      workflowName: 'Agent',
      mode: 'shared',
      url: contents.url,
      title: 'Form',
      partition: 'persist:test',
      generation: 0,
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
    } satisfies BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  };
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, { contents: unknown; info: BrowserPageInfo }>;
    agentGestureUntil: Map<string, number>;
    bindContents: (page: unknown, contents: unknown) => void;
    bindPopupView: (page: unknown, view: unknown, url: string) => void;
  };
  runtime.setPopupHostWindow(
    host as unknown as Parameters<BrowserRuntime['setPopupHostWindow']>[0],
  );
  internals.enabled = true;
  internals.accountPartition = 'persist:test';
  internals.pages.set('parent', page);
  internals.bindContents(page, contents);
  internals.agentGestureUntil.set('parent', Date.now() + 3000);
  assert.equal(contents.handler?.({ url: 'https://example.com/vendors' }).action, 'allow');

  const child = new PopupView(new Contents(11, 'https://example.com/vendors'));
  internals.bindPopupView(page, child, child.webContents.url);
  const popup = runtime.list('workflow').find((item) => item.mode === 'popup')!;
  assert.ok(popup);
  assert.equal(popup.openerPageId, 'parent');
  assert.equal(internals.pages.get(popup.pageId)?.contents, child.webContents);
  assert.equal(
    (await runtime.resolvePage('workflow', popup.pageId, false)).contents,
    child.webContents,
  );
  await assert.rejects(
    () => runtime.resolvePage('other-workflow', popup.pageId, false),
    /browser_page_not_found/,
  );
  assert.equal(runtime.state().activeByWorkflow.workflow, popup.pageId);
  assert.ok(child.webContents.focused);
  assert.equal(views.has(child), true);
  runtime.updatePopupSurface(popup.pageId, { x: 10, y: 20, width: 500, height: 300 });
  assert.deepEqual(child.bounds, { x: 20, y: 40, width: 780, height: 560 });
  assert.equal(child.visible, true);
  assert.throws(
    () => runtime.updatePopupSurface(popup.pageId, { x: NaN, y: 0, width: 1, height: 1 }),
    /browser_denied/,
  );
  runtime.updatePopupSurface(popup.pageId, null);
  assert.equal(child.visible, false);
  runtime.activate('parent');
  child.webContents.emit('focus');
  assert.equal(runtime.state().activeByWorkflow.workflow, popup.pageId);

  const agent = (runtime as unknown as { runner: { run: () => Promise<unknown> } }).runner;
  const originalRun = agent.run;
  agent.run = async () => {
    child.webContents.close();
    throw new Error('Target closed during click');
  };
  try {
    const clicked = await runtime.runAgentCommand('workflow', popup.pageId, ['click', '#confirm']);
    assert.equal(clicked.page.pageId, 'parent');
    assert.equal((clicked.result as { popup_closed: boolean }).popup_closed, true);
  } finally {
    agent.run = originalRun;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.get(popup.pageId), null);
  assert.equal(runtime.state().activeByWorkflow.workflow, 'parent');
  assert.equal(contents.focused, true);

  const second = new PopupView(new Contents(12, 'https://example.com/vendors'));
  internals.bindPopupView(page, second, second.webContents.url);
  const nested = new PopupView(new Contents(13, 'https://example.com/nested'));
  const secondPage = await runtime.resolvePage(
    'workflow',
    runtime.state().activeByWorkflow.workflow,
    false,
  );
  internals.bindPopupView(secondPage, nested, nested.webContents.url);
  assert.equal(runtime.list('workflow').length, 3);
  await runtime.close('parent');
  assert.ok(second.webContents.destroyed && nested.webContents.destroyed);
  assert.equal(views.size, 0);
  assert.equal(runtime.list('workflow').length, 0);
  assert.equal(runtime.state().activeByWorkflow.workflow, undefined);

  const stale = new PopupView(new Contents(14, 'https://example.com/stale'));
  assert.throws(
    () => internals.bindPopupView(page, stale, stale.webContents.url),
    /browser_stale_ref/,
  );
  assert.equal(stale.webContents.destroyed, true);
});

test('nested popup pages are displayed as browser tabs', () => {
  const previous = browserStateStore.getSnapshot();
  const base: BrowserPageInfo = {
    pageId: 'first',
    workflowId: 'workflow',
    workflowName: 'Agent',
    mode: 'shared',
    url: 'https://example.com/first',
    title: 'First',
    partition: 'persist:test',
    generation: 0,
    loading: 'idle',
    canGoBack: false,
    canGoForward: false,
  };
  const store = browserStateStore as unknown as { set: (state: typeof previous) => void };
  store.set({
    enabled: true,
    activeByWorkflow: { workflow: 'nested' },
    popupRequests: [],
    pages: [
      base,
      { ...base, pageId: 'second', url: 'https://example.com/second', title: 'Second' },
      { ...base, pageId: 'popup', mode: 'popup', openerPageId: 'second' },
      {
        ...base,
        pageId: 'nested',
        mode: 'popup',
        openerPageId: 'popup',
        url: 'https://example.com/nested',
      },
    ],
  });
  try {
    const html = renderToStaticMarkup(
      React.createElement(BrowserPane, {
        workflowId: 'workflow',
        workflowName: 'Agent',
        selection: null,
        onStartSelection: () => {},
        onSurface: () => {},
      }),
    );
    assert.match(html, /value="https:\/\/example.com\/nested"/);
  } finally {
    store.set(previous);
  }
});

test('account partition is stable per server/user without exposing account ids', () => {
  const one = browserPartition('https://x.test/', 'user-secret');
  assert.ok(one.startsWith(BROWSER_PARTITION_PREFIX));
  assert.equal(one, browserPartition('https://x.test', 'user-secret'));
  assert.notEqual(one, browserPartition('https://x.test', 'other'));
  assert.ok(!one.includes('user-secret'));
});

test('upload/download paths stay inside the conversation folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xgen-browser-'));
  assert.equal(browserPathWithinRoots(join(root, 'a.txt'), [root]), join(root, 'a.txt'));
  assert.equal(browserPathWithinRoots(join(root, '..', 'escape.txt'), [root]), null);
  // 상대 경로는 첫 번째 폴더에서 시작한다(예전처럼 홈이 아니다).
  assert.equal(browserPathWithinRoots('shot.png', [root]), join(root, 'shot.png'));
  // 폴더가 없는 대화에서는 어떤 경로도 허락하지 않는다.
  assert.equal(browserPathWithinRoots(join(root, 'a.txt'), []), null);
});

test('an agent-created shared page requests visible browser UI', async () => {
  const basePage: BrowserPageInfo = {
    pageId: 'agent-page',
    workflowId: 'workflow-25',
    workflowName: 'Agentflow (25)',
    mode: 'shared',
    url: 'https://example.com/',
    title: '새 탭',
    loading: 'idle',
    canGoBack: false,
    canGoForward: false,
    partition: 'persist:test',
    generation: 0,
  };
  const createdModes: string[] = [];
  const createdWorkflows: string[] = [];
  const fakeRuntime = {
    create: async (request: { mode?: string; workflowId: string }) => {
      const mode = request.mode === 'shared' ? 'shared' : 'background';
      createdModes.push(mode);
      createdWorkflows.push(request.workflowId);
      return { ...basePage, mode } as BrowserPageInfo;
    },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(fakeRuntime);
  const revealed: string[] = [];
  provider.configure(
    true,
    () => [],
    (page) => revealed.push(page.pageId),
  );

  await provider.callTool(
    BROWSER_TABS_TOOL,
    {
      action: 'create',
      mode: 'shared',
      url: 'https://example.com',
    },
    { workflowId: 'workflow-25', workflowName: 'Agentflow (25)' },
  );
  await provider.callTool(
    BROWSER_TABS_TOOL,
    {
      action: 'create',
      mode: 'background',
    },
    { workflowId: 'workflow-25', workflowName: 'Agentflow (25)' },
  );

  assert.deepEqual(createdModes, ['shared', 'background']);
  assert.deepEqual(createdWorkflows, ['workflow-25', 'workflow-25']);
  assert.deepEqual(revealed, ['agent-page']);

  await assert.rejects(
    () => provider.callTool(BROWSER_TABS_TOOL, { action: 'create', mode: 'shared' }),
    /mcp_call\.context\.workflow_id/,
  );

  await assert.rejects(
    () =>
      provider.callTool(
        BROWSER_TABS_TOOL,
        { action: 'create', workflow_id: 'another-workflow' },
        { workflowId: 'workflow-25' },
      ),
    /일치하지 않습니다/,
  );
});

test('BrowserNavigate wait: 로드 상태·URL·글을 agent-browser 플래그로 옮긴다', () => {
  // 위치 인자는 밀리초 아니면 선택자 — "load" 를 그대로 넘기면 <load> 요소를 25초 기다리다 실패했다.
  assert.deepEqual(browserWaitCommand('load'), ['wait', '--load', 'load']);
  assert.deepEqual(browserWaitCommand('NetworkIdle'), ['wait', '--load', 'networkidle']);
  assert.deepEqual(browserWaitCommand('https://www.bizinfo.go.kr/web/*'), [
    'wait',
    '--url',
    'https://www.bizinfo.go.kr/web/*',
  ]);
  assert.deepEqual(browserWaitCommand('**/search.do'), ['wait', '--url', '**/search.do']);
  assert.deepEqual(browserWaitCommand('text: 검색 결과'), ['wait', '--text', '검색 결과']);
  // 밀리초·선택자는 예전처럼 위치 인자, 값이 없으면 1초.
  assert.deepEqual(browserWaitCommand('1500'), ['wait', '1500']);
  assert.deepEqual(browserWaitCommand(1500), ['wait', '1500']);
  assert.deepEqual(browserWaitCommand('#result-list'), ['wait', '#result-list']);
  assert.deepEqual(browserWaitCommand(undefined), ['wait', '1000']);
});

test('closing a popup publishes parent selection before automation cleanup completes', async () => {
  const runtime = new BrowserRuntime();
  const internals = runtime as any;
  internals.enabled = true;
  internals.accountPartition = 'persist:test';
  const parent = await runtime.create({ workflowId: 'workflow', url: 'https://example.com/' });
  const child = await runtime.create({ workflowId: 'workflow', url: 'https://example.com/popup' });
  Object.assign(internals.pages.get(child.pageId).info, { mode: 'popup', openerPageId: parent.pageId });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  internals.runner.cancelPage = () => cleanup;
  let observed = runtime.state();
  runtime.setStateListener(state => { observed = state; });
  const closing = runtime.close(child.pageId);
  try {
    assert.equal(observed.activeByWorkflow.workflow, parent.pageId);
    assert.deepEqual(observed.pages.map(page => page.pageId), [parent.pageId]);
  } finally {
    release();
    await closing;
  }
});

test('pageScript uses the main frame and times out without waiting for page load', async () => {
  const runtime = new BrowserRuntime();
  const internals = runtime as any;
  internals.resolvePage = async () => ({});
  const contents = {
    executeJavaScript: () => { throw new Error('must not wait for load'); },
    mainFrame: { executeJavaScript: async (_code: string): Promise<unknown> => 'ready' },
  };
  internals.requireConnectedContents = async () => contents;
  assert.equal(await runtime.pageScript('workflow', 'page', 'document.title', 100), 'ready');
  contents.mainFrame.executeJavaScript = () => new Promise(() => {});
  await assert.rejects(runtime.pageScript('workflow', 'page', 'document.title', 10), /browser_timeout/);
});


test('BrowserFill setting and step decider independently control advertised tools', () => {
  const savedUrl = process.env.DEX_FAST_ACT_URL;
  delete process.env.DEX_FAST_ACT_URL;
  let enabled = false;
  const post = async () => ({});
  configureFastAct({ enabled: () => enabled, post });
  const provider = new BrowserToolProvider(new BrowserRuntime());
  try {
    for (const steps of [false, true]) {
      provider.configure(true, () => [], () => {}, () => steps ? post : null);
      for (const fastAct of [false, true]) {
        enabled = fastAct;
        const schemas = provider.advertise();
        assert.equal(schemas.some(tool => tool.name === BROWSER_FILL_TOOL), fastAct);
        const interact = schemas.find(tool => tool.name === BROWSER_INTERACT_TOOL)!;
        const properties = interact.inputSchema!.properties as Record<string, { enum?: string[] }>;
        assert.equal(properties.action.enum!.includes('step'), steps);
      }
    }
    provider.configure(false);
    assert.deepEqual(provider.advertise(), []);
  } finally {
    configureFastAct({ enabled: () => false, post });
    if (savedUrl === undefined) delete process.env.DEX_FAST_ACT_URL;
    else process.env.DEX_FAST_ACT_URL = savedUrl;
  }
});

test('BrowserFill and BrowserFormValues act on a shared tab only by explicit page_id', async () => {
  const post = async () => ({});
  configureFastAct({ enabled: () => true, post });
  const provider = new BrowserToolProvider(new BrowserRuntime());
  provider.configure(true);
  try {
    for (const name of [BROWSER_FILL_TOOL, BROWSER_FORM_VALUES_TOOL]) {
      const schema = provider.advertise().find((tool) => tool.name === name)!;
      assert.ok((schema.inputSchema!.required as string[]).includes('page_id'), name);
    }
    // page_id 가 없으면 보이는 탭을 짐작하지 않고 거절한다.
    await assert.rejects(provider.callTool(BROWSER_FILL_TOOL, { workflow_id: 'w', steps: ['상품명에 「a」 입력해줘'] }), /page_id 가 필요합니다/);
    await assert.rejects(provider.callTool(BROWSER_FORM_VALUES_TOOL, { workflow_id: 'w' }), /page_id 가 필요합니다/);
  } finally {
    configureFastAct({ enabled: () => false, post });
  }
});

test('BrowserSnapshot gives the server LLM the snapshot text without the duplicate refs map', async () => {
  const page = { pageId: 'p', workflowId: 'w' } as BrowserPageInfo;
  const runtime = {
    runAgentCommand: async () => ({ page, result: { success: true, data: { refs: { e1: { role: 'button', name: '저장' } }, snapshot: '- button "저장" [ref=e1]' } } }),
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const output = JSON.stringify(await provider.callTool(BROWSER_SNAPSHOT_TOOL, {}, { workflowId: 'w' }));
  assert.match(output, /\[ref=e1\]/);
  assert.doesNotMatch(output, /refs/);
});
