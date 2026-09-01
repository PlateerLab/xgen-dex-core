// 대형 워크스페이스(파일 수천 개) 전송 — 사이클 안 IO 가 제한 병렬로 도는지,
// 그리고 병렬화가 정확성(장부/보고서/진행률)을 깨지 않는지 고정한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncPair, type SyncProgress, type SyncRemote } from '../src/main/local-sync';
import type { ChangesResponse, RemoteChange } from '../src/main/sync-protocol';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 동시 실행 수를 계측하는 인메모리 서버 — 전송마다 잠깐 멈춰 겹침을 만든다. */
class MeteredRemote implements SyncRemote {
  files = new Map<string, { sha: string; content: Buffer }>();
  seq = 0;
  activeDownloads = 0;
  maxDownloads = 0;
  activePuts = 0;
  maxPuts = 0;
  failPutPaths = new Set<string>();

  serverWrite(path: string, content: string): void {
    const buf = Buffer.from(content);
    this.files.set(path, { sha: sha(buf), content: buf });
    this.seq++;
  }

  async changes(_since: number): Promise<ChangesResponse> {
    const changes: RemoteChange[] = [...this.files.entries()].map(([path, f], i) => ({
      path,
      is_dir: false,
      size: f.content.length,
      mtime_ns: 1_000_000_000,
      sha256: f.sha,
      seq: i + 1,
      deleted: false,
    }));
    return { latest_seq: this.seq, changes };
  }

  async download(path: string, toAbs: string): Promise<void> {
    this.activeDownloads++;
    this.maxDownloads = Math.max(this.maxDownloads, this.activeDownloads);
    await tick(10); // 네트워크 왕복 흉내 — 직렬이면 N×10ms 가 그대로 쌓인다
    const f = this.files.get(path);
    if (!f) {
      this.activeDownloads--;
      throw new Error(`404 ${path}`);
    }
    writeFileSync(toAbs, f.content);
    this.activeDownloads--;
  }

  async put(path: string, fromAbs: string, _baseSha: string): Promise<{ sha256: string }> {
    this.activePuts++;
    this.maxPuts = Math.max(this.maxPuts, this.activePuts);
    await tick(10);
    this.activePuts--;
    if (this.failPutPaths.has(path)) throw new Error(`서버 오류 ${path}`);
    const content = readFileSync(fromAbs);
    this.files.set(path, { sha: sha(content), content });
    this.seq++;
    return { sha256: sha(content) };
  }

  async del(): Promise<void> {
    /* no-op */
  }
  async mkdir(): Promise<void> {
    /* no-op */
  }
}

function makePair(root: string, remote: MeteredRemote, onProgress?: (p: SyncProgress) => void) {
  return new SyncPair({
    remote,
    dir: join(root, 'ws'),
    statePath: join(root, 'state.json'),
    deviceName: 'test-pc',
    onProgress,
  });
}

test('다운로드 — 제한 병렬로 겹쳐 돌고 전부 정확히 내려온다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'));
  const remote = new MeteredRemote();
  const N = 40;
  for (let i = 0; i < N; i++) remote.serverWrite(`src/f${i}.txt`, `내용-${i}`);
  const pair = makePair(root, remote);
  try {
    const r = await pair.sync();
    assert.equal(r.downloaded, N);
    assert.equal(r.errors.length, 0);
    // 병렬성: 1(직렬 회귀)보다 크고, 상한(8)을 넘지 않는다.
    assert.ok(remote.maxDownloads > 1, `병렬 다운로드가 없다 (max=${remote.maxDownloads})`);
    assert.ok(remote.maxDownloads <= 8, `상한 초과 (max=${remote.maxDownloads})`);
    // 내용 무결성 — 하나 골라 실제 바이트 확인.
    assert.equal(readFileSync(join(root, 'ws', 'src', 'f7.txt'), 'utf8'), '내용-7');
    assert.equal(readdirSync(join(root, 'ws', 'src')).length, N);
  } finally {
    pair.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('업로드 — 첫 사이클의 대량 로컬 파일도 병렬로 올라간다 (+scan 진행률)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'));
  const remote = new MeteredRemote();
  const N = 30;
  const events: SyncProgress[] = [];
  const pair = makePair(root, remote, (p) => events.push({ ...p }));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'ws'), { recursive: true });
  for (let i = 0; i < N; i++) writeFileSync(join(root, 'ws', `up${i}.txt`), `로컬-${i}`);
  try {
    const r = await pair.sync();
    assert.equal(r.uploaded, N);
    assert.ok(remote.maxPuts > 1, `병렬 업로드가 없다 (max=${remote.maxPuts})`);
    assert.ok(remote.maxPuts <= 8);
    assert.equal(remote.files.size, N);

    // scan 진행률: 전 파일 해싱이 done/total 로 보고된다 (직렬 침묵 금지).
    const scan = events.filter((e) => e.phase === 'scan' && e.total === N);
    assert.ok(scan.length > 0, 'scan 진행률이 없다');
    assert.equal(scan[scan.length - 1].done, N);
    // apply 진행률도 총량이 맞고 완료로 끝난다.
    const apply = events.filter((e) => e.phase === 'apply' && e.total === N);
    assert.equal(apply[apply.length - 1].done, N);
  } finally {
    pair.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('병렬 중 일부 실패 — 나머지는 완주하고 실패는 보고서에 남는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'));
  const remote = new MeteredRemote();
  const pair = makePair(root, remote);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'ws'), { recursive: true });
  for (let i = 0; i < 12; i++) writeFileSync(join(root, 'ws', `m${i}.txt`), `x-${i}`);
  remote.failPutPaths.add('m3.txt');
  remote.failPutPaths.add('m9.txt');
  try {
    const r = await pair.sync();
    assert.equal(r.uploaded, 10);
    assert.equal(r.deferred, 2); // 실패분은 보류 — 다음 사이클이 잡는다
    assert.equal(r.errors.length, 2);
    assert.ok(r.errors.every((e) => /m3\.txt|m9\.txt/.test(e)));
  } finally {
    pair.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('병렬 후 장부(base) 일관성 — 두 번째 사이클은 무동작이다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'));
  const remote = new MeteredRemote();
  for (let i = 0; i < 25; i++) remote.serverWrite(`d/f${i}.md`, `본문 ${i}`);
  const pair = makePair(root, remote);
  try {
    await pair.sync();
    const r2 = await pair.sync();
    // 병렬 적용이 base 를 흘렸다면 여기서 재다운로드/재업로드가 나타난다.
    assert.equal(r2.downloaded, 0);
    assert.equal(r2.uploaded, 0);
    assert.equal(r2.deletedLocal + r2.deletedRemote + r2.conflicts, 0);
  } finally {
    pair.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
