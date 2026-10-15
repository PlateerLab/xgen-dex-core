/**
 * 대화별 폴더 연결 — 데스크톱 장부 저장소(main/chat-folders).
 *
 * 폴더는 계정과 대화에 붙는다. 같은 PC 에서 다른 계정으로 로그인하면 이 계정의
 * 폴더가 보이지 않아야 하고, 앱을 다시 켜도 연결이 남아 있어야 한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatFolderStore } from '../src/main/chat-folders';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dex-chat-folders-'));
  const store = join(base, 'store');
  const proj = join(base, 'proj');
  const docs = join(base, 'docs');
  await mkdir(proj);
  await mkdir(docs);
  await writeFile(join(base, 'file.txt'), 'not a folder');
  return { base, store, proj, docs, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('로그인 전에는 목록이 비고, 더하려 하면 이유를 말한다', async () => {
  const f = await fixture();
  try {
    const folders = new ChatFolderStore(f.store, () => null);
    assert.deepEqual(folders.list('chat-1'), []);
    assert.throws(() => folders.add('chat-1', [f.proj]), /로그인/);
  } finally {
    await f.cleanup();
  }
});

test('대화마다 폴더를 더하고 빼며, 폴더가 아닌 경로는 버린다', async () => {
  const f = await fixture();
  try {
    const folders = new ChatFolderStore(f.store, () => 'https://x|7');
    const seen: Array<[string, number]> = [];
    folders.onChange((id, list) => seen.push([id, list.length]));
    folders.add('chat-1', [f.proj, join(f.base, 'file.txt'), join(f.base, 'nope')]);
    assert.deepEqual(folders.list('chat-1').map((x) => x.path), [f.proj]);
    assert.deepEqual(folders.list('chat-2'), []);
    folders.add('chat-1', [f.docs]);
    const [first] = folders.list('chat-1');
    folders.remove('chat-1', first.id);
    assert.deepEqual(folders.list('chat-1').map((x) => x.path), [f.docs]);
    folders.forget('chat-1');
    assert.deepEqual(folders.list('chat-1'), []);
    assert.deepEqual(seen, [
      ['chat-1', 1],
      ['chat-1', 2],
      ['chat-1', 1],
      ['chat-1', 0],
    ]);
  } finally {
    await f.cleanup();
  }
});

test('앱을 다시 켜도 연결이 남고, 계정마다 따로다', async () => {
  const f = await fixture();
  try {
    let account = 'https://x|7';
    const first = new ChatFolderStore(f.store, () => account);
    first.add('chat-1', [f.proj]);

    const reopened = new ChatFolderStore(f.store, () => account);
    assert.deepEqual(reopened.list('chat-1').map((x) => x.path), [f.proj]);

    account = 'https://x|8';
    assert.deepEqual(reopened.list('chat-1'), [], '다른 계정에 이 계정의 폴더가 보였다');
    account = 'https://x|7';
    assert.deepEqual(reopened.list('chat-1').map((x) => x.path), [f.proj]);
  } finally {
    await f.cleanup();
  }
});

test('사라진 폴더는 목록에 남되 찾을 수 없다고 표시한다', async () => {
  const f = await fixture();
  try {
    const folders = new ChatFolderStore(f.store, () => 'https://x|7');
    folders.add('chat-1', [f.proj, f.docs]);
    await rm(f.docs, { recursive: true });
    assert.deepEqual(
      folders.view('chat-1').map((x) => [x.name, x.missing]),
      [
        ['proj', false],
        ['docs', true],
      ],
    );
  } finally {
    await f.cleanup();
  }
});
