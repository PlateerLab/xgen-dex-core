import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { BROWSER_INTERACT_TOOL, BROWSER_NAVIGATE_TOOL, BrowserToolProvider } from '../src/main/browser-tools';

// 페이지를 옮긴 조작의 결과에 새 화면을 붙인다 — 결과에 화면이 없으면 서버 모델은 이동·클릭마다
// BrowserSnapshot 을 한 번 더 불렀다(10/23 BO 시연: 도구 18회 중 2회, 회당 LLM 한 턴).

function page(generation = 1): BrowserPageInfo {
  return {
    pageId: 'p1', workflowId: 'wf', workflowName: 'Agent', mode: 'background', url: 'https://example.com/',
    title: 'Example', loading: 'idle', canGoBack: false, canGoForward: false, partition: 'test', generation,
  };
}

/** runAgentCommand 를 흉내 낸다 — snapshot 은 generation 을 올리고(실제와 같음), 조작은 movesPage 일 때 올린다. */
function fakeRuntime(options: { movesPage?: boolean; snapshot?: string | Error } = {}) {
  const info = page();
  const commands: string[][] = [];
  const settles: Array<Record<string, unknown>> = [];
  const runtime = {
    get: (id: string) => (id === info.pageId ? { ...info } : null),
    settle: async (_id: string, options: Record<string, unknown>) => {
      settles.push(options);
    },
    requestMark: () => 0,
    resolvePage: async () => ({ info: { ...info } }),
    navigate: async () => {
      info.generation += 1;
      return { ...info };
    },
    runAgentCommand: async (_wid: string, _id: string | undefined, command: string[]) => {
      commands.push(command);
      if (command[0] === 'snapshot') {
        if (options.snapshot instanceof Error) throw options.snapshot;
        info.generation += 1;
        return { page: { ...info }, result: { data: { snapshot: options.snapshot ?? '- button "로그인" [ref=e1]', refs: { e1: {} } } } };
      }
      if (options.movesPage) info.generation += 1;
      return { page: { ...info }, result: { success: true } };
    },
  };
  return { runtime: runtime as unknown as BrowserRuntime, commands, info, settles };
}

function payload(output: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(output.content[0].text!) as Record<string, unknown>;
}

test('goto returns the new page snapshot and the generation its refs belong to', async () => {
  const { runtime, commands, settles } = fakeRuntime();
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const out = payload(await provider.callTool(BROWSER_NAVIGATE_TOOL, { action: 'goto', url: 'https://example.com/' }, { workflowId: 'wf' }));
  assert.deepEqual(commands, [['snapshot', '-i', '-c']]);
  assert.deepEqual(settles, [{ since: 0, probeMs: 500, signal: undefined }]); // 새 문서의 스크립트가 첫 데이터 요청을 보낼 틈
  assert.equal(out.generation, 3); // 이동 +1, 스냅샷 +1 — 스냅샷의 generation 이어야 그 ref 가 산다
  const result = out.result as Record<string, unknown>;
  assert.equal(result.navigated, 'goto');
  assert.match(String(result.snapshot), /로그인/);
  assert.equal(result.refs, undefined);
});

test('a click that leaves the page as it was attaches nothing and keeps earlier refs valid', async () => {
  const { runtime, commands, info } = fakeRuntime({ movesPage: false });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const out = payload(await provider.callTool(BROWSER_INTERACT_TOOL, { action: 'click', ref: '@e3', generation: 1 }, { workflowId: 'wf' }));
  assert.deepEqual(commands, [['click', '@e3']]);
  assert.equal(info.generation, 1);
  assert.equal((out.result as Record<string, unknown>).snapshot, undefined);
});

test('a click that moves the page attaches the new snapshot', async () => {
  const { runtime, commands, settles } = fakeRuntime({ movesPage: true });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const out = payload(await provider.callTool(BROWSER_INTERACT_TOOL, { action: 'click', ref: '@e3' }, { workflowId: 'wf' }));
  assert.deepEqual(commands, [['click', '@e3'], ['snapshot', '-i', '-c']]);
  // 클릭이 보낸 요청을 기다리고, 옮겨 간 화면이 데이터를 부를 틈을 한 번 더 준다(SPA 경로 이동)
  assert.deepEqual(settles, [{ since: 0, probeMs: undefined, signal: undefined }, { since: 0, probeMs: 500, signal: undefined }]);
  assert.equal(out.generation, 3);
  const result = out.result as Record<string, unknown>;
  assert.equal(result.success, true);
  assert.match(String(result.snapshot), /로그인/);
});

test('typing never takes a snapshot — the next field ref must stay valid', async () => {
  const { runtime, commands } = fakeRuntime({ movesPage: true });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  await provider.callTool(BROWSER_INTERACT_TOOL, { action: 'fill', ref: '@e2', text: 'id' }, { workflowId: 'wf' });
  await provider.callTool(BROWSER_INTERACT_TOOL, { action: 'type', ref: '@e4', text: 'pw' }, { workflowId: 'wf' });
  assert.deepEqual(commands.map((c) => c[0]), ['fill', 'type']);
});

test('a long snapshot is cut at a line and says how to read the rest', async () => {
  const line = '- link "상품 목록 항목" [ref=e9]\n';
  const { runtime } = fakeRuntime({ snapshot: line.repeat(2_000) });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const result = payload(await provider.callTool(BROWSER_NAVIGATE_TOOL, { action: 'reload' }, { workflowId: 'wf' })).result as Record<string, string>;
  assert.ok(result.snapshot.length <= 20_000);
  assert.ok(result.snapshot.endsWith('[ref=e9]'));
  assert.match(result.snapshot_truncated, /BrowserSnapshot/);
});

test('a failed snapshot still returns the finished navigation', async () => {
  const { runtime } = fakeRuntime({ snapshot: new Error('browser_timeout: snapshot') });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const out = payload(await provider.callTool(BROWSER_NAVIGATE_TOOL, { action: 'goto', url: 'https://example.com/' }, { workflowId: 'wf' }));
  const result = out.result as Record<string, unknown>;
  assert.equal(result.navigated, 'goto');
  assert.equal(result.snapshot, undefined);
});

class Contents extends EventEmitter {
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  destroyed = false;
  session = 'test-session';
  isDestroyed = () => this.destroyed;
  getURL = () => 'https://example.com/';
  getTitle = () => 'Example';
  setWindowOpenHandler = () => {};
  constructor(readonly id: number) {
    super();
  }
}

function boundRuntime() {
  const runtime = new BrowserRuntime();
  const contents = new Contents(21);
  const entry = { info: page(0), contents: null, window: null, proxy: null, automationReset: null };
  const internals = runtime as unknown as {
    enabled: boolean;
    pages: Map<string, unknown>;
    bindContents: (page: unknown, contents: unknown) => void;
  };
  internals.enabled = true;
  internals.pages.set(entry.info.pageId, entry);
  internals.bindContents(entry, contents);
  const net = runtime as unknown as {
    requestStarted: (details: { id: number; resourceType: string; webContentsId?: number }) => void;
    requestFinished: (details: { id: number; webContentsId?: number }) => void;
  };
  const request = (id: number, resourceType = 'xhr') => net.requestStarted({ id, resourceType, webContentsId: contents.id });
  const respond = (id: number) => net.requestFinished({ id, webContentsId: contents.id });
  return { runtime, contents, request, respond };
}

test('settle waits for the document a click started, not the one still on screen', async () => {
  const { runtime, contents } = boundRuntime();
  let settled = false;
  const waiting = runtime.settle('p1', { probeMs: 10, maxMs: 2_000 }).then(() => {
    settled = true;
  });
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, false);
  contents.emit('dom-ready');
  await waiting;
});

test('settle does not wait for an in-page route change or for longer than its limit', async () => {
  const { runtime, contents } = boundRuntime();
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  let started = Date.now();
  await runtime.settle('p1', { probeMs: 10, maxMs: 2_000 });
  assert.ok(Date.now() - started < 500);

  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  started = Date.now();
  await runtime.settle('p1', { probeMs: 10, maxMs: 150 });
  assert.ok(Date.now() - started < 1_000);
});

test('upload stages survive in-page routes and are released on a new document or tab close', async () => {
  const { runtime, contents } = boundRuntime();
  let cleaned = 0;
  const stage = () => ({ cleanup: async () => { cleaned++; } });
  const document = runtime.uploadDocument('p1');
  assert.equal(await runtime.retainUpload('p1', document, stage()), true);

  contents.emit('did-navigate-in-page', {}, 'https://example.com/next', true);
  assert.equal(cleaned, 0);
  contents.emit('did-navigate');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, 1);

  assert.equal(await runtime.retainUpload('p1', document, stage()), false);
  assert.equal(cleaned, 2);
  assert.equal(await runtime.retainUpload('p1', runtime.uploadDocument('p1'), stage()), true);
  await runtime.close('p1');
  assert.equal(cleaned, 3);
});

test('closing every browser page releases retained uploads', async () => {
  const { runtime } = boundRuntime();
  let cleaned = 0;
  await runtime.retainUpload('p1', runtime.uploadDocument('p1'), { cleanup: async () => { cleaned++; } });
  await runtime.closeAll();
  assert.equal(cleaned, 1);
});

// BO 로그인 버튼: 클릭 280ms 뒤에도 주소 그대로 — 로그인 응답을 받은 뒤에야 라우터가 옮겼다(10/24 실측).
test('settle waits for the requests an action sent and for the move their response starts', async () => {
  const { runtime, contents, request, respond } = boundRuntime();
  request(1); // 조작 전부터 열려 있던 요청(폴링 등)은 기다리지 않는다
  const since = runtime.requestMark();
  let settled = false;
  const waiting = runtime.settle('p1', { since, probeMs: 10, quietMs: 80, maxMs: 2_000 }).then(() => {
    settled = true;
  });
  request(2); // 로그인 POST
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false);
  respond(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  request(3); // 응답을 받은 라우터가 다음 화면 데이터를 부른다
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, false);
  respond(3);
  contents.emit('did-navigate-in-page', {}, 'https://example.com/home', true);
  await waiting;
  assert.equal(settled, true);
});

test('settle ignores images and requests that started before the action, and gives up at its limit', async () => {
  const { runtime, request } = boundRuntime();
  request(1);
  const since = runtime.requestMark();
  request(2, 'image');
  let started = Date.now();
  await runtime.settle('p1', { since, probeMs: 10, maxMs: 2_000 });
  assert.ok(Date.now() - started < 300);

  request(3); // 끝나지 않는 요청(롱폴링·스트리밍)
  started = Date.now();
  await runtime.settle('p1', { since, probeMs: 10, quietMs: 50, maxMs: 200 });
  assert.ok(Date.now() - started < 1_000);
});

test('a stop pressed while waiting skips the snapshot and returns the finished click', async () => {
  const { runtime, commands } = fakeRuntime({ movesPage: true });
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true);
  const stop = new AbortController();
  stop.abort();
  const out = payload(await provider.callTool(BROWSER_INTERACT_TOOL, { action: 'click', ref: '@e3' }, { workflowId: 'wf', signal: stop.signal }));
  assert.deepEqual(commands, [['click', '@e3']]);
  assert.equal((out.result as Record<string, unknown>).snapshot, undefined);
});
