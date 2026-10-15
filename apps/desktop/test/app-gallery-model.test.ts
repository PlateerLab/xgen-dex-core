/**
 * [앱] 탭·에이전트 [앱] 하위 탭이 함께 쓰는 규칙(app-gallery-model)과 변경 소식(app-sync,
 * workspace-watch).
 *
 * 두 화면이 같은 앱을 보여 주므로 이름표·상태·거름이 한 곳에서 나와야 하고, 한쪽에서 바꾼
 * 것을 다른 쪽이 곧바로 다시 읽어야 한다. 그 약속을 여기서 지킨다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppServingState, AppShareState, MyApp, MyAppsResult } from '@dex/protocol';
import {
  APP_CONFIRM,
  agentFilterOptions,
  appKey,
  appKindLabel,
  appStatus,
  filterMyApps,
  formatWhen,
  myAppsSummary,
  pageCount,
  patchMyApp,
  storeSummary,
  validAgentFilter,
  withServing,
  withShare,
} from '../src/renderer/src/apps/app-gallery-model';
import {
  announceAppChange,
  bindServerFeed,
  resetServerFeed,
  watchAppChanges,
} from '../src/renderer/src/apps/app-sync';
import { createWorkspaceWatch, type WorkspaceWatchBridge } from '../src/renderer/src/workspace-watch';

function app(over: Partial<MyApp> = {}): MyApp {
  return {
    slug: 'sales-board',
    kind: 'project',
    root: '',
    title: '분기 매출 보드',
    description: '채널별 매출',
    entry: '',
    ready: true,
    serving: true,
    stopped_by: '',
    stopped_at: null,
    shared: false,
    shared_by: '',
    shared_at: null,
    updated_at: null,
    issues: [],
    workflow_id: 'wf1',
    workflow_name: '매출 분석가',
    ...over,
  };
}

function result(apps: MyApp[]): MyAppsResult {
  return {
    apps,
    agents: [
      { workflow_id: 'wf1', workflow_name: '매출 분석가', count: 1 },
      { workflow_id: 'wf2', workflow_name: '문서 도우미', count: 1 },
    ],
    total: apps.length,
    shared: apps.filter((a) => a.shared).length,
    failed: [],
  };
}

test('앱 모양 이름은 웹과 같고, 모르는 값은 "앱" 이다', () => {
  assert.equal(appKindLabel('service'), '앱');
  assert.equal(appKindLabel('project'), '사이트');
  assert.equal(appKindLabel('component'), '화면');
  assert.equal(appKindLabel('weird'), '앱');
  assert.equal(appKindLabel(undefined), '앱');
});

test('상태는 배포 중지와 열 수 없음을 구분한다', () => {
  assert.deepEqual(appStatus({ serving: false, ready: false }), { key: 'stopped', label: '배포 중지' });
  // 멈춘 것이 먼저다 — 멈춘 앱은 ready 가 무엇이든 "배포 중지" 다.
  assert.deepEqual(appStatus({ serving: false, ready: true }), { key: 'stopped', label: '배포 중지' });
  assert.deepEqual(appStatus({ serving: true, ready: true }), { key: 'ready', label: '열림' });
  assert.deepEqual(appStatus({ serving: true, ready: false }), { key: 'broken', label: '열 수 없음' });
});

test('[내 앱] 거름 — 에이전트와 검색어(이름·설명·에이전트·폴더)', () => {
  const apps = [
    app(),
    app({ slug: 'doc-index', title: '문서 색인', description: '', workflow_id: 'wf2', workflow_name: '문서 도우미' }),
  ];
  assert.equal(filterMyApps(apps, '', '').length, 2);
  assert.deepEqual(filterMyApps(apps, 'wf2', '').map(appKey), ['wf2/doc-index']);
  assert.deepEqual(filterMyApps(apps, '', '  매출 ').map(appKey), ['wf1/sales-board']);
  assert.deepEqual(filterMyApps(apps, '', '도우미').map(appKey), ['wf2/doc-index']);
  assert.deepEqual(filterMyApps(apps, '', 'DOC-INDEX').map(appKey), ['wf2/doc-index']);
  assert.deepEqual(filterMyApps(apps, 'wf1', '색인'), []);
});

test('에이전트 고르개 — 전부(총 수) + 앱이 있는 에이전트', () => {
  const res = result([app()]);
  assert.deepEqual(agentFilterOptions(res), [
    { value: '', label: '모든 에이전트', count: 1 },
    { value: 'wf1', label: '매출 분석가', count: 1 },
    { value: 'wf2', label: '문서 도우미', count: 1 },
  ]);
  assert.deepEqual(agentFilterOptions(null), [{ value: '', label: '모든 에이전트', count: undefined }]);
});

test('사라진 에이전트로 거르고 있었다면 전부 보기로 돌아간다', () => {
  const res = result([app()]);
  assert.equal(validAgentFilter(res, 'wf2'), 'wf2');
  assert.equal(validAgentFilter(res, 'gone'), '');
  assert.equal(validAgentFilter(res, ''), '');
  // 아직 목록이 없으면 판단하지 않는다.
  assert.equal(validAgentFilter(null, 'gone'), 'gone');
});

test('요약·쪽 수', () => {
  assert.equal(myAppsSummary({ total: 5, shared: 2 }), '앱 5개 · 공개 2개');
  assert.equal(storeSummary(12), '공유된 앱 12개');
  assert.equal(pageCount(0, 24), 1);
  assert.equal(pageCount(24, 24), 1);
  assert.equal(pageCount(25, 24), 2);
});

test('배포 토글의 응답을 그대로 입힌다 — 멈추면 열리지 않는다', () => {
  const stopped: AppServingState = { ok: true, slug: 'sales-board', serving: false, stopped_by: '7', stopped_at: 100 };
  const off = withServing(app(), stopped);
  assert.equal(off.serving, false);
  assert.equal(off.ready, false);
  assert.equal(off.stopped_by, '7');
  assert.equal(off.stopped_at, 100);
  assert.deepEqual(appStatus(off), { key: 'stopped', label: '배포 중지' });
  // 다시 켠 앱이 열리는지는 매니페스트에 달렸다 — 여기서 정하지 않고 목록이 말하게 둔다.
  const started: AppServingState = { ok: true, slug: 'sales-board', serving: true, stopped_by: '', stopped_at: null };
  assert.equal(withServing(off, started).ready, false);
  assert.equal(withServing(off, started).serving, true);
});

test('공유 토글의 응답을 입히되 링크(토큰)는 목록에 두지 않는다', () => {
  const res: AppShareState = {
    ok: true,
    slug: 'sales-board',
    shared: true,
    shared_by: '7',
    shared_at: 200,
    token: 'secret',
    path: '/share/app/wf1/sales-board/secret',
  };
  const on = withShare(app(), res);
  assert.equal(on.shared, true);
  assert.equal(on.shared_at, 200);
  assert.equal(JSON.stringify(on).includes('secret'), false);
});

test('[내 앱] 에서 앱 한 개만 바꾸고, 없으면 그대로 둔다', () => {
  const res = result([app(), app({ slug: 'other' })]);
  const next = patchMyApp(res, 'wf1', 'other', (a) => ({ ...a, shared: true }));
  assert.equal(next.apps[1].shared, true);
  assert.equal(next.apps[0], res.apps[0]);
  assert.equal(patchMyApp(res, 'wf9', 'other', (a) => a), res);
});

test('때 표시', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  assert.equal(formatWhen(null, now), '');
  assert.equal(formatWhen(now / 1000 - 10, now), '방금');
  assert.equal(formatWhen(now / 1000 - 5 * 60, now), '5분 전');
  assert.equal(formatWhen(now / 1000 - 3 * 3600, now), '3시간 전');
  assert.match(formatWhen(now / 1000 - 3 * 86400, now), /2026/);
});

test('확인 문구는 사람의 말이다 — 줄표도, 내부 용어도 없다', () => {
  for (const text of Object.values(APP_CONFIRM)) {
    assert.doesNotMatch(text, /—|서빙|slug|workflow/);
  }
  assert.match(APP_CONFIRM.undeploy, /^배포를 중지할까요\?\n/);
});

// ── 변경 소식 ─────────────────────────────────────────────────

function fakeBridge() {
  const watched = new Map<string, string>();
  const log: string[] = [];
  let emit: (key: string) => void = () => {};
  const bridge: WorkspaceWatchBridge = {
    watch: (key, workflowId) => {
      watched.set(key, workflowId);
      log.push(`watch ${workflowId}`);
    },
    unwatch: (key) => {
      log.push(`unwatch ${watched.get(key)}`);
      watched.delete(key);
    },
    onChanged: (cb) => {
      emit = cb;
      return () => {};
    },
  };
  const fire = (workflowId: string) => {
    for (const [key, wf] of watched) if (wf === workflowId) emit(key);
  };
  return { bridge, watched, log, fire };
}

test('같은 에이전트를 여러 화면이 들어도 소켓은 하나고, 마지막이 떠날 때 닫는다', () => {
  const { bridge, log, fire } = fakeBridge();
  const subscribe = createWorkspaceWatch(() => bridge);
  let a = 0;
  let b = 0;
  const offA = subscribe('wf1', () => (a += 1));
  const offB = subscribe('wf1', () => (b += 1));
  assert.deepEqual(log, ['watch wf1']);
  fire('wf1');
  assert.deepEqual([a, b], [1, 1]);
  offA();
  offA(); // 두 번 풀어도 남의 구독을 건드리지 않는다
  fire('wf1');
  assert.deepEqual([a, b], [1, 2]);
  assert.deepEqual(log, ['watch wf1']);
  offB();
  assert.deepEqual(log, ['watch wf1', 'unwatch wf1']);
  // 다시 들으면 새로 연다.
  subscribe('wf1', () => {});
  assert.deepEqual(log, ['watch wf1', 'unwatch wf1', 'watch wf1']);
});

test('통로가 없으면(렌더러 밖) 조용히 아무것도 하지 않는다', () => {
  const subscribe = createWorkspaceWatch(() => undefined);
  const off = subscribe('wf1', () => {});
  off();
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('잇단 소켓 알림은 모아서 한 번만 다시 읽는다', async () => {
  const { bridge, fire } = fakeBridge();
  const subscribe = createWorkspaceWatch(() => bridge);
  let reads = 0;
  const off = watchAppChanges(['wf1'], () => (reads += 1), { subscribe, delayMs: 20 });
  fire('wf1');
  fire('wf1');
  fire('wf1');
  await tick(50);
  assert.equal(reads, 1);
  off();
  fire('wf1');
  await tick(50);
  assert.equal(reads, 1, '그만 들은 뒤에는 읽지 않는다');
});

test('창 안의 소식 — 자기 소식은 듣지 않고, 남의 에이전트 소식은 anyAgent 일 때만', async () => {
  const { bridge } = fakeBridge();
  const subscribe = createWorkspaceWatch(() => bridge);
  const me = {};
  let view = 0;
  let page = 0;
  const offView = watchAppChanges(['wf1'], () => (view += 1), { subscribe, self: me, delayMs: 10 });
  const offPage = watchAppChanges([], () => (page += 1), { subscribe, anyAgent: true, delayMs: 10 });

  announceAppChange('wf1', me);
  await tick(30);
  assert.deepEqual([view, page], [0, 1], '에이전트 [앱] 하위 탭이 알린 것은 [앱] 탭만 다시 읽는다');

  announceAppChange('wf1', {});
  await tick(30);
  assert.deepEqual([view, page], [1, 2], '[앱] 탭이 알린 것은 그 에이전트의 하위 탭도 다시 읽는다');

  announceAppChange('wf2', {});
  await tick(30);
  assert.deepEqual([view, page], [1, 3], '다른 에이전트의 소식은 그 에이전트를 보는 화면만');
  offView();
  offPage();
});

test('서버의 apps 소식 — 앱이 없던 에이전트의 첫 앱도 [앱] 탭이 곧바로 다시 읽는다', async () => {
  resetServerFeed();
  let push: ((workflowId: string) => void) | undefined;
  let watched = 0;
  const feed = {
    watch: async () => {
      watched += 1;
      return { ok: true };
    },
    onChanged: (cb: (workflowId: string) => void) => {
      push = cb;
      return () => {};
    },
  };
  assert.equal(bindServerFeed(feed), true);
  assert.equal(bindServerFeed(feed), true, '두 번째는 다시 걸지 않는다');
  assert.equal(watched, 1, '목록 소켓은 한 번만 열어 달라고 한다');

  const { bridge } = fakeBridge();
  const subscribe = createWorkspaceWatch(() => bridge);
  let page = 0;
  let view = 0;
  // [앱] 탭은 앱이 있는 에이전트만 소켓으로 듣는다(여기서는 하나도 없다).
  const offPage = watchAppChanges([], () => (page += 1), { subscribe, anyAgent: true, delayMs: 10 });
  const offView = watchAppChanges(['wf-other'], () => (view += 1), { subscribe, delayMs: 10 });
  push?.('wf-new');
  await tick(30);
  assert.deepEqual([page, view], [1, 0], '새 에이전트의 소식 — [앱] 탭만, 다른 에이전트 화면은 그대로');
  offPage();
  offView();
  resetServerFeed();
});
