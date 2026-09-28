/** 대화별 폴더 장부 — 정규화·중복·상한·저장·알림. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationFolderBook,
  MAX_FOLDERS_PER_CONVERSATION,
  folderIdOf,
  localFoldersForRequest,
  makeLocalFolder,
  normalizeLocalFolders,
} from '../src/local-folders';

const root = tmpdir();
const a = join(root, 'proj-a');
const b = join(root, 'proj-b');

test('폴더는 절대 경로만 받고, 이름은 폴더 이름, id 는 경로에서 나온다', () => {
  const folder = makeLocalFolder(`${a}/`);
  assert.deepEqual(folder, { id: folderIdOf(a), name: 'proj-a', path: a });
  assert.equal(makeLocalFolder('relative/dir'), null);
  assert.equal(makeLocalFolder(''), null);
  assert.equal(makeLocalFolder('/bad\0path'), null);
  // 같은 폴더를 다시 연결해도 id 가 같다.
  assert.equal(makeLocalFolder(a)?.id, makeLocalFolder(a)?.id);
});

test('목록 정규화 — 문자열·객체를 받고 중복과 경로 없는 항목은 버린다', () => {
  const folders = normalizeLocalFolders([a, { path: a }, { name: '이름만' }, { path: b, name: '내 폴더' }, 42]);
  assert.deepEqual(folders.map((f) => [f.name, f.path]), [
    ['proj-a', a],
    ['내 폴더', b],
  ]);
  assert.deepEqual(normalizeLocalFolders('nope'), []);
  const many = Array.from({ length: MAX_FOLDERS_PER_CONVERSATION + 5 }, (_, i) => join(root, `f${i}`));
  assert.equal(normalizeLocalFolders(many).length, MAX_FOLDERS_PER_CONVERSATION);
});

test('Windows 경로는 대소문자만 다르면 같은 폴더다', { skip: platform() !== 'win32' }, () => {
  assert.equal(normalizeLocalFolders(['C:\\Work\\Docs', 'c:\\work\\docs']).length, 1);
});

test('장부 — 대화마다 따로 더하고 빼며, 바뀔 때만 저장·알린다', () => {
  const saved: unknown[] = [];
  const seen: Array<[string, string[]]> = [];
  const book = new ConversationFolderBook({ persist: (snap) => saved.push(snap) });
  book.onChange((id, folders) => seen.push([id, folders.map((f) => f.path)]));

  assert.deepEqual(book.add('chat-1', [a]).map((f) => f.path), [a]);
  assert.deepEqual(book.add('chat-1', [a, b]).map((f) => f.path), [a, b]);
  assert.deepEqual(book.list('chat-2'), []);
  // 이미 있는 폴더만 다시 더하면 바뀐 것이 없다 — 저장도 알림도 없다.
  book.add('chat-1', [b]);
  assert.equal(saved.length, 2);

  const idA = book.list('chat-1')[0].id;
  assert.deepEqual(book.remove('chat-1', idA).map((f) => f.path), [b]);
  book.forget('chat-1');
  assert.deepEqual(book.list('chat-1'), []);
  assert.deepEqual(seen, [
    ['chat-1', [a]],
    ['chat-1', [a, b]],
    ['chat-1', [b]],
    ['chat-1', []],
  ]);
  assert.deepEqual(book.snapshot(), {});
});

test('장부는 저장본을 읽고, 오래 손대지 않은 대화부터 잊는다', () => {
  let now = 0;
  const book = new ConversationFolderBook({ maxConversations: 2, now: () => ++now });
  book.load({
    old: { folders: [{ path: a }], updatedAt: 1 },
    broken: { folders: 'x' },
    '': { folders: [{ path: a }] },
  });
  assert.deepEqual(Object.keys(book.snapshot()), ['old']);
  now = 10;
  book.set('newer', [b]);
  book.set('newest', [a, b]);
  assert.deepEqual(Object.keys(book.snapshot()).sort(), ['newer', 'newest']);
});

test('서버 요청에 싣는 모양은 id·name·path 뿐이다', () => {
  const [folder] = normalizeLocalFolders([a]);
  assert.deepEqual(localFoldersForRequest([{ ...folder, extra: 1 } as never]), [
    { id: folder.id, name: 'proj-a', path: a },
  ]);
});
