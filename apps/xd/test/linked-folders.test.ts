import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { checkLinkedFolder, isAbsolutePath, isWithin } from '../src/main/linked-folders';

const ENGINE = resolve(__dirname, '..', 'engine');
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

function root() {
  const base = mkdtempSync(join(tmpdir(), 'xd-linked-'));
  const xd = join(base, 'XD');
  const state = join(xd, '.xd');
  mkdirSync(state, { recursive: true });
  mkdirSync(join(xd, 'workspace'));
  return { base, xd, state };
}

test('연결 폴더: 있는 폴더는 ok, 없어지면 missing(막지 않는다), 상대 경로는 안 된다', async () => {
  const { base, state } = root();
  const docs = join(base, 'docs');
  mkdirSync(docs);
  assert.deepEqual(await checkLinkedFolder(docs, state), { path: docs, status: 'ok' });
  rmSync(docs, { recursive: true });
  assert.equal((await checkLinkedFolder(docs, state)).status, 'missing');
  const file = join(base, 'a.txt');
  writeFileSync(file, 'x');
  assert.equal((await checkLinkedFolder(file, state)).status, 'missing');
  assert.equal((await checkLinkedFolder('docs', state)).status, 'relative');
  assert.equal((await checkLinkedFolder('', state)).status, 'relative');
});

test('연결 폴더: .xd 안도, .xd 를 품은 곳(루트·그 위·드라이브 맨 위)도 안 된다', async () => {
  const { base, xd, state } = root();
  assert.equal((await checkLinkedFolder(state, state)).status, 'inside_xd');
  assert.equal((await checkLinkedFolder(join(state, 'agents'), state)).status, 'inside_xd');
  assert.equal((await checkLinkedFolder(xd, state)).status, 'contains_xd');
  assert.equal((await checkLinkedFolder(base, state)).status, 'contains_xd');
  assert.equal((await checkLinkedFolder(parse(base).root, state)).status, 'contains_xd');
  // 작업 공간(.xd 의 형제)은 괜찮다
  assert.equal((await checkLinkedFolder(join(xd, 'workspace'), state)).status, 'ok');
});

test('연결 폴더: 심볼릭 링크는 실제 경로로 본다(그 아래 없는 경로도)', { skip: process.platform === 'win32' }, async () => {
  const { base, xd, state } = root();
  const toState = join(base, 'to-state');
  symlinkSync(state, toState);
  assert.equal((await checkLinkedFolder(toState, state)).status, 'inside_xd');
  assert.equal((await checkLinkedFolder(join(toState, 'not-yet'), state)).status, 'inside_xd');
  const toRoot = join(base, 'to-root');
  symlinkSync(xd, toRoot);
  assert.equal((await checkLinkedFolder(toRoot, state)).status, 'contains_xd');
});

test('isWithin: 같은 곳·안쪽·형제·점 두 개로 시작하는 이름', { skip: process.platform === 'win32' }, async () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b/c', '/a/b'), true);
  assert.equal(isWithin('/a/bc', '/a/b'), false);
  assert.equal(isWithin('/a', '/a/b'), false);
  // `..foo` 는 위로 가는 것이 아니라 안쪽 폴더 이름이다
  assert.equal(isWithin('/a/b/..foo', '/a/b'), true);
  assert.equal(isWithin('/a/..b/.xd', '/a/..b'), true);
});

test('Windows 경로: 대소문자 무시, 절대 경로는 드라이브·UNC 만', async () => {
  if (process.platform === 'win32') {
    assert.equal(isWithin('C:\\Users\\Me\\XD\\.XD', 'c:\\users\\me\\xd', 'win32'), true);
    assert.equal(isWithin('D:\\XD', 'C:\\XD', 'win32'), false);
  }
  assert.equal(isAbsolutePath('C:\\XD', 'win32'), true);
  assert.equal(isAbsolutePath('c:/XD', 'win32'), true);
  assert.equal(isAbsolutePath('\\\\server\\share', 'win32'), true);
  assert.equal(isAbsolutePath('\\\\server', 'win32'), false);
  assert.equal(isAbsolutePath('\\foo', 'win32'), false);
  assert.equal(isAbsolutePath('/foo', 'win32'), false);
  assert.equal(isAbsolutePath('C:foo', 'win32'), false);
  assert.equal(isAbsolutePath('/foo', 'linux'), true);
});

test('main 과 엔진이 같은 경로표에 같은 판정을 내린다', { skip: !python || process.platform === 'win32' }, async () => {
  const { base, xd, state } = root();
  mkdirSync(join(base, 'docs'));
  mkdirSync(join(base, '..dots'));
  mkdirSync(join(state, 'agents'));
  writeFileSync(join(base, 'file.txt'), 'x');
  symlinkSync(state, join(base, 'to-state'));
  symlinkSync(xd, join(base, 'to-root'));
  // 링크를 따라간 뒤의 `..` — 글자로 먼저 걷으면 다른 곳이 된다
  symlinkSync(join(state, 'agents'), join(base, 'to-agents'));
  // 끊어진 링크 — 가리키는 곳(.xd 안)으로 본다
  symlinkSync(join(state, 'not-there'), join(base, 'dangling'));
  const cases = [
    join(base, 'docs'),
    join(base, '..dots'),
    join(base, 'gone'),
    join(base, 'file.txt'),
    join(xd, 'workspace'),
    state,
    join(state, 'agents'),
    join(state, 'not-yet'),
    join(base, 'to-state'),
    join(base, 'to-state', 'not-yet'),
    join(base, 'to-root'),
    xd,
    base,
    parse(base).root,
    join(xd, '.XD'),
    `${join(base, 'to-agents')}/..`,
    `${join(base, 'to-agents')}/../agents`,
    join(base, 'dangling'),
    join(base, 'gone', '..', 'docs'),
    'relative/path',
  ];
  const ts = await Promise.all(cases.map(async (c) => (await checkLinkedFolder(c, state)).status));
  const program = [
    'import json, sys',
    'from xd_engine.layout import Layout, LayoutError',
    'layout = Layout.at(sys.argv[1])',
    'out = []',
    'for p in json.loads(sys.argv[2]):',
    '    missing = []',
    '    try:',
    '        got = layout.linked_folders([p], missing)',
    "        out.append('ok' if got else 'missing')",
    '    except LayoutError as e:',
    '        m = str(e)',
    "        out.append('inside_xd' if 'inside' in m else 'contains_xd' if 'contain' in m else 'relative' if 'absolute' in m else m)",
    'print(json.dumps(out))',
  ].join('\n');
  const res = spawnSync(python!, ['-c', program, xd, JSON.stringify(cases)], { cwd: ENGINE, encoding: 'utf8', env: { ...process.env, PYTHONPATH: ENGINE } });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout) as string[];
  assert.deepEqual(
    cases.map((c, i) => `${c} → ${ts[i]}`),
    cases.map((c, i) => `${c} → ${py[i]}`),
  );
  // 표가 실제로 갈래를 건드린다 — 둘 다 같은 한 가지로 같아서 통과하는 일이 없게
  assert.deepEqual(new Set(ts), new Set(['ok', 'missing', 'inside_xd', 'contains_xd', 'relative']));
});
