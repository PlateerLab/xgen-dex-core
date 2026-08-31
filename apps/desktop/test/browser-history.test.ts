import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { BrowserHistoryStore, type BrowserHistoryRuntimeEvent } from '../src/main/browser-history';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { browserPartition } from '../src/main/browser-security';

test('방문 기록은 계정별로 저장되고 자동완성·삭제·재로드를 지원한다', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgen-browser-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = browserPartition('https://xgen.example.com', 'user-1');
  const second = browserPartition('https://xgen.example.com', 'user-2');
  const store = new BrowserHistoryStore(dir, { writeDelayMs: 60_000 });

  await store.record(first, 'https://docs.example.com/start', '문서 시작', 1_000);
  await store.record(first, 'https://docs.example.com/start', '문서 홈', 3_000);
  await store.record(first, 'https://other.example.com/', '다른 페이지', 5_000);
  await store.record(second, 'https://private.example.com/', '다른 계정', 7_000);

  const suggestions = await store.suggestions(first, 'docs', 8);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].title, '문서 홈');
  assert.equal(suggestions[0].visitCount, 2);
  assert.deepEqual(await store.suggestions(second, 'docs', 8), []);

  const before = await store.list(first, { limit: 20 });
  assert.equal(before.total, 3);
  assert.equal(before.items[0].url, 'https://other.example.com/');
  const latestDocs = before.items.find((item) => item.url.includes('docs.example.com'));
  assert.ok(latestDocs);
  assert.equal(await store.remove(first, { visitId: latestDocs.visitId }), true);
  assert.equal((await store.suggestions(first, 'docs'))[0].visitCount, 1);

  await store.flush(first);
  await store.flush(second);
  const reloaded = new BrowserHistoryStore(dir, { writeDelayMs: 60_000 });
  assert.equal((await reloaded.list(first)).total, 2);
  assert.equal((await reloaded.list(second)).total, 1);

  await reloaded.clear(first);
  assert.deepEqual(await reloaded.list(first), { items: [], total: 0 });
  assert.equal((await reloaded.list(second)).total, 1);
});

test('방문 기록은 중복 이벤트와 보존 한도를 적용한다', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgen-browser-history-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const partition = browserPartition('https://xgen.example.com', 'bounded-user');
  const store = new BrowserHistoryStore(dir, {
    maxPlaces: 2,
    maxVisits: 2,
    writeDelayMs: 60_000,
  });

  await store.record(partition, 'https://one.example.com/', 'One', 1_000);
  await store.record(partition, 'https://one.example.com/', 'One updated', 1_500);
  assert.equal((await store.list(partition)).total, 1, '1초 이내 같은 URL 이벤트는 한 번만 센다');

  await store.record(partition, 'https://two.example.com/', 'Two', 3_000);
  await store.record(partition, 'https://three.example.com/', 'Three', 5_000);
  assert.equal((await store.list(partition)).total, 2);
  assert.deepEqual(
    (await store.suggestions(partition, '')).map((item) => item.title),
    ['Three', 'Two'],
  );
});

test('런타임은 보이는 메인 프레임의 성공한 이동만 기록한다', () => {
  const runtime = new BrowserRuntime();
  const partition = browserPartition('https://xgen.example.com', 'runtime-user');
  const page = {
    info: {
      pageId: 'history-page',
      workflowId: 'workflow-history',
      workflowName: 'History Agent',
      mode: 'shared',
      url: 'https://example.com/first',
      title: 'First',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition,
      generation: 0,
    } as BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = page.info.url;
  let currentTitle = page.info.title;
  const contents = {
    id: 91,
    isDestroyed: () => false,
    getURL: () => currentUrl,
    getTitle: () => currentTitle,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
    setWindowOpenHandler: () => undefined,
    on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
    once: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
  };
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, typeof page>;
    bindContents: (runtimePage: typeof page, webContents: unknown) => void;
  };
  internals.enabled = true;
  internals.accountPartition = partition;
  internals.pages.set(page.info.pageId, page);
  const events: BrowserHistoryRuntimeEvent[] = [];
  runtime.setHistoryListener((event) => events.push(event));
  internals.bindContents(page, contents);

  handlers.get('did-finish-load')?.();
  assert.deepEqual(
    events.map((event) => event.type),
    ['visit'],
  );

  currentTitle = 'Updated title';
  handlers.get('page-title-updated')?.({}, currentTitle);
  assert.equal(events.at(-1)?.type, 'title');
  assert.equal(events.at(-1)?.title, 'Updated title');

  currentUrl = 'https://example.com/inside';
  handlers.get('did-navigate-in-page')?.({}, currentUrl, false);
  assert.equal(events.length, 2, '하위 프레임 이동은 무시한다');
  handlers.get('did-navigate-in-page')?.({}, currentUrl, true);
  assert.equal(events.at(-1)?.type, 'visit');
  assert.equal(events.at(-1)?.url, currentUrl);

  page.info.mode = 'background';
  handlers.get('did-finish-load')?.();
  assert.equal(events.length, 3, '백그라운드 페이지는 기록하지 않는다');
});
