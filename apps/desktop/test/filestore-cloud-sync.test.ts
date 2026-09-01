// 클라우드 = 파일 저장소 전환 — 전용 transport 의 와이어 계약, 로컬 폴더째
// 삭제의 원격 반영(rmdir prune), 백엔드 전환 시 base 세대 분리(stateTag).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilestoreSyncTransport } from '../src/main/sync-transport';
import { SyncPair, type SyncRemote } from '../src/main/local-sync';
import { LocalSyncManager } from '../src/main/local-sync-manager';
import type { ChangesResponse, RemoteChange } from '../src/main/sync-protocol';
import { createHash } from 'node:crypto';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ── FilestoreSyncTransport 와이어 계약 ──────────────────────────────

function makeTransport(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const transport = new FilestoreSyncTransport(
    {
      baseUrl: 'https://xgen.example',
      token: async () => 'tok',
      workflowId: 'user:7',
      deviceId: 'dev',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return handler(url, init);
      }) as never,
    } as never,
    mkdtempSync(join(tmpdir(), 'fst-')),
  );
  return { transport, calls };
}

test('transport — changes/put/del/rmdir 이 /api/filestore/sync/* 를 부른다', async () => {
  const { transport, calls } = makeTransport((url) => {
    if (url.pathname.endsWith('/changes')) {
      return new Response(JSON.stringify({ latest_seq: 5, changes: [] }), { status: 200 });
    }
    if (url.pathname.endsWith('/file')) {
      return new Response(JSON.stringify({ sha256: 'abc' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const ch = await transport.changes(3);
  assert.equal(ch.latest_seq, 5);
  assert.equal(calls[0].url.pathname, '/api/filestore/sync/changes');
  assert.equal(calls[0].url.searchParams.get('since'), '3');

  const dir = mkdtempSync(join(tmpdir(), 'fst-'));
  writeFileSync(join(dir, 'f.txt'), '내용');
  const put = await transport.put('폴더/f.txt', join(dir, 'f.txt'), 'base123');
  assert.equal(put.sha256, 'abc');
  const putCall = calls.find((c) => c.url.pathname.endsWith('/file'))!;
  assert.equal(putCall.init?.method, 'PUT');
  assert.equal(putCall.url.searchParams.get('path'), '폴더/f.txt');
  assert.equal(putCall.url.searchParams.get('base_sha'), 'base123');

  await transport.del('폴더/f.txt', 'base123');
  const delCall = calls.find((c) => c.url.pathname.endsWith('/entry'))!;
  assert.equal(delCall.init?.method, 'DELETE');

  await transport.rmdir('폴더');
  const rmCall = calls.find((c) => c.url.pathname.endsWith('/folder'))!;
  assert.equal(rmCall.init?.method, 'DELETE');
  assert.equal(rmCall.url.searchParams.get('path'), '폴더');

  rmSync(dir, { recursive: true, force: true });
});

test('transport — put 409 는 SyncConflictError(status 409)로 떨어진다', async () => {
  const { transport } = makeTransport(() =>
    new Response(JSON.stringify({ detail: { current_sha: 'srv-sha' } }), { status: 409 }),
  );
  const dir = mkdtempSync(join(tmpdir(), 'fst-'));
  writeFileSync(join(dir, 'f.txt'), 'x');
  await assert.rejects(
    transport.put('f.txt', join(dir, 'f.txt'), 'stale'),
    (e: Error & { status?: number }) => e.status === 409,
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── 로컬 폴더째 삭제 → 원격 빈 폴더 정리 ───────────────────────────

class PruneRemote implements SyncRemote {
  files = new Map<string, Buffer>();
  rmdirs: string[] = [];
  seq = 1;

  async changes(since: number): Promise<ChangesResponse> {
    // 파일 저장소 서버와 같은 스냅숏 커서 의미론: since==seq 는 무변경,
    // 어긋난 커서는 stale_cursor 로 전체 재스냅숏을 유도한다.
    if (since > 0 && since === this.seq) return { latest_seq: this.seq, changes: [] };
    if (since > 0) return { latest_seq: this.seq, changes: [], stale_cursor: true };
    const changes: RemoteChange[] = [...this.files.entries()].map(([path, buf], i) => ({
      path,
      is_dir: false,
      size: buf.length,
      mtime_ns: 1_000_000_000,
      sha256: sha(buf),
      seq: i + 1,
      deleted: false,
    }));
    return { latest_seq: this.seq, changes };
  }
  async download(path: string, toAbs: string): Promise<void> {
    writeFileSync(toAbs, this.files.get(path) as Buffer);
  }
  async put(path: string, fromAbs: string): Promise<{ sha256: string }> {
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(fromAbs);
    this.files.set(path, buf);
    this.seq++;
    return { sha256: sha(buf) };
  }
  async del(path: string): Promise<void> {
    this.files.delete(path);
    this.seq++;
  }
  async mkdir(): Promise<void> {
    /* no-op */
  }
  async rmdir(path: string): Promise<void> {
    this.rmdirs.push(path);
  }
}

function pair(root: string, remote: SyncRemote) {
  return new SyncPair({
    remote,
    dir: join(root, 'ws'),
    statePath: join(root, 'state.json'),
    deviceName: 'test-pc',
  });
}

test('로컬에서 폴더째 삭제 — 파일 삭제 후 사라진 조상 폴더를 원격에도 정리한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const remote = new PruneRemote();
  remote.files.set('보고서/2026/a.txt', Buffer.from('a'));
  remote.files.set('보고서/2026/b.txt', Buffer.from('b'));
  const p = pair(root, remote);
  try {
    await p.sync(); // 하이드레이트
    assert.ok(existsSync(join(root, 'ws', '보고서', '2026', 'a.txt')));

    rmSync(join(root, 'ws', '보고서'), { recursive: true, force: true }); // 폴더째 삭제
    await p.sync();

    assert.equal(remote.files.size, 0); // 파일은 서버에서도 삭제
    // 사라진 조상 폴더 정리 요청 — 하위부터 상위까지 닿는다.
    assert.ok(remote.rmdirs.includes('보고서/2026'), `rmdirs=${remote.rmdirs}`);
    assert.ok(remote.rmdirs.includes('보고서'), `rmdirs=${remote.rmdirs}`);
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('파일 하나만 지우면 — 로컬에 남은 폴더는 원격에서도 걷지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const remote = new PruneRemote();
  remote.files.set('보고서/a.txt', Buffer.from('a'));
  remote.files.set('보고서/b.txt', Buffer.from('b'));
  const p = pair(root, remote);
  try {
    await p.sync();
    rmSync(join(root, 'ws', '보고서', 'a.txt')); // 파일 하나만
    await p.sync();
    assert.equal(remote.files.size, 1);
    assert.deepEqual(remote.rmdirs, []); // 폴더는 로컬에 살아 있다 — 정리 없음
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('rmdir 미구현 원격(geny) — 폴더째 삭제여도 조용히 건너뛴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const remote = new PruneRemote();
  (remote as { rmdir?: unknown }).rmdir = undefined;
  remote.files.set('폴더/x.txt', Buffer.from('x'));
  const p = pair(root, remote);
  try {
    await p.sync();
    rmSync(join(root, 'ws', '폴더'), { recursive: true, force: true });
    const r = await p.sync(); // rmdir 없음 — 오류 없이 파일 삭제만
    assert.equal(r.deletedRemote, 1);
    assert.equal(r.errors.length, 0);
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ── 백엔드 전환 시 base 세대 분리 ──────────────────────────────────

test('stateTag — 태그가 다르면 base 상태 파일도 다르다 (옛 base 재사용 금지)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tag-'));
  const stateDir = join(root, '.state');
  const remote = new PruneRemote();
  const make = (stateTag?: string) =>
    new LocalSyncManager({
      config: () => ({
        enabled: true,
        root,
        targets: [{ workflowId: 'user:7', label: '파일 저장소', folder: 'cloud', stateTag }],
      }),
      loggedIn: () => true,
      remoteFor: () => remote as unknown as SyncRemote,
      stateDir: () => stateDir,
      deviceName: 'test-pc',
      intervalMs: 0,
      fullSweepMs: 0,
    });

  const m1 = make(undefined);
  m1.reconcile();
  await m1.syncNow('user:7');
  m1.stop();

  const m2 = make('filestore');
  m2.reconcile();
  await m2.syncNow('user:7');
  m2.stop();

  const files = readdirSync(stateDir).sort();
  // 구세대(무태그)와 신세대(filestore) base 가 **서로 다른 파일**이다.
  assert.equal(files.length, 2, `state files=${files}`);
  assert.ok(files.some((f) => f.includes('@filestore')), `files=${files}`);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ── 대량 삭제 서킷브레이커 ─────────────────────────────────────────

test('대량 서버 삭제 보류 — 로컬이 통째로 비면 지우지 않고 보류한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mass-'));
  const remote = new PruneRemote();
  for (let i = 0; i < 12; i++) remote.files.set(`d/f${i}.txt`, Buffer.from(`v${i}`));
  const p = pair(root, remote);
  try {
    await p.sync(); // 하이드레이트 (base 12)
    rmSync(join(root, 'ws'), { recursive: true, force: true }); // 로컬 전체 소실 흉내

    const r = await p.sync();
    assert.equal(remote.files.size, 12); // 서버는 그대로 — 보류
    assert.equal(r.deletedRemote, 0);
    assert.equal(r.deferred, 12);
    assert.match(r.errors[0], /대량 서버 삭제 보류/);

    // 사용자가 의도를 확인([지금 동기화] = force)하면 통과한다.
    const r2 = await p.sync({ allowMassDelete: true });
    assert.equal(r2.deletedRemote, 12);
    assert.equal(remote.files.size, 0);
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('서버→로컬 삭제는 미러 그대로 흐른다 — 원본(저장소)이 비면 로컬도 빈다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mass-'));
  const remote = new PruneRemote();
  for (let i = 0; i < 12; i++) remote.files.set(`d/f${i}.txt`, Buffer.from(`v${i}`));
  const p = pair(root, remote);
  try {
    await p.sync();
    // 서버(원본)에서 전부 삭제된 상황 — 로컬은 통로일 뿐, 보류 없이 따라간다.
    remote.files.clear();
    remote.seq++;

    const r = await p.sync();
    assert.equal(r.deletedLocal, 12);
    assert.equal(r.errors.length, 0);
    assert.ok(!existsSync(join(root, 'ws', 'd', 'f0.txt')));
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('소규모 삭제는 보류 없이 그대로 전파된다 (폴더 삭제 UX 유지)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mass-'));
  const remote = new PruneRemote();
  for (let i = 0; i < 12; i++) remote.files.set(`keep/f${i}.txt`, Buffer.from('k'));
  remote.files.set('del/a.txt', Buffer.from('a'));
  remote.files.set('del/b.txt', Buffer.from('b'));
  const p = pair(root, remote);
  try {
    await p.sync();
    rmSync(join(root, 'ws', 'del'), { recursive: true, force: true }); // 일부 폴더만
    const r = await p.sync();
    assert.equal(r.deletedRemote, 2); // 임계(10개·90%) 미만 — 즉시 전파
    assert.equal(r.errors.length, 0);
  } finally {
    p.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ── 백엔드 세대 전환 — 옛 클라우드 로컬 사본 백업 ─────────────────

test('세대 전환 — 옛 geny 로컬 사본은 정리되고 새 폴더가 저장소를 그대로 비춘다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gen-'));
  const stateDir = join(root, '.state');
  const { mkdirSync, writeFileSync: wf } = await import('node:fs');
  mkdirSync(stateDir, { recursive: true });
  // 옛 세대의 흔적: 무태그 base 상태 파일 + 옛 백엔드 산출물이 든 cloud 폴더.
  wf(join(stateDir, 'user_7@cloud.json'), '{"cursor":9,"base":{}}');
  mkdirSync(join(root, 'cloud', '.Trash-1000'), { recursive: true });
  wf(join(root, 'cloud', '옛기기폴더.txt'), 'geny 잔재');

  const remote = new PruneRemote();
  remote.files.set('저장소파일.txt', Buffer.from('filestore'));
  const m = new LocalSyncManager({
    config: () => ({
      enabled: true,
      root,
      targets: [{ workflowId: 'user:7', label: '파일 저장소', folder: 'cloud', stateTag: 'filestore' }],
    }),
    loggedIn: () => true,
    remoteFor: () => remote as unknown as SyncRemote,
    stateDir: () => stateDir,
    deviceName: 'test-pc',
    intervalMs: 0,
    fullSweepMs: 0,
  });
  try {
    m.reconcile();
    await m.syncNow('user:7');

    // 로컬은 통로 — 옛 잔재는 그냥 정리된다 (원본은 파일 저장소에 있다).
    assert.ok(!existsSync(join(root, 'cloud', '옛기기폴더.txt')));
    assert.ok(!existsSync(join(root, 'cloud', '.Trash-1000')));
    // 새 cloud 폴더 = 파일 저장소의 깨끗한 미러.
    assert.ok(existsSync(join(root, 'cloud', '저장소파일.txt')));
    // 잔재가 저장소로 업로드되지 않았다.
    assert.deepEqual([...remote.files.keys()], ['저장소파일.txt']);

    // 두 번째 reconcile — 재정리 없음 (새 세대 state 가 이미 있고 미러는 유지).
    m.reconcile();
    await m.syncNow('user:7');
    assert.ok(existsSync(join(root, 'cloud', '저장소파일.txt')));
  } finally {
    m.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
