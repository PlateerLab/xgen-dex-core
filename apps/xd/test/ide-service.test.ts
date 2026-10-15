import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderId } from '../src/shared/folder-id';
import { decodeText, expand, globMatcher, IdeService, replace, replaceText, search, searchRegExp, searchText, tree } from '../src/main/ide-service';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'xd-ide-'));
  const workspaceDir = join(root, 'workspace');
  const stateDir = join(root, '.xd');
  mkdirSync(join(workspaceDir, 'A', 'src', 'deep'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ws = join(workspaceDir, 'A');
  writeFileSync(join(ws, 'README.md'), '# 안녕 Hello\nhello world\n');
  writeFileSync(join(ws, 'src', 'a.ts'), 'const hello = 1;\nconst helloWorld = 2;\n');
  writeFileSync(join(ws, 'src', 'deep', 'b.py'), 'print("HELLO")\n');
  writeFileSync(join(ws, 'logo.bin'), Buffer.from([0, 1, 2, 104, 101, 108, 108, 111]));
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'hello');
  mkdirSync(join(ws, '.git'), { recursive: true });
  writeFileSync(join(ws, '.git', 'HEAD'), 'hello');
  const docs = join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'note.txt'), 'hello from docs');
  const agents: Record<string, { workspace: string; folders: string[] }> = {
    a1: { workspace: 'A', folders: [docs, join(root, 'gone'), root] },
  };
  const svc = new IdeService({ store: { getAgent: (id: string) => (agents[id] as never) ?? null }, workspaceDir, stateDir });
  return { root, ws, docs, svc, agents };
}

test('tree: 작업 공간 전체를 한 줄 목록으로 — 숨김(.git)은 빼고, node_modules 는 이름만', async () => {
  const { ws } = setup();
  const paths = (await tree(ws)).map((e) => `${e.isDir ? 'd' : 'f'}:${e.path}`);
  assert.deepEqual(paths, ['d:node_modules', 'd:src', 'f:logo.bin', 'f:README.md', 'd:src/deep', 'f:src/a.ts', 'f:src/deep/b.py']);
  assert.equal((await tree(ws, 3)).length, 3);
});

test('tree: 작업 공간 밖으로 가는 링크는 펼치지 않는다', { skip: process.platform === 'win32' }, async () => {
  const { ws, docs } = setup();
  symlinkSync(docs, join(ws, 'out'));
  const paths = (await tree(ws)).map((e) => e.path);
  assert.ok(paths.includes('out'));
  assert.ok(!paths.includes('out/note.txt'));
});

test('찾기 규칙: 대소문자·낱말·정규식, 틀린 정규식은 bad_query', () => {
  const line = 'hello Hello helloWorld';
  const cols = (q: Parameters<typeof searchRegExp>[0]) => searchText(line, searchRegExp(q), 100).map((m) => m.col);
  assert.deepEqual(cols({ query: 'hello' }), [1, 7, 13]);
  assert.deepEqual(cols({ query: 'hello', case: true }), [1, 13]);
  assert.deepEqual(cols({ query: 'hello', word: true }), [1, 7]);
  assert.deepEqual(cols({ query: 'h.llo', regex: true, case: true }), [1, 13]);
  assert.deepEqual(cols({ query: 'h.llo' }), []);
  assert.throws(() => searchRegExp({ query: '(', regex: true }), (e: Error & { code?: string }) => e.code === 'bad_query');
  assert.throws(() => searchRegExp({ query: '' }), (e: Error & { code?: string }) => e.code === 'bad_query');
});

test('찾기: 열은 편집기와 같은 UTF-16 단위, 긴 줄은 일치 앞뒤만', () => {
  const [m] = searchText('😀 안녕 hello', searchRegExp({ query: 'hello' }), 10);
  assert.deepEqual([m.line, m.col, m.len], [1, 7, 5]); // 😀 는 UTF-16 두 칸
  const long = `${'x'.repeat(500)}needle${'y'.repeat(500)}`;
  const [n] = searchText(long, searchRegExp({ query: 'needle' }), 10);
  assert.equal(n.preview.slice(n.at, n.at + 6), 'needle');
  assert.ok(n.preview.length < 300);
});

test('파일 거르기: 이름 무늬는 어디서든, 경로 무늬는 그 아래, 쉼표로 여럿', () => {
  const ts = globMatcher('*.ts')!;
  assert.equal(ts('src/a.ts'), true);
  assert.equal(ts('src/a.tsx'), false);
  const src = globMatcher('src/**')!;
  assert.equal(src('src/deep/b.py'), true);
  assert.equal(src('README.md'), false);
  const many = globMatcher('*.md, deep')!;
  assert.equal(many('README.md'), true);
  assert.equal(many('src/deep/b.py'), true);
  assert.equal(globMatcher(''), null);
});

test('찾기: 작업 공간 전체 — 이진 파일·node_modules·.git 은 건너뛰고, 거르기와 상한을 지킨다', async () => {
  const { ws } = setup();
  const all = await search(ws, { query: 'hello' });
  assert.deepEqual(all.files.map((f) => f.path), ['README.md', 'src/a.ts', 'src/deep/b.py']);
  assert.equal(all.total, 5);
  assert.equal(all.truncated, false);
  const onlyTs = await search(ws, { query: 'hello', include: '*.ts' });
  assert.deepEqual(onlyTs.files.map((f) => f.path), ['src/a.ts']);
  const noSrc = await search(ws, { query: 'hello', exclude: 'src/**' });
  assert.deepEqual(noSrc.files.map((f) => f.path), ['README.md']);
  const capped = await search(ws, { query: 'hello', max: 2 });
  assert.equal(capped.total, 2);
  assert.equal(capped.truncated, true);
});

test('바꾸기: 글자 그대로(`$` 도 글자), 정규식이면 묶음, 바뀐 것만 적는다', async () => {
  const { ws } = setup();
  const plain = await replace(ws, { query: 'hello', case: true, replacement: '$1-hi', files: ['src/a.ts', 'README.md', 'nope.txt'] });
  assert.deepEqual(plain.changed, [
    { path: 'src/a.ts', count: 2 },
    { path: 'README.md', count: 1 },
  ]);
  assert.deepEqual(plain.skipped, [{ path: 'nope.txt', reason: 'unreadable' }]);
  assert.equal(readFileSync(join(ws, 'src', 'a.ts'), 'utf8'), 'const $1-hi = 1;\nconst $1-hiWorld = 2;\n');
  const grouped = await replace(ws, { query: '(\\w+)-hi', regex: true, replacement: '[$1]', files: ['src/a.ts'] });
  assert.deepEqual(grouped.changed, [{ path: 'src/a.ts', count: 2 }]);
  assert.equal(readFileSync(join(ws, 'src', 'a.ts'), 'utf8'), 'const $[1] = 1;\nconst $[1]World = 2;\n');
});

test('서비스: 작업 공간은 에이전트 것만, 연결 폴더는 저장된 경로 그대로만 — 없어진 폴더·.xd 를 품은 폴더는 열지 않는다', async () => {
  const { svc, agents } = setup();
  const files = (await svc.call('a1', 'workspace', 'tree')) as { path: string }[];
  assert.ok(files.some((f) => f.path === 'README.md'));
  const [docs, gone, rootFolder] = agents.a1.folders;
  const read = (await svc.call('a1', folderId(docs), 'read', { path: 'note.txt' })) as { bytes: Uint8Array };
  assert.equal(Buffer.from(read.bytes).toString(), 'hello from docs');
  await assert.rejects(svc.call('a1', folderId(gone), 'list', { dir: '' }), (e: Error & { code?: string }) => e.code === 'not_found');
  await assert.rejects(svc.call('a1', folderId(rootFolder), 'list', { dir: '' }), (e: Error & { code?: string }) => e.code === 'forbidden');
  // 저장된 연결 폴더가 아닌 경로는 열지 않는다(아무 경로나 열게 하지 않는다)
  await assert.rejects(svc.call('a1', folderId(`${docs}/`), 'list', { dir: '' }), (e: Error & { code?: string }) => e.code === 'not_found');
  await assert.rejects(svc.call('a1', '/', 'list', { dir: '' }), (e: Error & { code?: string }) => e.code === 'not_found');
  await assert.rejects(svc.call('nobody', 'workspace', 'tree'), (e: Error & { code?: string }) => e.code === 'not_found');
  // 폴더 밖으로는 못 나간다(folder-fs 의 경계)
  await assert.rejects(svc.call('a1', 'workspace', 'read', { path: '../../.xd/xd.db' }), (e: Error & { code?: string }) => e.code === 'forbidden');
  const roots = await svc.folders('a1');
  assert.deepEqual(
    roots.map((r) => [r.id, r.missing, r.status]),
    [
      [folderId(docs), false, 'ok'],
      [folderId(gone), true, 'missing'],
      [folderId(rootFolder), true, 'contains_xd'],
    ],
  );
});

test('찾기: 빈 일치가 이모지(서로게이트 쌍) 앞에 와도 멈추지 않는다', () => {
  for (const q of ['^', '\\b', 'x*', 'foo|', '(?=🚀)']) {
    const re = searchRegExp({ query: q, regex: true });
    assert.deepEqual(searchText('done🚀 launch 🚀', re, 100), [], q);
  }
  // 낱말 단위(유니코드 모드)에서도
  assert.deepEqual(searchText('🚀 rocket 🚀', searchRegExp({ query: 'rocket', word: true }), 10).map((m) => m.col), [4]);
  // 유니코드 모드가 받지 않는 정규식(`\-`)도 낱말 단위로 찾는다
  assert.equal(searchText('a-b a-bc', searchRegExp({ query: 'a\\-b', regex: true, word: true }), 10).length, 1);
});

test('바꾸기는 찾기가 보인 그대로 — 줄마다, 빈 일치는 그대로, 줄 끝 보존, $1 묶음', () => {
  const lit = (t: string, q: string, r: string) => replaceText(t, searchRegExp({ query: q, regex: true, case: true }), r, false);
  // 줄 끝 공백 지우기 — 마지막 줄만이 아니라 줄마다, 줄은 합치지 않는다
  assert.deepEqual(lit('a  \r\nb \nc', '\\s+$', ''), { text: 'a\r\nb\nc', count: 2 });
  // \s+ 는 줄 안에서만
  assert.deepEqual(lit('a b\nc  d\n', '\\s+', '_'), { text: 'a_b\nc_d\n', count: 2 });
  // 빈 일치(a*)는 건드리지 않는다
  assert.deepEqual(lit('xaz', 'a*', 'b'), { text: 'xbz', count: 1 });
  // ^ 는 줄마다
  assert.deepEqual(lit('a\nb', '^', '> '), { text: 'a\nb', count: 0 });
  assert.deepEqual(lit('ab\ncd', '^(\\w)', '[$1]'), { text: '[a]b\n[c]d', count: 2 });
  // 글자 그대로 바꾸기는 `$` 를 풀지 않는다
  assert.deepEqual(replaceText('price', searchRegExp({ query: 'price' }), '$1 $&', true), { text: '$1 $&', count: 1 });
});

test('글 읽기: UTF-8 이 아니면(EUC-KR 등) 건드리지 않고, BOM 은 따로', () => {
  assert.equal(decodeText(new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7])), null); // '안녕' EUC-KR
  assert.equal(decodeText(new Uint8Array([104, 0, 105])), null);
  assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), { text: 'hi', bom: true });
});

test('바꾸기: UTF-8 이 아닌 파일은 건너뛰고, BOM 은 남기고, 찾기 열은 BOM 을 빼고 센다', async () => {
  const { ws } = setup();
  writeFileSync(join(ws, 'euc.txt'), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xbe, 0xc8]));
  writeFileSync(join(ws, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]));
  const found = await search(ws, { query: 'hello', include: '*.txt' });
  assert.deepEqual(found.files.map((f) => [f.path, f.matches[0].col]), [['bom.txt', 1]]);
  const res = await replace(ws, { query: 'hello', replacement: 'bye', files: ['euc.txt', 'bom.txt'] });
  assert.deepEqual(res, { changed: [{ path: 'bom.txt', count: 1 }], skipped: [{ path: 'euc.txt', reason: 'not_text' }] });
  assert.deepEqual([...readFileSync(join(ws, 'bom.txt'))], [0xef, 0xbb, 0xbf, ...Buffer.from('bye')]);
  assert.deepEqual([...readFileSync(join(ws, 'euc.txt'))].slice(-2), [0xbe, 0xc8]);
});

test('찾기: 새 찾기가 오면 앞의 찾기는 그만둔다', async () => {
  const { ws } = setup();
  let calls = 0;
  const res = await search(ws, { query: 'hello' }, () => ++calls > 1);
  assert.equal(res.truncated, true);
  assert.ok(res.files.length <= 1);
});

test('tree: 링크가 돌아 같은 폴더를 다시 만나면 멈춘다', { skip: process.platform === 'win32' }, async () => {
  const { ws } = setup();
  symlinkSync(join(ws, 'src'), join(ws, 'src', 'deep', 'loop'));
  const paths = (await tree(ws)).map((e) => e.path);
  assert.ok(paths.includes('src/deep/loop'));
  assert.ok(!paths.some((p) => p.startsWith('src/deep/loop/')));
});

test('링크: 지우기·옮기기는 링크 자체에, 끊어진 링크로는 저장하지 않는다', { skip: process.platform === 'win32' }, async () => {
  const { svc, ws, root } = setup();
  symlinkSync(join(ws, 'src'), join(ws, 'src-link'));
  await svc.call('a1', 'workspace', 'fs', { op: { op: 'delete', paths: ['src-link'] } });
  assert.equal(existsSync(join(ws, 'src-link')), false);
  assert.equal(existsSync(join(ws, 'src', 'a.ts')), true); // 가리키던 폴더는 그대로
  symlinkSync(join(ws, 'README.md'), join(ws, 'readme-link'));
  await svc.call('a1', 'workspace', 'fs', { op: { op: 'rename', src: 'readme-link', dst: 'docs-link' } });
  assert.equal(lstatSync(join(ws, 'docs-link')).isSymbolicLink(), true);
  assert.equal(existsSync(join(ws, 'README.md')), true);
  // 폴더 밖의 없는 곳을 가리키는 끊어진 링크
  symlinkSync(join(root, 'outside-new.txt'), join(ws, 'dangling'));
  await assert.rejects(
    svc.call('a1', 'workspace', 'save', { path: 'dangling', bytes: new Uint8Array([1]), baseSha: null }),
    (e: Error & { code?: string }) => e.code === 'forbidden',
  );
  assert.equal(existsSync(join(root, 'outside-new.txt')), false);
});

test('연결 폴더 열쇠: 경로 ↔ 열쇠, `/` 없음, 틀린 열쇠는 null', async () => {
  const { folderOfId } = await import('../src/shared/folder-id');
  for (const p of ['/home/me/문서', 'C:\\Users\\me\\자료 폴더', '/a/b+c/=d']) {
    const id = folderId(p);
    assert.ok(!/[\/+=]/.test(id), id);
    assert.equal(folderOfId(id), p);
  }
  assert.equal(folderOfId('!!!'), null);
});

test('$ 풀이는 자바스크립트 바꾸기와 같다', () => {
  const cases: Array<[string, string, string]> = [
    ['(a)(b)', 'xaby', '[$1|$2|$&|$$|$`|$\'|$10|$3|$0|$<n>]'],
    ['(?<n>a)', 'xay', '<$<n>|$<m>|$1>'],
    ['a', 'xay', '$1 $< $'],
  ];
  for (const [src, text, tpl] of cases) {
    const re = new RegExp(src);
    const m = re.exec(text)!;
    assert.equal(text.slice(0, m.index) + expand(tpl, m, text) + text.slice(m.index + m[0].length), text.replace(re, tpl), `${src} ${tpl}`);
  }
});

test('유니코드 모드가 먼저 — `.` 가 이모지를 쪼개지 않고 \\p{L} 이 듣는다', () => {
  assert.deepEqual(replaceText('🚀', searchRegExp({ query: '(.)', regex: true }), '[$1]', false), { text: '[🚀]', count: 1 });
  assert.equal(searchText('한글 abc', searchRegExp({ query: '\\p{L}+', regex: true }), 10).length, 2);
  // 유니코드 모드가 받지 않는 정규식은 보통 모드로
  assert.equal(searchText('a-b', searchRegExp({ query: 'a\\-b', regex: true }), 10).length, 1);
});

test('지우기: 여럿 가운데 하나라도 폴더 밖이면 아무것도 지우지 않는다, 링크는 휴지통으로', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xd-ide-del-'));
  const ws = join(root, 'workspace', 'A');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(root, '.xd'));
  mkdirSync(join(root, 'outdir'));
  writeFileSync(join(root, 'outdir', 'secret'), 's');
  writeFileSync(join(ws, 'plain.txt'), 'p');
  symlinkSync(join(root, 'outdir'), join(ws, 'out'));
  symlinkSync(join(ws, 'plain.txt'), join(ws, 'plain-link'));
  const trashed: string[] = [];
  const svc = new IdeService({
    store: { getAgent: () => ({ workspace: 'A', folders: [] }) as never },
    workspaceDir: join(root, 'workspace'),
    stateDir: join(root, '.xd'),
    trash: async (abs) => void trashed.push(abs),
  });
  await assert.rejects(
    svc.call('a', 'workspace', 'fs', { op: { op: 'delete', paths: ['plain-link', 'out/secret'] } }),
    (e: Error & { code?: string }) => e.code === 'forbidden',
  );
  assert.equal(existsSync(join(ws, 'plain-link')), true);
  assert.deepEqual(trashed, []);
  await svc.call('a', 'workspace', 'fs', { op: { op: 'delete', paths: ['plain-link', 'plain-link'] } });
  assert.deepEqual(trashed, [join(ws, 'plain-link')]);
  await assert.rejects(
    svc.call('a', 'workspace', 'fs', { op: { op: 'rename', src: 'out', dst: 'nowhere/out' } }),
    (e: Error & { code?: string }) => e.code === 'not_found',
  );
});
