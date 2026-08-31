// 로컬 동기화 엔진 — 실제 임시 폴더 + 가짜 서버로 왕복 시나리오를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SyncPair, type SyncRemote } from '../src/main/local-sync';
import type { ChangesResponse, RemoteChange } from '../src/main/sync-protocol';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** 인메모리 서버 — 인덱스 + 이벤트 로그 + base_sha 검증(409). */
class FakeRemote implements SyncRemote {
  files = new Map<string, { sha: string; content: Buffer }>();
  events: RemoteChange[] = [];
  seq = 0;
  staleCursorOnce = false;
  putFailOnce: string | null = null;

  serverWrite(path: string, content: string): void {
    const buf = Buffer.from(content);
    this.files.set(path, { sha: sha(buf), content: buf });
    this.events.push(this.ev(path, false));
  }
  serverDelete(path: string): void {
    this.files.delete(path);
    this.events.push(this.ev(path, true));
  }
  private ev(path: string, deleted: boolean): RemoteChange {
    const f = this.files.get(path);
    return {
      path,
      is_dir: false,
      size: f?.content.length ?? 0,
      mtime_ns: 1_000_000_000,
      sha256: f?.sha ?? '',
      seq: ++this.seq,
      deleted,
    };
  }

  async changes(since: number): Promise<ChangesResponse> {
    if (this.staleCursorOnce && since > 0) {
      this.staleCursorOnce = false;
      return { latest_seq: this.seq, changes: [], stale_cursor: true };
    }
    if (since === 0) {
      const alive = [...this.files.entries()].map(([path, f]) => ({
        path,
        is_dir: false,
        size: f.content.length,
        mtime_ns: 1_000_000_000,
        sha256: f.sha,
        seq: this.seq,
        deleted: false,
      }));
      return { latest_seq: this.seq, changes: alive };
    }
    return { latest_seq: this.seq, changes: this.events.filter((e) => e.seq > since) };
  }
  async download(path: string, toAbs: string): Promise<void> {
    const f = this.files.get(path);
    if (!f) throw new Error(`404 ${path}`);
    writeFileSync(toAbs, f.content);
  }
  async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
    if (this.putFailOnce === path) {
      this.putFailOnce = null;
      throw Object.assign(new Error('409'), { status: 409 });
    }
    const cur = this.files.get(path);
    if (cur && baseSha && cur.sha !== baseSha) {
      throw Object.assign(new Error('409 conflict'), { status: 409 });
    }
    const content = readFileSync(fromAbs);
    this.files.set(path, { sha: sha(content), content });
    this.events.push(this.ev(path, false));
    return { sha256: sha(content) };
  }
  async del(path: string, baseSha?: string): Promise<void> {
    const cur = this.files.get(path);
    if (cur && baseSha && cur.sha !== baseSha) {
      throw Object.assign(new Error('409 conflict'), { status: 409 });
    }
    this.serverDelete(path);
  }
  async mkdir(): Promise<void> {}
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'xgen-sync-'));
  const dir = join(root, 'ws');
  const remote = new FakeRemote();
  const pair = new SyncPair({
    remote,
    dir,
    statePath: join(root, 'state.json'),
    deviceName: 'TEST-PC',
    now: () => new Date(2026, 7, 21, 10, 0).getTime(),
  });
  const writeLocal = (rel: string, content: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  return { root, dir, remote, pair, writeLocal };
}

test('첫 동기화 — 서버 파일이 로컬 폴더에 내려온다 (하위 폴더 포함)', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('보고서.md', '# 보고서');
  remote.serverWrite('자료/데이터.csv', 'a,b');
  const r = await pair.sync();
  assert.equal(r.downloaded, 2);
  assert.equal(readFileSync(join(dir, '보고서.md'), 'utf8'), '# 보고서');
  assert.equal(readFileSync(join(dir, '자료', '데이터.csv'), 'utf8'), 'a,b');
  rmSync(root, { recursive: true, force: true });
});

test('로컬 새 파일이 서버로 올라간다', async () => {
  const { remote, pair, writeLocal, root } = setup();
  await pair.sync();
  writeLocal('메모.txt', '안녕');
  const r = await pair.sync();
  assert.equal(r.uploaded, 1);
  assert.equal(remote.files.get('메모.txt')?.content.toString(), '안녕');
  rmSync(root, { recursive: true, force: true });
});

test('무한 부활 방지 — 서버 삭제가 로컬 삭제로 전파되고, 되올라가지 않는다', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('지울파일.md', 'x');
  await pair.sync();
  remote.serverDelete('지울파일.md');
  const r = await pair.sync();
  assert.equal(r.deletedLocal, 1);
  assert.equal(existsSync(join(dir, '지울파일.md')), false);
  // 한 사이클 더 — 부활하면 여기서 uploaded > 0 이 된다.
  const r2 = await pair.sync();
  assert.equal(r2.uploaded, 0);
  assert.equal(remote.files.has('지울파일.md'), false);
  rmSync(root, { recursive: true, force: true });
});

test('로컬 삭제가 서버 tombstone 으로 전파된다', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('a.md', 'x');
  await pair.sync();
  rmSync(join(dir, 'a.md'));
  const r = await pair.sync();
  assert.equal(r.deletedRemote, 1);
  assert.equal(remote.files.has('a.md'), false);
  rmSync(root, { recursive: true, force: true });
});

test('충돌 — 서버 채택 + 로컬은 충돌 사본으로 서버에 보존', async () => {
  const { dir, remote, pair, writeLocal, root } = setup();
  remote.serverWrite('공유.md', '원본');
  await pair.sync();
  writeLocal('공유.md', '로컬 수정');
  remote.serverWrite('공유.md', '서버 수정');
  const r = await pair.sync();
  assert.equal(r.conflicts, 1);
  assert.equal(readFileSync(join(dir, '공유.md'), 'utf8'), '서버 수정');
  const copy = '공유 (충돌 TEST-PC 0821-1000).md';
  assert.equal(readFileSync(join(dir, copy), 'utf8'), '로컬 수정');
  assert.equal(remote.files.get(copy)?.content.toString(), '로컬 수정');
  rmSync(root, { recursive: true, force: true });
});

test('아무 변화 없으면 두 번째 사이클은 완전한 무동작이다', async () => {
  const { remote, pair, writeLocal, root } = setup();
  remote.serverWrite('a.md', 'x');
  await pair.sync();
  writeLocal('b.md', 'y');
  await pair.sync();
  const r = await pair.sync();
  assert.deepEqual(
    [r.downloaded, r.uploaded, r.deletedLocal, r.deletedRemote, r.conflicts, r.deferred],
    [0, 0, 0, 0, 0, 0],
  );
  rmSync(root, { recursive: true, force: true });
});

test('업로드 409 경합은 보류되고, 다음 사이클이 마무리한다', async () => {
  // 델타에는 아직 안 보이는데 서버 인덱스는 먼저 움직인 순간 — put 이 409 로
  // 거절된다. 엔진은 조용히 보류하고, 다음 사이클이 다시 판정한다.
  const { remote, pair, writeLocal, root } = setup();
  remote.serverWrite('경합.md', 'v1');
  await pair.sync();
  writeLocal('경합.md', '로컬 v2');
  remote.putFailOnce = '경합.md';
  const r1 = await pair.sync();
  assert.equal(r1.deferred, 1);
  assert.equal(r1.errors.length, 0); // 409 는 오류 목록에 올리지 않는다
  const r2 = await pair.sync();
  assert.equal(r2.uploaded, 1);
  assert.equal(remote.files.get('경합.md')?.content.toString(), '로컬 v2');
  rmSync(root, { recursive: true, force: true });
});

test('충돌 자체가 서버 우선으로 풀린다 — 양쪽 변경이 모두 보일 때', async () => {
  const { dir, remote, pair, writeLocal, root } = setup();
  remote.serverWrite('경합2.md', 'v1');
  await pair.sync();
  writeLocal('경합2.md', '로컬 v2');
  remote.serverWrite('경합2.md', '서버 v2');
  const r = await pair.sync();
  assert.equal(r.conflicts, 1);
  assert.equal(readFileSync(join(dir, '경합2.md'), 'utf8'), '서버 v2');
  rmSync(root, { recursive: true, force: true });
});

test('무시 대상(.git·node_modules)은 올라가지 않는다', async () => {
  const { remote, pair, writeLocal, root } = setup();
  await pair.sync();
  writeLocal('.git/HEAD', 'ref');
  writeLocal('node_modules/p/i.js', 'x');
  writeLocal('진짜.md', 'ok');
  const r = await pair.sync();
  assert.equal(r.uploaded, 1);
  assert.deepEqual([...remote.files.keys()], ['진짜.md']);
  rmSync(root, { recursive: true, force: true });
});

test('stale_cursor — 전체 스냅숏으로 다시 겨눠 놓친 삭제를 잡는다', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('a.md', 'x');
  remote.serverWrite('b.md', 'y');
  await pair.sync();
  // 서버가 a 를 지웠지만 tombstone 이 프룬되어 델타로는 안 보인다.
  remote.files.delete('a.md');
  remote.events = []; // 프룬
  remote.staleCursorOnce = true;
  const r = await pair.sync();
  assert.equal(r.deletedLocal, 1);
  assert.equal(existsSync(join(dir, 'a.md')), false);
  assert.equal(existsSync(join(dir, 'b.md')), true);
  rmSync(root, { recursive: true, force: true });
});

test('빈 부모 폴더는 파일 삭제 후 정리된다 (동기화 루트는 남는다)', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('깊은/폴더/파일.md', 'x');
  await pair.sync();
  remote.serverDelete('깊은/폴더/파일.md');
  await pair.sync();
  assert.equal(existsSync(join(dir, '깊은')), false);
  assert.equal(existsSync(dir), true);
  rmSync(root, { recursive: true, force: true });
});

test('동시 호출은 한 줄로 선다 — 도는 중의 sync() 는 재실행 예약이다', async () => {
  const { remote, pair, writeLocal, root } = setup();
  remote.serverWrite('a.md', 'x');
  const p1 = pair.sync();
  const p2 = pair.sync(); // 같은 사이클에 합류
  assert.equal(p1, p2);
  await p1;
  // 예약된 재실행이 끝나기를 기다린다 — 정리(rmSync) 뒤에 돌면 안 된다.
  await new Promise((r) => setImmediate(r));
  while (pair.busy) await new Promise((r) => setTimeout(r, 5));
  writeLocal('b.md', 'y');
  await pair.sync();
  assert.equal(remote.files.has('b.md'), true);
  pair.dispose();
  rmSync(root, { recursive: true, force: true });
});

test('서버 mtime 을 로컬에 입힌다 — 다음 스캔이 재해시하지 않는다', async () => {
  const { dir, remote, pair, root } = setup();
  remote.serverWrite('a.md', 'x');
  await pair.sync();
  const st = readdirSync(dir); // 존재 확인용
  assert.ok(st.includes('a.md'));
  // mtime_ns=1e9 → 1000ms
  const { mtimeMs } = require('node:fs').statSync(join(dir, 'a.md'));
  assert.equal(Math.floor(mtimeMs), 1000);
  rmSync(root, { recursive: true, force: true });
});
