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
import { AgentBrowserRunner, assertAgentBrowserCommandArgs } from '../src/main/agent-browser-runner';
import type { CdpPageProxy } from '../src/main/cdp-page-proxy';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { BROWSER_TABS_TOOL, BrowserToolProvider, browserWaitCommand } from '../src/main/browser-tools';
import {
  BROWSER_PARTITION_PREFIX,
  allowedBrowserUrl,
  browserPartition,
  browserPathWithinRoots,
} from '../src/main/browser-security';

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

test('shared webviews forward popup requests to the denying main-process handler', async () => {
  const source = await readFile(
    new URL('../src/renderer/src/views/BrowserSurface.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /allowpopups:\s*['"]true['"]/);
  assert.match(source, /user-approved URLs as managed tabs/);
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

test('page popups stay denied and an approved request opens as a managed shared tab', async () => {
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
    ((details: { url: string; postBody?: object | null }) => { action: string }) | undefined;
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
    bindContents: (runtimePage: typeof page, webContents: unknown) => void;
  };
  internals.enabled = true;
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
  assert.ok(
    runtime
      .list('workflow-popup')
      .some((item) => item.url.includes('labs.plateer.com/path?token=secret')),
  );

  popupHandler({ url: 'https://labs.plateer.com/second' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.state().popupRequests.length, 0);
  assert.ok(runtime.list('workflow-popup').some((item) => item.url.endsWith('/second')));

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
  popupHandler({ url: 'https://temporary.example.com/second' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.state().popupRequests.length, 0);
  assert.ok(
    runtime
      .list('workflow-popup')
      .some((item) => item.url === 'https://temporary.example.com/second'),
  );
});

test('a same-origin popup opened from the window.open bridge talks to its opener through DeX only', async () => {
  const runtime = new BrowserRuntime();
  const ID = '7c1f5d2e-9a4b-4c3d-8e2f-0a1b2c3d4e5f';
  type Handler = (...args: unknown[]) => void;
  const fakeContents = (id: number, url: () => string) => {
    const handlers = new Map<string, Handler[]>();
    const scripts: string[] = [];
    let popupHandler: ((details: { url: string; frameName?: string }) => { action: string }) | undefined;
    const contents = {
      id,
      isDestroyed: () => false,
      getURL: url,
      getTitle: () => 'page',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: (handler: typeof popupHandler) => {
        popupHandler = handler;
      },
      executeJavaScript: async (code: string) => {
        scripts.push(code);
        return true;
      },
      mainFrame: { frameTreeNodeId: 1 },
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      once: () => undefined,
    };
    const say = (message: unknown, frameTreeNodeId = 1) =>
      handlers.get('console-message')?.forEach((h) =>
        h({ message: `⁣dex-popup ${JSON.stringify(message)}`, frame: { frameTreeNodeId } }),
      );
    return { contents, scripts, say, open: (details: { url: string; frameName?: string }) => popupHandler!(details) };
  };
  const pageOf = (pageId: string, url: string) => ({
    info: {
      pageId,
      workflowId: 'workflow-bridge',
      workflowName: 'Bridge',
      mode: 'shared',
      url,
      title: 'page',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:test',
      generation: 0,
    } as BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  });
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, ReturnType<typeof pageOf>>;
    sessionPopupPermissions: Set<string>;
    activeByWorkflow: Map<string, string>;
    bindContents: (runtimePage: unknown, webContents: unknown) => void;
  };
  internals.enabled = true;
  internals.accountPartition = 'persist:test';
  internals.sessionPopupPermissions.add('https://bo.example.com');

  const opener = pageOf('opener', 'https://bo.example.com/goods/reg');
  const a = fakeContents(10, () => opener.info.url);
  internals.pages.set(opener.info.pageId, opener);
  internals.bindContents(opener, a.contents);
  // Every shared document gets the window.open wrapper.
  assert.ok(a.scripts.some((code) => code.includes('__dexPopupBridge')));

  assert.equal(a.open({ url: 'https://bo.example.com/popup/partner', frameName: `__dexpopup:${ID}:etEntrListPopup` }).action, 'deny');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const popupInfo = runtime.list('workflow-bridge').find((item) => item.url.endsWith('/popup/partner'));
  assert.ok(popupInfo);
  assert.equal(internals.activeByWorkflow.get('workflow-bridge'), popupInfo.pageId);
  const popup = internals.pages.get(popupInfo.pageId)!;
  const b = fakeContents(11, () => popup.info.url);
  internals.bindContents(popup, b.contents);
  // The popup gets window.opener and its window name.
  assert.ok(b.scripts.some((code) => code.includes(`.opener("${ID}", "etEntrListPopup")`)));

  const delivered = () => a.scripts.filter((code) => code.includes('.deliver('));
  b.say({ k: 'msg', id: ID, data: JSON.stringify({ type: 'popup', winName: 'etEntrListPopup' }), target: 'https://bo.example.com' });
  assert.equal(delivered().length, 1);
  assert.ok(delivered()[0].includes('"https://bo.example.com"'));
  // targetOrigin mismatch, a subframe, or an unrelated page cannot use the link.
  b.say({ k: 'msg', id: ID, data: '1', target: 'https://evil.example' });
  b.say({ k: 'msg', id: ID, data: '1', target: '*' }, 2);
  const stranger = pageOf('stranger', 'https://bo.example.com/other');
  const c = fakeContents(12, () => stranger.info.url);
  internals.pages.set(stranger.info.pageId, stranger);
  internals.bindContents(stranger, c.contents);
  c.say({ k: 'msg', id: ID, data: '1', target: '*' });
  c.say({ k: 'close', id: ID, self: true });
  assert.equal(delivered().length, 1);
  // A popup cannot close its opener; its own window.close() closes the tab and returns to the opener.
  b.say({ k: 'close', id: ID });
  assert.ok(runtime.get(popupInfo.pageId));
  b.say({ k: 'close', id: ID, self: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.get(popupInfo.pageId), null);
  assert.equal(internals.activeByWorkflow.get('workflow-bridge'), 'opener');
  assert.ok(a.scripts.some((code) => code.includes(`.closed("${ID}")`)));
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

test('agent-browser global options cannot be smuggled through positional browser arguments', async () => {
  const runner = new AgentBrowserRunner();
  let starts = 0;
  const proxy = { start: async () => { starts += 1; return 9222; } } as CdpPageProxy;
  for (const command of [
    ['fill', '@e1', '--session', 'other'],
    ['fill', '@e1', '--cdp', '9223'],
    ['click', '--profile'],
    ['type', '@e1', '--state'],
    ['wait', '--text', '--config'],
    ['eval', '--download-path'],
    ['fill', '@e1', '--allow-file-access'],
    ['fill', '@e1', '--help'],
    ['fill', '@e1', '--', '--session'],
  ]) {
    await assert.rejects(
      () => runner.run('page', proxy, command),
      /browser_denied: agent-browser 전역 옵션/,
      command.join(' '),
    );
  }
  assert.equal(starts, 0, 'rejected arguments must not start the CDP proxy');
});

test('agent-browser command guard keeps command-local flags and ordinary text', () => {
  for (const command of [
    ['wait', '--text', 'a --session b'],
    ['wait', '--url', '**/dashboard'],
    ['snapshot', '-i', '--depth', '2'],
    ['screenshot', '/tmp/capture.png', '--full'],
    ['fill', '@e1', '--session=other'],
  ]) assert.doesNotThrow(() => assertAgentBrowserCommandArgs(command));
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
  provider.configure(true, () => [], (page) => revealed.push(page.pageId));

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
  assert.deepEqual(browserWaitCommand('https://www.bizinfo.go.kr/web/*'), ['wait', '--url', 'https://www.bizinfo.go.kr/web/*']);
  assert.deepEqual(browserWaitCommand('**/search.do'), ['wait', '--url', '**/search.do']);
  assert.deepEqual(browserWaitCommand('text: 검색 결과'), ['wait', '--text', '검색 결과']);
  // 밀리초·선택자는 예전처럼 위치 인자, 값이 없으면 1초.
  assert.deepEqual(browserWaitCommand('1500'), ['wait', '1500']);
  assert.deepEqual(browserWaitCommand(1500), ['wait', '1500']);
  assert.deepEqual(browserWaitCommand('#result-list'), ['wait', '#result-list']);
  assert.deepEqual(browserWaitCommand(undefined), ['wait', '1000']);
});
