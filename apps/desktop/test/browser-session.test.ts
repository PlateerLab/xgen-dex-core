import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { BrowserSessionStore } from '../src/main/browser-session';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'dex-browser-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const makeRuntime = () => {
    const runtime = new BrowserRuntime(new BrowserSessionStore(dir));
    (runtime as any).hardenPartition = () => {};
    return runtime;
  };
  const config = { enabled: true, serverUrl: 'https://example.com', userId: 'one' };
  return { dir, makeRuntime, config };
}

test('restart restores ordered tabs and selection; reconfigure does not duplicate; closed tabs stay closed', async (t) => {
  const { makeRuntime, config } = setup(t);
  const first = makeRuntime();
  first.configure(config);
  const a = await first.create({ workflowId: 'agent', url: 'https://example.com/a' });
  const b = await first.create({ workflowId: 'agent', url: 'https://example.com/b' });
  first.activate(a.pageId);
  await first.closeAll();
  const second = makeRuntime();
  second.configure(config);
  second.configure(config);
  assert.deepEqual(
    second.state().pages.map((p) => p.url),
    [a.url, b.url],
  );
  assert.equal(second.state().activeByWorkflow.agent, a.pageId);
  assert.equal((await second.ensureShared('agent')).pageId, a.pageId);
  await second.close(a.pageId);
  await second.closeAll();
  const third = makeRuntime();
  third.configure(config);
  assert.deepEqual(
    third.state().pages.map((p) => p.pageId),
    [b.pageId],
  );
  await third.close(b.pageId);
  const empty = makeRuntime();
  empty.configure(config);
  assert.equal(empty.state().pages.length, 0);
});

test('account switching and disable preserve separate sessions', async (t) => {
  const { makeRuntime, config } = setup(t);
  const runtime = makeRuntime();
  runtime.configure(config);
  const a = await runtime.create({ workflowId: 'agent', url: 'https://example.com/private' });
  runtime.configure({ ...config, userId: 'two' });
  assert.equal(runtime.state().pages.length, 0);
  await runtime.create({ workflowId: 'agent', url: 'https://example.com/other' });
  runtime.configure({ enabled: false });
  runtime.configure(config);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    runtime.state().pages.map((p) => p.pageId),
    [a.pageId],
  );
});

test('shutdown events cannot overwrite the saved session', async (t) => {
  const { makeRuntime, config } = setup(t);
  const runtime = makeRuntime();
  runtime.configure(config);
  const page = await runtime.create({ workflowId: 'agent', url: 'https://example.com/' });
  runtime.suspendSessionPersistence();
  await runtime.close(page.pageId);
  await runtime.closeAll();
  const restarted = makeRuntime();
  restarted.configure(config);
  assert.equal(restarted.state().pages[0].pageId, page.pageId);
});

test('invalid entries and unsafe URLs are rejected and volatile state resets', async (t) => {
  const { dir, makeRuntime, config } = setup(t);
  const runtime = makeRuntime();
  runtime.configure(config);
  const page = await runtime.create({ workflowId: 'agent' });
  const path = join(dir, 'browser-sessions', readdirSync(join(dir, 'browser-sessions'))[0]);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      pages: [
        null,
        {},
        { ...page, url: 'javascript:alert(1)' },
        { ...page, url: 'https://example.com/', loading: 'error', canGoBack: true, generation: 77 },
        page,
      ],
      activeByWorkflow: { agent: 'missing' },
    }),
  );
  const restarted = makeRuntime();
  restarted.configure(config);
  assert.equal(restarted.state().pages.length, 1);
  assert.equal(restarted.state().pages[0].loading, 'idle');
  assert.equal(restarted.state().pages[0].canGoBack, false);
  assert.equal(restarted.state().pages[0].generation, 0);
  assert.equal(restarted.state().activeByWorkflow.agent, page.pageId);
});

test('popup and background pages are excluded', async (t) => {
  const { dir, makeRuntime, config } = setup(t);
  const runtime = makeRuntime();
  runtime.configure(config);
  const shared = await runtime.create({ workflowId: 'agent' });
  const state = runtime.state();
  state.pages.push(
    { ...shared, pageId: 'popup', mode: 'popup' },
    { ...shared, pageId: 'background', mode: 'background' },
  );
  state.activeByWorkflow.agent = 'popup';
  const store = new BrowserSessionStore(dir);
  store.save(shared.partition, state);
  const restored = store.load(shared.partition);
  assert.deepEqual(
    restored.pages.map((p) => p.pageId),
    [shared.pageId],
  );
  assert.equal(restored.activeByWorkflow.agent, shared.pageId);
});

test('a popup in front at shutdown restores its opener as the selected tab', async (t) => {
  const { dir, makeRuntime, config } = setup(t);
  const runtime = makeRuntime();
  runtime.configure(config);
  const first = await runtime.create({ workflowId: 'agent' });
  const opener = await runtime.create({ workflowId: 'agent' });
  const state = runtime.state();
  state.pages.push(
    { ...opener, pageId: 'popup', mode: 'popup', openerPageId: opener.pageId },
    { ...opener, pageId: 'popup-of-popup', mode: 'popup', openerPageId: 'popup' },
  );
  state.activeByWorkflow.agent = 'popup-of-popup';
  const store = new BrowserSessionStore(dir);
  store.save(opener.partition, state);
  const restored = store.load(opener.partition);
  assert.deepEqual(
    restored.pages.map((p) => p.pageId),
    [first.pageId, opener.pageId],
  );
  assert.equal(restored.activeByWorkflow.agent, opener.pageId);
});
