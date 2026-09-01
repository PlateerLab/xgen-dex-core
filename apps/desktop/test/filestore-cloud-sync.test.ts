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

  async changes(_since: number): Promise<ChangesResponse> {
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
