// 대화별 휴대폰 폴더 — 장부·이름·가상 경로 해석·요청 모양.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MobileFolderBook,
  NO_FOLDER_MESSAGE,
  folderIdOf,
  resolveFolderPath,
  toWire,
  uniqueName,
  type MobileFolder,
} from '../src/lib/mobile-folders';

const notes: MobileFolder = { id: 'n', name: 'Notes', uri: 'content://tree/notes' };
const photos: MobileFolder = { id: 'p', name: 'Photos', uri: 'content://tree/photos' };

test('이름은 대화 안에서 겹치지 않게 — 대소문자만 달라도 겹친 것', () => {
  assert.equal(uniqueName('Notes', []), 'Notes');
  assert.equal(uniqueName('Notes', ['notes']), 'Notes (2)');
  assert.equal(uniqueName('Notes', ['Notes', 'Notes (2)']), 'Notes (3)');
  assert.equal(uniqueName('a/b', []), 'a b'); // 구분자는 가상 경로를 깨뜨린다
  assert.equal(uniqueName('..', []), '폴더');
});

test('가상 경로 — /<폴더>/…, 상대 경로와 빈 경로는 첫 폴더', () => {
  assert.deepEqual(resolveFolderPath([notes, photos], '/Photos/a/b.jpg'), {
    folder: photos,
    rel: 'a/b.jpg',
    display: '/Photos/a/b.jpg',
  });
  assert.equal(resolveFolderPath([notes, photos], 'x.txt').display, '/Notes/x.txt');
  assert.equal(resolveFolderPath([notes, photos], '').display, '/Notes');
  assert.equal(resolveFolderPath([notes, photos], '/photos/a').folder, photos); // 대소문자 관용
  assert.equal(resolveFolderPath([notes], 'a\\b.txt').rel, 'a/b.txt');
});

test('가상 경로 — 연결 밖·상위 이동·폴더 없음은 거부', () => {
  assert.throws(() => resolveFolderPath([notes], '/Download/a.txt'), /PATH_DOMAIN_MISMATCH/);
  assert.throws(() => resolveFolderPath([notes], '../a.txt'), /PATH_DOMAIN_MISMATCH/);
  assert.throws(() => resolveFolderPath([notes], '/Notes/./a'), /PATH_DOMAIN_MISMATCH/);
  assert.throws(() => resolveFolderPath([], 'a.txt'), (e: Error) => e.message === NO_FOLDER_MESSAGE);
});

test('서버 요청의 local_folders — path 는 가상 경로', () => {
  assert.deepEqual(toWire([notes, photos]), [
    { id: 'n', name: 'Notes', path: '/Notes' },
    { id: 'p', name: 'Photos', path: '/Photos' },
  ]);
});

test('장부 — 대화마다 따로, 같은 폴더는 한 번, 이름은 겹치지 않게', () => {
  const saved: unknown[] = [];
  const seen: Array<[string, string[]]> = [];
  const book = new MobileFolderBook({ persist: (snap) => saved.push(snap) });
  book.onChange((id, folders) => seen.push([id, folders.map((f) => f.name)]));

  book.add('chat-1', [{ uri: 'content://a/Docs', name: 'Docs' }]);
  book.add('chat-1', [
    { uri: 'content://a/Docs', name: 'Docs' }, // 같은 폴더
    { uri: 'content://b/Docs', name: 'Docs' }, // 이름만 같은 다른 폴더
  ]);
  assert.deepEqual(book.list('chat-1').map((f) => f.name), ['Docs', 'Docs (2)']);
  assert.equal(book.list('chat-1')[0].id, folderIdOf('content://a/Docs'));
  assert.deepEqual(book.list('chat-2'), []);
  assert.ok(book.inUse('content://b/Docs'));

  book.remove('chat-1', book.list('chat-1')[0].id);
  assert.deepEqual(book.list('chat-1').map((f) => f.uri), ['content://b/Docs']);
  book.forget('chat-1');
  assert.ok(!book.inUse('content://b/Docs'));
  // 남은 폴더는 이름이 그대로다 — 가상 경로가 바뀌면 지난 대화의 경로가 틀어진다.
  assert.deepEqual(seen.map(([, names]) => names), [['Docs'], ['Docs', 'Docs (2)'], ['Docs (2)'], []]);
  assert.equal(saved.length, 4);
});

test('장부 — 저장본을 읽고, iOS 북마크 갱신을 저장하며, 오래된 대화부터 잊는다', () => {
  let now = 0;
  const saved: unknown[] = [];
  const book = new MobileFolderBook({ persist: (s) => saved.push(s), now: () => ++now, maxConversations: 2 });
  book.load({
    old: { folders: [{ uri: 'file:///a/', name: 'A', bookmark: 'b1' }], updatedAt: 1 },
    broken: { folders: 'x' },
  });
  assert.deepEqual(Object.keys(book.snapshot()), ['old']);
  book.updateBookmark('file:///a/', 'b2');
  assert.equal(book.list('old')[0].bookmark, 'b2');
  assert.equal(saved.length, 1);
  now = 10;
  book.set('n1', [{ uri: 'u1', name: 'x' }]);
  book.set('n2', [{ uri: 'u2', name: 'y' }]);
  assert.deepEqual(Object.keys(book.snapshot()).sort(), ['n1', 'n2']);
});
