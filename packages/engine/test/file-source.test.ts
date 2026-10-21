import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, rename, rm, stat, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { FileSourceChangedError, FileSourceNotRegularError, fileSource, readFileHead } from '../src/file-source';

test('fileSource reads exact ranges from disk and reports the size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  const path = join(dir, '회의 영상.mp4');
  const data = new Uint8Array(10_000).map((_, i) => i % 251);
  await writeFile(path, data);
  const src = await fileSource(path, { type: 'video/mp4' });
  assert.equal(src.name, '회의 영상.mp4');
  assert.equal(src.size, 10_000);
  assert.equal(src.type, 'video/mp4');
  assert.deepEqual(await src.read(0, 4), data.subarray(0, 4));
  assert.deepEqual(await src.read(9_998, 100), data.subarray(9_998), 'short at EOF');
  assert.deepEqual(await readFileHead(path, 3), data.subarray(0, 3));
});

test('a file changed during the upload rejects instead of becoming a successful short read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  const path = join(dir, 'a.bin');
  await writeFile(path, new Uint8Array(100));
  const src = await fileSource(path);
  await writeFile(path, new Uint8Array(100).fill(1));
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  await assert.rejects(() => src.read(0, 10), FileSourceChangedError);
});

test('same-size same-mtime replacement is rejected by file identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  const replacement = join(dir, 'replacement.bin');
  await writeFile(path, 'original');
  const before = await stat(path);
  const src = await fileSource(path);
  await writeFile(replacement, 'replaced');
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  await assert.rejects(() => src.read(0, src.size), FileSourceChangedError);
});

test('fileSource exposes a stable resume identity only for the same filesystem object', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  const replacement = join(dir, 'replacement.bin');
  await writeFile(path, 'original');
  const before = await stat(path);
  const first = await fileSource(path);
  const reopened = await fileSource(path);
  assert.match(first.resumeIdentity ?? '', /^[a-f0-9]{64}$/);
  assert.equal(reopened.resumeIdentity, first.resumeIdentity);

  await writeFile(replacement, 'replaced');
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  const replaced = await fileSource(path);
  assert.notEqual(replaced.resumeIdentity, first.resumeIdentity);
});

test('in-place mutation is rejected even when mtime is restored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  await writeFile(path, 'original');
  const before = await stat(path);
  const src = await fileSource(path);
  await writeFile(path, 'replaced');
  await utimes(path, before.atime, before.mtime);
  await assert.rejects(() => src.read(0, src.size), FileSourceChangedError);
});

test('leaf symlink replacement cannot redirect an existing source', { skip: platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  const outside = join(dir, 'outside.bin');
  await writeFile(path, 'original');
  const src = await fileSource(path);
  await writeFile(outside, 'outside!');
  await rm(path);
  await symlink(outside, path, 'file');
  await assert.rejects(() => src.read(0, src.size), FileSourceChangedError);
});

test('a safe symlink is bound to its initial target', { skip: platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target.bin');
  const link = join(dir, 'link.bin');
  await writeFile(target, 'allowed');
  await symlink(target, link, 'file');
  const src = await fileSource(link);
  assert.equal(new TextDecoder().decode(await src.read(0, src.size)), 'allowed');
  assert.equal(src.name, 'link.bin');
});

test('zero-length and EOF reads remain valid for an unchanged source', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  const emptyPath = join(dir, 'empty.bin');
  await writeFile(path, 'abc');
  await writeFile(emptyPath, new Uint8Array());
  const src = await fileSource(path);
  const empty = await fileSource(emptyPath);
  assert.equal((await src.read(0, 0)).length, 0);
  assert.equal((await src.read(src.size, 10)).length, 0);
  assert.equal(empty.size, 0);
  assert.equal((await empty.read(0, 16)).length, 0);
});

test('an aborted source read still rejects with AbortError', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.bin');
  await writeFile(path, 'abc');
  const controller = new AbortController();
  const src = await fileSource(path, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => src.read(0, 1), { name: 'AbortError' });
});

test('a FIFO is rejected without blocking before the regular-file check', { skip: platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pipe');
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip(`mkfifo unavailable: ${made.stderr}`);
    return;
  }
  const started = Date.now();
  await assert.rejects(() => fileSource(path), FileSourceNotRegularError);
  assert.ok(Date.now() - started < 1_000, 'FIFO open blocked before the file-type check');
});
