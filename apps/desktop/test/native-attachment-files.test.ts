import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSelectedNativeAttachments } from '../src/main/native-attachment-files';

test('trusted picker reads copied bytes, NFC basenames and empty files without exposing paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-'));
  try {
    const name = '첨부.txt'; const path = join(dir, name);
    await writeFile(path, '파일 원문'); await writeFile(join(dir, 'empty.bin'), '');
    const selected = await readSelectedNativeAttachments([path, join(dir, 'empty.bin')], new AbortController().signal);
    assert.equal(selected[0].filename, name.normalize('NFC'));
    assert.equal(new TextDecoder().decode(selected[0].bytes), '파일 원문');
    assert.equal(selected[1].bytes.length, 0);
    assert.equal(selected[0].media_type, 'application/octet-stream');
    assert.deepEqual(Object.keys(selected[0]).sort(), ['bytes', 'filename', 'media_type']);
    assert.equal(JSON.stringify(selected).includes(dir), false);
    await writeFile(path, '변경한 원문');
    assert.equal(new TextDecoder().decode(selected[0].bytes), '파일 원문');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('directories, symlinks, missing and relative paths are rejected with generic path-free errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-'));
  try {
    const path = join(dir, 'private-file.txt'); await writeFile(path, 'private contents');
    await mkdir(join(dir, 'directory'));
    await symlink(path, join(dir, 'link'));
    for (const paths of [[join(dir, 'directory')], [join(dir, 'link')], [join(dir, 'missing-secret-name')], ['relative-private-file'],
      [`/${'a'.repeat(4096)}`]]) {
      await assert.rejects(readSelectedNativeAttachments(paths, new AbortController().signal), (error: Error) => {
        assert.equal(error.message.includes(dir), false); assert.equal(error.message.includes('private'), false);
        assert.equal(error.message.includes('missing-secret-name'), false); return true;
      });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('count and byte limits reject before retaining an oversized file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-'));
  try {
    const path = join(dir, 'oversize.bin'); await writeFile(path, '');
    await truncate(path, 104_857_601);
    await assert.rejects(readSelectedNativeAttachments([path], new AbortController().signal));
    await assert.rejects(readSelectedNativeAttachments(Array.from({ length: 11 }, () => path), new AbortController().signal));
    await truncate(path, 104_857_600);
    const small = join(dir, 'small.bin'); await writeFile(small, 'one byte over the total limit');
    await assert.rejects(readSelectedNativeAttachments([small, path], new AbortController().signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelled selection never reads or returns filesystem details', async () => {
  const controller = new AbortController(); controller.abort(new Error('/private/cancelled-file'));
  await assert.rejects(readSelectedNativeAttachments(['/private/cancelled-file'], controller.signal), (error: Error) => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.message.includes('/private'), false); return true;
  });
});

test('additional selection respects the remaining retained draft budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-'));
  try {
    const path = join(dir, 'remaining.bin'); await writeFile(path, '12345');
    const signal = new AbortController().signal;
    await assert.rejects(readSelectedNativeAttachments([path, path], signal, { max_files: 1, max_bytes: 10 }));
    await assert.rejects(readSelectedNativeAttachments([path], signal, { max_files: 1, max_bytes: 4 }));
    await assert.rejects(readSelectedNativeAttachments([path], signal, { max_files: 0, max_bytes: 10 }));
    const selected = await readSelectedNativeAttachments([path], signal, { max_files: 1, max_bytes: 5 });
    assert.equal(new TextDecoder().decode(selected[0].bytes), '12345');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
