// 동기화 큐 — 페어들이 한꺼번에 돌지 않고 하나씩(concurrency), 대기 순번과
// 사이클 진행률이 status 로 나가는지 고정한다. (에이전트 100+ 환경의 계약)
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSyncManager } from '../src/main/local-sync-manager';
import type { SyncRemote } from '../src/main/local-sync';
import type { ChangesResponse } from '../src/main/sync-protocol';

/** changes() 가 명시 release 까지 멈추는 원격 — 큐 상태를 중간에 관찰하게 한다. */
class GatedRemote implements SyncRemote {
  calls = 0;
  private gate: Array<() => void> = [];
  gated = true;

  release(): void {
    const r = this.gate.shift();
    if (r) r();
  }
  releaseAll(): void {
    while (this.gate.length) this.release();
    this.gated = false;
  }
  async changes(_since: number): Promise<ChangesResponse> {
    this.calls++;
    if (this.gated) await new Promise<void>((r) => this.gate.push(r));
    return { latest_seq: 0, changes: [] };
  }
  async download(_path: string, _toAbs: string): Promise<void> {
    /* no-op */
  }
  async put(): Promise<{ sha256: string }> {
    return { sha256: '' };
  }
  async del(): Promise<void> {
    /* no-op */
  }
  async mkdir(): Promise<void> {
    /* no-op */
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 폴링 — 전체 스위트 부하에서 고정 tick 은 플레이크다. */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 시간 초과');
    await tick(15);
  }
}

function makeManager(root: string, remotes: Map<string, GatedRemote>, ids: string[]) {
  for (const id of ids) remotes.set(id, new GatedRemote());
  return new LocalSyncManager({
    config: () => ({
      enabled: true,
      root,
      targets: ids.map((id) => ({ workflowId: id, label: id, folder: id })),
    }),
    loggedIn: () => true,
    remoteFor: (id) => remotes.get(id) as unknown as SyncRemote,
    stateDir: () => join(root, '.state'),
    deviceName: 'test-pc',
    intervalMs: 0,
  });
}

test('큐 — 사이클은 하나씩 돌고, 나머지는 순번을 갖고 기다린다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'q-'));
  const remotes = new Map<string, GatedRemote>();
  const m = makeManager(root, remotes, ['a', 'b', 'c']);
  try {
    m.reconcile();
    // setup 디바운스 소화 — a 가 돌기 시작하고 b·c 가 줄에 설 때까지.
    await waitFor(() => {
      const xs = m.status().agents;
      return (
        xs.filter((x) => x.state === 'syncing').length === 1 &&
        xs.filter((x) => x.state === 'queued').length === 2
      );
    });

    // 동시에 도는 것은 하나뿐 — 첫 사이클(a)이 게이트에 잡혀 있는 동안
    // b·c 는 시작조차 하지 않아야 한다 (전부-동시 storm 재발 가드).
    let agents = m.status().agents;
    assert.equal(agents.filter((x) => x.state === 'syncing').length, 1);
    assert.equal(remotes.get('b')!.calls + remotes.get('c')!.calls, 0);

    const queued = agents.filter((x) => x.state === 'queued');
    assert.deepEqual(
      queued.map((x) => [x.workflowId, x.queuePosition]),
      [
        ['b', 1],
        ['c', 2],
      ],
    );

    // FIFO — 풀어주면 a → b → c 순서로 하나씩.
    remotes.get('a')!.release();
    await waitFor(
      () => m.status().agents.find((x) => x.workflowId === 'b')!.state === 'syncing',
    );
    assert.equal(m.status().agents.find((x) => x.workflowId === 'c')!.state, 'queued');

    for (const r of remotes.values()) r.releaseAll();
    await waitFor(() =>
      m.status().agents.every((x) => x.state === 'idle' && !!x.lastSyncAt),
    );
  } finally {
    m.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncNow(id) — 대기열 맨 앞에 끼어든다 (턴 크리티컬 경로)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'q-'));
  const remotes = new Map<string, GatedRemote>();
  const m = makeManager(root, remotes, ['a', 'b', 'c']);
  try {
    m.reconcile();
    await waitFor(() => m.status().agents.filter((x) => x.state === 'queued').length === 2); // a 실행 중, 큐 = [b, c]

    const cDone = m.syncNow('c'); // c 가 b 를 제치고 맨 앞으로
    const pos = (id: string) => m.status().agents.find((x) => x.workflowId === id)!;
    assert.equal(pos('c').queuePosition, 1);
    assert.equal(pos('b').queuePosition, 2);

    remotes.get('a')!.release();
    await waitFor(() => pos('c').state === 'syncing');
    assert.equal(pos('b').state, 'queued');

    for (const r of remotes.values()) r.releaseAll();
    await cDone;
  } finally {
    m.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('연타 접힘 — 실행 중 재요청은 "끝난 뒤 한 번 더" 하나로 합쳐진다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'q-'));
  const remotes = new Map<string, GatedRemote>();
  const m = makeManager(root, remotes, ['a']);
  try {
    m.reconcile();
    await waitFor(() => m.status().agents[0]?.state === 'syncing'); // 1번째 changes 가 게이트에 잡힘

    const w1 = m.syncNow('a');
    const w2 = m.syncNow('a');
    const w3 = m.syncNow('a');

    remotes.get('a')!.releaseAll();
    await Promise.all([w1, w2, w3]);
    // 첫 사이클 + 재실행 한 번 = 2. 세 번 연타가 세 사이클이 되면 안 된다.
    assert.equal(remotes.get('a')!.calls, 2);
    assert.equal(m.status().agents[0].state, 'idle');
  } finally {
    m.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop — 대기 중이던 syncNow 가 매달리지 않고 풀린다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'q-'));
  const remotes = new Map<string, GatedRemote>();
  const m = makeManager(root, remotes, ['a', 'b']);
  try {
    m.reconcile();
    await waitFor(() => m.status().agents.some((x) => x.state === 'queued')); // a 실행 중, b 대기

    const waiting = m.syncNow('b').then(
      () => 'resolved',
      () => 'rejected',
    );
    m.stop();
    remotes.get('a')!.releaseAll();
    // 페어가 걷혔으므로 b 의 대기는 즉시 정리된다 — 행이 걸리면 이 race 가 잡는다.
    const outcome = await Promise.race([
      waiting,
      new Promise((r) => setTimeout(() => r('hung'), 5000)),
    ]);
    assert.notEqual(outcome, 'hung');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('진행률 — apply 단계의 done/total 이 status 로 나간다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'q-'));

  // 다운로드가 게이트에 잡히는 원격 — apply 중간 상태를 관찰한다.
  class DownloadGated extends GatedRemote {
    downloads = 0;
    private dlGate: Array<() => void> = [];
    dlRelease(): void {
      const r = this.dlGate.shift();
      if (r) r();
    }
    override async changes(): Promise<ChangesResponse> {
      this.calls++;
      const file = (path: string, i: number) => ({
        path,
        is_dir: false,
        size: 1,
        mtime_ns: 1_000_000_000,
        sha256: `sha-${i}`,
        seq: i,
        deleted: false,
      });
      return { latest_seq: 2, changes: [file('one.txt', 1), file('two.txt', 2)] };
    }
    override async download(_path: string, toAbs: string): Promise<void> {
      this.downloads++;
      await new Promise<void>((r) => this.dlGate.push(r));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(toAbs, 'x');
    }
  }
  const remote = new DownloadGated();
  remote.gated = false;
  const m = new LocalSyncManager({
    config: () => ({
      enabled: true,
      root,
      targets: [{ workflowId: 'a', label: 'a', folder: 'a' }],
    }),
    loggedIn: () => true,
    remoteFor: () => remote as unknown as SyncRemote,
    stateDir: () => join(root, '.state'),
    deviceName: 'test-pc',
    intervalMs: 0,
  });
  try {
    m.reconcile();
    await waitFor(() => remote.downloads === 1); // 첫 다운로드가 게이트에 잡힘

    const a = m.status().agents[0];
    assert.equal(a.state, 'syncing');
    assert.deepEqual(a.progress, { phase: 'apply', done: 0, total: 2 });

    remote.dlRelease();
    await waitFor(() => m.status().agents[0].progress?.done === 1);
    assert.deepEqual(m.status().agents[0].progress, { phase: 'apply', done: 1, total: 2 });

    remote.dlRelease();
    await waitFor(() => m.status().agents[0].state === 'idle');
    const finalA = m.status().agents[0];
    assert.equal(finalA.state, 'idle');
    assert.equal(finalA.progress, undefined); // 끝나면 진행률은 걷는다
    assert.equal(finalA.last?.downloaded, 2);
  } finally {
    m.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
