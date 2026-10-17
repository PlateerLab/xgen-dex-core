import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSource, readFileHead } from '../src/file-source';

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

test('a file changed during the upload yields a short read (the engine stops)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-src-'));
  const path = join(dir, 'a.bin');
  await writeFile(path, new Uint8Array(100));
  const src = await fileSource(path);
  await writeFile(path, new Uint8Array(100).fill(1));
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await src.read(0, 10)).length, 0);
});
