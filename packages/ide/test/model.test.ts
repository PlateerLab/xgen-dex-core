// IDE 의 순수 논리 — 경로·트리·퍼지·텍스트·git 파생값·단축키.
import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, dirname, extname, invalidName, isWithin, join, normalize, uniqueCopyName } from '../src/paths';
import { ancestors, buildTree, filePaths, findNode, visibleRows } from '../src/tree';
import { fuzzyFilter, fuzzyMatch } from '../src/fuzzy';
import { decodeText, encodeText, isImagePath, looksBinary } from '../src/text';
import { changeCount, decorations, gitErrorMessage, relativeTime, toWorkspacePath, type GitStatus } from '../src/git-model';
import { ChordMatcher, eventKey, formatBinding, matchesStroke, parseStroke } from '../src/keys';
import { shallowEqual } from '../src/components/hooks';

test('경로 — 정규화·부모·이름·확장자·포함', () => {
  assert.equal(normalize('/a//b/./c/'), 'a/b/c');
  assert.equal(normalize('a/b/../c'), 'a/c');
  assert.equal(join('a', '', 'b.txt'), 'a/b.txt');
  assert.equal(dirname('a/b/c.txt'), 'a/b');
  assert.equal(dirname('c.txt'), '');
  assert.equal(basename('a/b/c.txt'), 'c.txt');
  assert.equal(extname('a/B.TS'), 'ts');
  assert.equal(extname('.bashrc'), '');
  assert.ok(isWithin('a/b/c', 'a/b'));
  assert.ok(!isWithin('a/bc', 'a/b'), '이름이 비슷한 형제는 안이 아니다');
  assert.ok(isWithin('x', ''));
});

test('경로 — 복사 이름과 쓸 수 없는 이름', () => {
  assert.equal(uniqueCopyName('a.txt', new Set()), 'a.txt');
  assert.equal(uniqueCopyName('a.txt', new Set(['a.txt'])), 'a copy.txt');
  assert.equal(uniqueCopyName('a.txt', new Set(['a.txt', 'a copy.txt'])), 'a copy 2.txt');
  assert.equal(uniqueCopyName('dir', new Set(['dir'])), 'dir copy');
  assert.equal(invalidName('ok.py'), null);
  assert.equal(invalidName('sub/new.py'), null, '폴더까지 한 번에 만들 수 있다');
  assert.ok(invalidName(''));
  assert.ok(invalidName('..'));
  assert.ok(invalidName('a/../b'));
  assert.ok(invalidName('a\\b'));
});

test('트리 — 파일 경로로 폴더를 채우고, 폴더 먼저·숫자 순으로 줄 세운다', () => {
  const root = buildTree([
    { path: 'src/b10.ts', isDir: false },
    { path: 'src/b2.ts', isDir: false },
    { path: 'README.md', isDir: false },
    { path: 'empty', isDir: true },
    { path: 'src/lib/a.ts', isDir: false },
    { path: 'Zeta.txt', isDir: false },
  ]);
  assert.deepEqual(root.children.map((c) => c.name), ['empty', 'src', 'README.md', 'Zeta.txt']);
  const src = findNode(root, 'src')!;
  assert.deepEqual(src.children.map((c) => c.name), ['lib', 'b2.ts', 'b10.ts']);
  assert.deepEqual(filePaths(root).sort(), ['README.md', 'Zeta.txt', 'src/b10.ts', 'src/b2.ts', 'src/lib/a.ts']);
  const rows = visibleRows(root, new Set(['src']));
  assert.deepEqual(
    rows.map((r) => `${r.depth}:${r.node.name}`),
    ['0:empty', '0:src', '1:lib', '1:b2.ts', '1:b10.ts', '0:README.md', '0:Zeta.txt'],
  );
  assert.deepEqual(ancestors('a/b/c.txt'), ['a', 'a/b']);
});

test('트리 — 같은 경로가 폴더로도 파일로도 오면 폴더가 이긴다', () => {
  const root = buildTree([
    { path: 'x/y.txt', isDir: false },
    { path: 'x', isDir: true },
  ]);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].isDir, true);
});

test('퍼지 — 순서대로 나오면 맞고, 이름 안의 일치가 앞선다', () => {
  assert.equal(fuzzyMatch('xyz', 'abc'), null);
  assert.ok(fuzzyMatch('idx', 'src/index.ts'));
  const ranked = fuzzyFilter(['docs/indexing-guide.md', 'src/index.ts', 'lib/x/idx.ts'], 'index', (s) => s);
  assert.equal(ranked[0].item, 'src/index.ts');
  const m = fuzzyMatch('st', 'src/store.ts')!;
  assert.deepEqual(m.positions.map((p) => 'src/store.ts'[p]), ['s', 't']);
});

test('텍스트 — 줄 끝과 BOM 을 그대로 되돌린다', () => {
  const crlf = new TextEncoder().encode('a\r\nb\r\n');
  const d = decodeText(crlf);
  assert.equal(d.eol, 'CRLF');
  assert.deepEqual(encodeText(d.text, d.eol, d.bom), crlf);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('한글\n')]);
  const b = decodeText(bom);
  assert.equal(b.bom, true);
  assert.equal(b.text, '한글\n');
  assert.deepEqual(encodeText(b.text, b.eol, b.bom), bom);
});

test('텍스트 — NUL 이나 UTF-8 이 아닌 바이트가 있으면 텍스트로 열지 않는다', () => {
  assert.equal(looksBinary(new TextEncoder().encode('hello 한글')), false);
  assert.equal(looksBinary(new Uint8Array([0x68, 0, 0x69])), true);
  const tailLatin1 = new Uint8Array(20000).fill(0x61);
  tailLatin1[19999] = 0xe9; // 뒤쪽만 다른 인코딩 — 앞부분만 보면 속는다
  assert.equal(looksBinary(tailLatin1), true);
  assert.ok(isImagePath('a/b.PNG'));
  assert.ok(!isImagePath('a/b.ts'));
});

const status = (over: Partial<GitStatus>): GitStatus => ({
  repo: '',
  branch: { head: 'main', oid: 'x', upstream: '', ahead: 0, behind: 0 },
  state: '',
  staged: [],
  changes: [],
  untracked: [],
  conflicts: [],
  stash_count: 0,
  remotes: [],
  identity: { name: '', email: '' },
  last_commit: null,
  ...over,
});

test('git — 탐색기 표시는 저장소 기준 경로를 workspace 로 옮기고 가장 무거운 상태를 고른다', () => {
  const s = status({
    repo: 'libs/x',
    staged: [{ path: 'src/a.ts', status: 'added' }],
    changes: [{ path: 'src/a.ts', status: 'modified' }],
    untracked: [{ path: 'new.txt', status: 'untracked' }],
  });
  const { files, dirs } = decorations([s]);
  assert.equal(files.get('libs/x/src/a.ts')?.letter, 'M');
  assert.equal(files.get('libs/x/new.txt')?.letter, 'U');
  assert.equal(dirs.get('libs/x/src'), 'modified');
  assert.equal(dirs.get('libs'), 'modified');
  assert.equal(changeCount(s), 2);
  assert.equal(toWorkspacePath('', 'a'), 'a');
  assert.match(gitErrorMessage('auth', ''), /토큰/);
  assert.equal(relativeTime(1000, 1000 * 1000 + 30_000), '방금');
});

test('단축키 — Mod 는 맥이면 Cmd, 한글 배열에서도 물리 키로 맞춘다', () => {
  const s = parseStroke('Mod+Shift+P');
  const ev = { key: 'ㅔ', code: 'KeyP', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
  assert.ok(matchesStroke(ev, s, false));
  assert.ok(!matchesStroke(ev, s, true));
  assert.equal(eventKey({ key: '`', code: 'Backquote' }), '`');
  assert.equal(formatBinding('Mod+Shift+P', false), 'Ctrl+Shift+P');
  assert.equal(formatBinding('Mod+Shift+P', true), '⇧⌘P');
});

test('단축키 — 두 번 누르는 조합', () => {
  const m = new ChordMatcher({ saveAll: 'Mod+K S', save: 'Mod+S' } as const, false);
  const k = { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  const s = { key: 's', code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(m.feed(k), 'pending');
  assert.equal(m.feed(s), 'saveAll');
  assert.equal(m.feed({ ...s, ctrlKey: true }), 'save');
});

test('선택자 비교 — Set·Map 은 같은 것일 때만 같다(펼친 폴더가 바뀌면 다시 그린다)', () => {
  assert.equal(shallowEqual(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(shallowEqual(new Map(), new Map()), false);
  const same = new Set(['x']);
  assert.equal(shallowEqual(same, same), true);
  assert.equal(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }), true);
  assert.equal(shallowEqual([1, 2], [1, 2]), true);
  assert.equal(shallowEqual([1, 2], [1, 3]), false);
});
