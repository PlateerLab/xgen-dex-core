// IDE 저장소 — 문서·저장·충돌·탭·파일 작업. 호스트와 Monaco 는 가짜다(브라우저 없이).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { IdeStore } from '../src/store';
import { IdeError, type IdeFsOp, type IdeHost, type IdeStat } from '../src/types';

// ── 가짜 Monaco — 저장소가 쓰는 만큼만 ────────────────────────────────

class FakeModel {
  private value: string;
  private version = 1;
  private listeners: (() => void)[] = [];
  disposed = false;
  eol = 'LF';
  constructor(value: string, readonly uri: FakeUri) {
    this.value = value;
  }
  getValue() {
    return this.eol === 'CRLF' ? this.value.replace(/\r?\n/g, '\r\n') : this.value;
  }
  setValue(v: string) {
    this.value = v;
    this.version += 1;
    this.fire();
  }
  /** 사용자가 고친 것처럼. */
  edit(v: string) {
    this.value = v;
    this.version += 1;
    this.fire();
  }
  undoTo(version: number, v: string) {
    this.value = v;
    this.version = version;
    this.fire();
  }
  getAlternativeVersionId() {
    return this.version;
  }
  setEOL(e: number) {
    this.eol = e === 1 ? 'CRLF' : 'LF';
  }
  pushEOL(e: number) {
    this.setEOL(e);
    this.version += 1;
    this.fire();
  }
  onDidChangeContent(fn: () => void) {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter((f) => f !== fn)) };
  }
  pushStackElement() {}
  getFullModelRange() {
    return {};
  }
  pushEditOperations(_s: unknown, ops: { text: string }[]) {
    this.value = ops[0].text;
    this.version += 1;
    this.fire();
    return null;
  }
  getLanguageId() {
    return 'plaintext';
  }
  getOptions() {
    return { insertSpaces: true, tabSize: 2 };
  }
  decorations: { range: FakeRange; options: { linesDecorationsClassName?: string } }[] = [];
  deltaDecorations(_old: string[], next: { range: FakeRange; options: { linesDecorationsClassName?: string } }[]) {
    this.decorations = next;
    return next.map((_d, i) => `d${i}`);
  }
  dispose() {
    this.disposed = true;
    monacoModels.delete(this.uri.toString());
  }
  private fire() {
    for (const f of this.listeners) f();
  }
}

class FakeRange {
  constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {}
}

class FakeUri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  toString() {
    return `${this.scheme}://${this.path}?${this.query}`;
  }
}

const monacoModels = new Map<string, FakeModel>();
const fakeMonaco = {
  Range: FakeRange,
  Uri: { from: (c: { scheme: string; path: string; query?: string }) => new FakeUri(c.scheme, c.path, c.query) },
  editor: {
    EndOfLineSequence: { LF: 0, CRLF: 1 },
    OverviewRulerLane: { Left: 1 },
    getModel: (u: FakeUri) => monacoModels.get(u.toString()) ?? null,
    createModel: (text: string, _lang: unknown, u: FakeUri) => {
      const m = new FakeModel(text, u);
      monacoModels.set(u.toString(), m);
      return m;
    },
  },
};

// ── 가짜 호스트 ───────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
const shaOf = (s: string) => `sha(${s})`;

class FakeHost implements IdeHost {
  workflowId = 'wf1';
  agentName = '테스트';
  files = new Map<string, string>();
  saves: { path: string; base: string | null; text: string }[] = [];
  fsOps: IdeFsOp[] = [];
  asks: string[] = [];
  readonly = false;
  storageMap = new Map<string, string>();
  storage = { get: (k: string) => this.storageMap.get(k) ?? null, set: (k: string, v: string) => void this.storageMap.set(k, v) };

  async session() {
    return { readonly: this.readonly, terminals: [] };
  }
  async listFiles() {
    return [...this.files.keys()].map((path) => ({ path, isDir: false }));
  }
  async readFile(path: string) {
    const v = this.files.get(path);
    if (v == null) throw new IdeError('not_found', '없음', 404);
    return { bytes: enc(v), sha: shaOf(v), size: v.length };
  }
  async saveFile(path: string, bytes: Uint8Array, baseSha: string | null) {
    const text = new TextDecoder().decode(bytes);
    const cur = this.files.get(path);
    const curSha = cur == null ? '' : shaOf(cur);
    if (baseSha !== null && baseSha !== curSha) throw new IdeError('changed', '바뀜', 409, { current_sha: curSha });
    this.saves.push({ path, base: baseSha, text });
    this.files.set(path, text);
    return { sha: shaOf(text) };
  }
  async stat(paths: string[]) {
    const out: Record<string, IdeStat> = {};
    for (const p of paths) {
      const v = this.files.get(p);
      out[p] = v == null ? { kind: 'missing' } : { kind: 'file', sha: shaOf(v) };
    }
    return out;
  }
  async readRaw() {
    return new Uint8Array();
  }
  async fs(op: IdeFsOp) {
    this.fsOps.push(op);
    if (op.op === 'rename') {
      for (const [p, v] of [...this.files]) {
        if (p === op.src || p.startsWith(op.src + '/')) {
          this.files.delete(p);
          this.files.set(op.dst + p.slice(op.src.length), v);
        }
      }
    } else if (op.op === 'delete') {
      for (const p of [...this.files.keys()]) if (op.paths.some((d) => p === d || p.startsWith(d + '/'))) this.files.delete(p);
    }
  }
  async search() {
    return { files: [], total: 0, truncated: false };
  }
  async replace() {
    return { changed: [], skipped: [] };
  }
  async git<T>(_args?: Record<string, unknown>): Promise<T> {
    return { repos: [] } as T;
  }
  async terminals() {
    return [];
  }
  async closeTerminal() {}
  openTerminal() {
    return { send() {}, close() {} };
  }
  async loadMonaco() {
    return fakeMonaco as never;
  }
}

const live: IdeStore[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.dispose();
});

async function started(host = new FakeHost()): Promise<{ host: FakeHost; store: IdeStore }> {
  monacoModels.clear();
  const store = new IdeStore(host);
  live.push(store);
  await store.start();
  return { host, store };
}

function modelOf(store: IdeStore, path: string): FakeModel {
  return store.getModel(path) as unknown as FakeModel;
}

/** 대화 상자에 자동으로 답한다. */
function answer(store: IdeStore, button: string, value = '') {
  return store.subscribe(() => {
    const d = store.getState().dialog;
    if (d) queueMicrotask(() => d.resolve({ button, value, fields: {} }));
  });
}

test('파일을 열면 미리보기 탭이 되고, 다른 파일을 한 번 누르면 그 자리를 바꿔 쓴다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'a');
  host.files.set('b.ts', 'b');
  await store.openFile('a.ts', { preview: true });
  await store.openFile('b.ts', { preview: true });
  const g = store.activeGroup();
  assert.deepEqual(g.tabs.map((t) => t.path), ['b.ts']);
  assert.ok(g.tabs[0].preview);
  assert.equal(store.getState().docs['a.ts'], undefined, '밀려난 미리보기의 문서는 버린다');
  await store.openFile('a.ts', { preview: false });
  assert.deepEqual(store.activeGroup().tabs.map((t) => [t.path, t.preview]), [['b.ts', true], ['a.ts', false]]);
});

test('고치면 미리보기가 고정되고, 되돌려 저장 판과 같아지면 깨끗해진다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'one');
  await store.openFile('a.ts', { preview: true });
  const m = modelOf(store, 'a.ts');
  const saved = m.getAlternativeVersionId();
  m.edit('two');
  assert.equal(store.getState().docs['a.ts'].dirty, true);
  assert.equal(store.activeGroup().tabs[0].preview, false, '고친 탭은 미리보기가 아니다');
  m.undoTo(saved, 'one');
  assert.equal(store.getState().docs['a.ts'].dirty, false);
});

test('저장은 연 판의 sha 를 조건으로 건다 — 그사이 바뀌었으면 묻고, 덮어쓰기를 고르면 조건 없이 쓴다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'disk1');
  await store.openFile('a.ts');
  modelOf(store, 'a.ts').edit('mine');
  host.files.set('a.ts', 'agent'); // 에이전트가 먼저 고쳤다
  const off = answer(store, 'overwrite');
  const ok = await store.save('a.ts');
  off();
  assert.equal(host.files.get('a.ts'), 'mine');
  assert.equal(host.saves.at(-1)?.base, null, '덮어쓰기는 조건 없이');
  assert.equal(host.saves.length, 1, '조건부 저장은 거절됐다');
  assert.equal(ok, true);
  assert.equal(store.getState().docs['a.ts'].dirty, false);
  assert.equal(store.getState().docs['a.ts'].sha, shaOf('mine'));
});

test('충돌에서 "바뀐 판 불러오기" 를 고르면 디스크 판이 버퍼가 된다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'disk1');
  await store.openFile('a.ts');
  modelOf(store, 'a.ts').edit('mine');
  host.files.set('a.ts', 'agent');
  const off = answer(store, 'revert');
  await store.save('a.ts');
  off();
  assert.equal(modelOf(store, 'a.ts').getValue(), 'agent');
  assert.equal(store.getState().docs['a.ts'].dirty, false);
  assert.equal(host.files.get('a.ts'), 'agent');
});

test('바깥에서 바뀐 파일 — 깨끗하면 조용히 다시 읽고, 고친 중이면 표시만 한다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'v1');
  host.files.set('b.ts', 'v1');
  await store.openFile('a.ts', { preview: false });
  await store.openFile('b.ts', { preview: false });
  modelOf(store, 'b.ts').edit('mine');
  host.files.set('a.ts', 'v2');
  host.files.set('b.ts', 'v2');
  await store.checkDisk('all');
  assert.equal(modelOf(store, 'a.ts').getValue(), 'v2');
  assert.equal(store.getState().docs['a.ts'].dirty, false);
  assert.equal(modelOf(store, 'b.ts').getValue(), 'mine');
  assert.equal(store.getState().docs['b.ts'].diskChanged, true);
});

test('고친 탭을 닫으면 묻는다 — 취소면 남고, 저장 안 함이면 버린다', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'v1');
  await store.openFile('a.ts', { preview: false });
  modelOf(store, 'a.ts').edit('mine');
  const g = store.activeGroup();
  let off = answer(store, 'cancel');
  assert.equal(await store.closeTab(g.id, g.activeId!), false);
  off();
  assert.equal(store.activeGroup().tabs.length, 1);
  off = answer(store, 'discard');
  assert.equal(await store.closeTab(g.id, g.activeId!), true);
  off();
  assert.equal(store.activeGroup().tabs.length, 0);
  assert.equal(host.files.get('a.ts'), 'v1', '저장하지 않았다');
  assert.equal(store.getModel('a.ts'), null, '모델도 버렸다');
});

test('같은 파일을 다른 묶음에서도 열면 한쪽을 닫아도 묻지 않는다(다른 쪽이 보여 준다)', async () => {
  const { host, store } = await started();
  host.files.set('a.ts', 'v1');
  await store.openFile('a.ts', { preview: false });
  store.splitRight();
  assert.equal(store.getState().groups.length, 2);
  modelOf(store, 'a.ts').edit('mine');
  const right = store.activeGroup();
  const asked: string[] = [];
  const off = store.subscribe(() => {
    const d = store.getState().dialog;
    if (d) {
      asked.push(d.title);
      d.resolve({ button: 'cancel', value: '', fields: {} });
    }
  });
  assert.equal(await store.closeTab(right.id, right.activeId!), true);
  off();
  assert.deepEqual(asked, []);
  assert.equal(store.getState().groups.length, 1, '빈 묶음은 접는다');
  assert.equal(store.getState().docs['a.ts'].dirty, true, '버퍼는 남은 탭이 들고 있다');
});

test('옮기기 — 열린 탭이 새 경로를 따라가고 활성 탭도 그대로다', async () => {
  const { host, store } = await started();
  host.files.set('src/a.ts', 'a');
  host.files.set('src/b.ts', 'b');
  await store.refreshFiles();
  await store.openFile('src/a.ts', { preview: false });
  await store.openFile('src/b.ts', { preview: false });
  assert.equal(await store.moveEntry('src', 'lib'), true);
  const g = store.activeGroup();
  assert.deepEqual(g.tabs.map((t) => t.path), ['lib/a.ts', 'lib/b.ts']);
  assert.equal(g.tabs.find((t) => t.id === g.activeId)?.path, 'lib/b.ts');
  assert.deepEqual(host.fsOps.at(-1), { op: 'rename', src: 'src', dst: 'lib' });
});

test('새 파일은 "없어야 한다" 조건으로 만들고 곧바로 연다', async () => {
  const { host, store } = await started();
  assert.equal(await store.createEntry('docs', 'new.md', 'file'), true);
  assert.deepEqual(host.saves.at(-1), { path: 'docs/new.md', base: '', text: '' });
  assert.equal(store.activeTab()?.path, 'docs/new.md');
});

test('지우기 — 확인을 받고, 그 안의 열린 탭을 닫는다', async () => {
  const { host, store } = await started();
  host.files.set('x/a.ts', 'a');
  await store.refreshFiles();
  await store.openFile('x/a.ts', { preview: false });
  const off = answer(store, 'ok');
  assert.equal(await store.deleteEntries(['x']), true);
  off();
  assert.equal(store.activeGroup().tabs.length, 0);
  assert.equal(host.files.size, 0);
});

test('읽기 전용(고정된 에이전트)에서는 저장하지 않는다', async () => {
  const host = new FakeHost();
  host.readonly = true;
  host.files.set('a.ts', 'a');
  const { store } = await started(host);
  await store.openFile('a.ts');
  modelOf(store, 'a.ts').edit('b');
  assert.equal(await store.save('a.ts'), false);
  assert.equal(host.saves.length, 0);
});

test('줄 끝·BOM 을 지키며 저장한다', async () => {
  const { host, store } = await started();
  host.files.set('w.txt', 'a\r\nb\r\n');
  await store.openFile('w.txt');
  assert.equal(store.getState().docs['w.txt'].eol, 'CRLF');
  modelOf(store, 'w.txt').edit('a\nb\nc\n');
  await store.save('w.txt');
  assert.equal(host.files.get('w.txt'), 'a\r\nb\r\nc\r\n');
});

test('열어 둔 탭은 다시 열 때 되살린다(없어진 파일은 빼고)', async () => {
  const host = new FakeHost();
  host.files.set('a.ts', 'a');
  host.files.set('b.ts', 'b');
  const first = await started(host);
  await first.store.openFile('a.ts', { preview: false });
  await first.store.openFile('b.ts', { preview: false });
  host.files.delete('a.ts');
  const second = new IdeStore(host);
  live.push(second);
  await second.start();
  assert.deepEqual(second.activeGroup().tabs.map((t) => t.path), ['b.ts']);
});

// ── 저장하지 않은 변경 지키기(hot exit) ──────────────────────────────

/** 다시 연 저장소가 문서를 다 읽을 때까지 기다린다. */
async function settled(store: IdeStore, path: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (store.getState().docs[path]?.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`${path} 가 열리지 않았다`);
}

async function reopened(host: FakeHost): Promise<IdeStore> {
  monacoModels.clear();
  const store = new IdeStore(host);
  live.push(store);
  await store.start();
  return store;
}

test('저장하지 않고 닫은 변경은 다시 열면 저장 안 됨 상태로 돌아온다', async () => {
  const host = new FakeHost();
  host.files.set('a.txt', 'one');
  const { store } = await started(host);
  await store.openFile('a.txt', { preview: false });
  modelOf(store, 'a.txt').edit('one two');
  store.dispose(); // 닫히는 순간 보관한다

  const again = await reopened(host);
  await settled(again, 'a.txt');
  assert.equal(modelOf(again, 'a.txt').getValue(), 'one two');
  assert.equal(again.getState().docs['a.txt'].dirty, true);
  assert.equal(again.getState().docs['a.txt'].diskChanged, false);
  assert.deepEqual(again.unsavedPaths(), ['a.txt']);

  // 저장하면 보관본이 사라져, 다음에 열 때는 되살릴 것이 없다.
  assert.equal(await again.save('a.txt'), true);
  assert.equal(host.files.get('a.txt'), 'one two');
  again.dispose();
  const third = await reopened(host);
  await settled(third, 'a.txt');
  assert.equal(third.getState().docs['a.txt'].dirty, false);
});

test('탭을 닫지 않았어도 보관본만 있으면 그 파일을 연다', async () => {
  const host = new FakeHost();
  host.files.set('a.txt', 'one');
  host.files.set('b.txt', 'b');
  const { store } = await started(host);
  await store.openFile('a.txt', { preview: false });
  modelOf(store, 'a.txt').edit('changed');
  store.dispose();
  // 탭 기억만 지워진 경우(다른 기기에서 탭을 정리 등)
  host.storageMap.delete('xide:wf1:tabs');

  const again = await reopened(host);
  await settled(again, 'a.txt');
  assert.deepEqual(again.activeGroup().tabs.map((t) => t.path), ['a.txt']);
  assert.equal(modelOf(again, 'a.txt').getValue(), 'changed');
});

test('되살린 사이 디스크가 바뀌었으면 저장이 조용히 덮지 않고 충돌로 잡힌다', async () => {
  const host = new FakeHost();
  host.files.set('a.txt', 'one');
  const { store } = await started(host);
  await store.openFile('a.txt', { preview: false });
  modelOf(store, 'a.txt').edit('mine');
  store.dispose();
  host.files.set('a.txt', 'agent'); // 그사이 에이전트가 고쳤다

  const again = await reopened(host);
  await settled(again, 'a.txt');
  assert.equal(modelOf(again, 'a.txt').getValue(), 'mine');
  assert.equal(again.getState().docs['a.txt'].diskChanged, true);
  const stop = answer(again, 'cancel');
  assert.equal(await again.save('a.txt'), false);
  stop();
  assert.equal(host.files.get('a.txt'), 'agent', '에이전트의 판이 그대로다');
  assert.equal(host.saves.length, 0);
});

test('[저장 안 함] 으로 닫거나 되돌려 깨끗해지면 보관본을 버린다', async () => {
  const host = new FakeHost();
  host.files.set('a.txt', 'one');
  host.files.set('b.txt', 'b');
  const { store } = await started(host);
  await store.openFile('a.txt', { preview: false });
  const model = modelOf(store, 'a.txt');
  const clean = model.getAlternativeVersionId();
  model.edit('x');
  await new Promise((r) => setTimeout(r, 900)); // 보관 타이머
  assert.ok(host.storageMap.get('xide:wf1:backup:a.txt'), '고치는 동안 보관한다');
  model.undoTo(clean, 'one'); // 되돌리기로 저장 판에 돌아왔다
  assert.equal(host.storageMap.get('xide:wf1:backup:a.txt'), '');

  await store.openFile('b.txt', { preview: false });
  modelOf(store, 'b.txt').edit('bb');
  const stop = answer(store, 'discard');
  const g = store.activeGroup();
  await store.closeTab(g.id, g.activeId!);
  stop();
  store.dispose();
  const again = await reopened(host);
  assert.deepEqual(again.unsavedPaths(), []);
  assert.ok(!again.activeGroup().tabs.some((t) => t.path === 'b.txt'));
});

// ── 여백의 변경 표시(quick diff) ─────────────────────────────────────

class RepoHost extends FakeHost {
  /** git 의 스테이지(index) 판. */
  index = new Map<string, string>();
  async git<T>(args: Record<string, unknown>): Promise<T> {
    if (args.op === 'repos') return { repos: [{ path: '' }] } as T;
    if (args.op === 'status') {
      return { repo: '', branch: { head: 'main', oid: '', upstream: '', ahead: 0, behind: 0 }, state: '', staged: [], changes: [], untracked: [], conflicts: [], stash_count: 0, remotes: [], identity: { name: '', email: '' }, last_commit: null } as T;
    }
    if (args.op === 'show') {
      const v = this.index.get(String(args.path));
      return (v == null ? { exists: false } : { exists: true, content_b64: Buffer.from(v).toString('base64') }) as T;
    }
    if (args.op === 'stage') {
      for (const p of args.paths as string[]) this.index.set(p, this.files.get(p) ?? '');
      return {} as T;
    }
    return {} as T;
  }
}

async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('기다린 일이 일어나지 않았다');
}

test('여백 변경 표시 — 스테이지 판과 다른 줄을 그리고, 스테이지하면 사라진다', async () => {
  const host = new RepoHost();
  host.files.set('src/a.ts', 'one\ntwo\nthree');
  host.index.set('src/a.ts', 'one\ntwo\nthree');
  const { store } = await started(host);
  await store.refreshGit();
  await store.openFile('src/a.ts', { preview: false });
  const model = modelOf(store, 'src/a.ts');
  await until(() => store['qdBase'].has('src/a.ts'));
  assert.deepEqual(store.quickDiffOf('src/a.ts'), []);

  model.edit('one\nTWO\nthree\nfour');
  await until(() => model.decorations.length === 2);
  assert.deepEqual(
    model.decorations.map((d) => [d.options.linesDecorationsClassName, d.range.startLineNumber, d.range.endLineNumber]),
    [
      ['xide-qd xide-qd-modified', 2, 2],
      ['xide-qd xide-qd-added', 4, 4],
    ],
  );

  // 저장하고 스테이지하면 기준(index)이 따라와 표시가 사라진다.
  assert.equal(await store.save('src/a.ts'), true);
  await store.gitRun({ op: 'stage', repo: '', paths: ['src/a.ts'] }, '스테이지');
  await until(() => model.decorations.length === 0);
});

test('여백 변경 표시 — 저장소 밖이나 추적하지 않는 파일에는 그리지 않는다', async () => {
  const host = new RepoHost();
  host.files.set('new.ts', 'x');
  const { store } = await started(host);
  await store.refreshGit();
  await store.openFile('new.ts', { preview: false });
  await until(() => store['qdBase'].has('new.ts'));
  modelOf(store, 'new.ts').edit('x\ny');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(modelOf(store, 'new.ts').decorations, []);
});

// ── 연결 — 배포·재시작 사이에도 스스로 돌아온다 ─────────────────────────

class FlakyHost extends FakeHost {
  /** 앞으로 실패할 session() 횟수와 그 이유. */
  sessionFails = 0;
  sessionCode = 'unavailable';
  listFails = 0;
  sessions = 0;
  async session() {
    this.sessions += 1;
    if (this.sessionFails > 0) {
      this.sessionFails -= 1;
      throw new IdeError(this.sessionCode, '실패', this.sessionCode === 'unavailable' ? 502 : 403);
    }
    return super.session();
  }
  async listFiles() {
    if (this.listFails > 0) {
      this.listFails -= 1;
      throw new IdeError('unavailable', '실패', 502);
    }
    return super.listFiles();
  }
}

test('연결 — 닿지 않으면 다시 붙어 온라인이 되고, 그 뒤에 탭을 되살린다', async () => {
  IdeStore.retryBaseMs = 5;
  const host = new FlakyHost();
  host.files.set('a.ts', 'a');
  host.sessionFails = 2;
  host.listFails = 1;
  const { store } = await started(host);
  assert.equal(store.getState().connection, 'online');
  assert.equal(host.sessions, 3);
  assert.equal(store.getState().sessionError, null);
  await until(() => store.getState().files.length === 1);
  assert.equal(store.getState().filesError, null, '파일 목록도 스스로 다시 읽었다');
});

test('연결 — 권한이 없으면 되풀이하지 않고 이유를 보인다', async () => {
  IdeStore.retryBaseMs = 5;
  const host = new FlakyHost();
  host.sessionFails = 5;
  host.sessionCode = 'forbidden';
  const { store } = await started(host);
  assert.equal(store.getState().connection, 'blocked');
  assert.equal(host.sessions, 1);
  assert.match(store.getState().sessionError ?? '', /권한/);
});

test('연결 — 쓰는 도중 서버에 닿지 않으면 다시 연결하는 중이 되었다가 돌아온다', async () => {
  IdeStore.retryBaseMs = 5;
  const host = new FlakyHost();
  host.files.set('a.ts', 'a');
  const { store } = await started(host);
  assert.equal(store.getState().connection, 'online');
  // 배포 중 파드 교체 — 읽기가 한 번 502 로 떨어지고, 세션도 한 번 더 실패한다.
  const read = host.readFile.bind(host);
  let once = true;
  host.readFile = async (p: string) => {
    if (once) {
      once = false;
      throw new IdeError('unavailable', '실패', 502);
    }
    return read(p);
  };
  host.sessionFails = 1;
  await store.openFile('a.ts', { preview: false });
  assert.equal(store.getState().docs['a.ts'].status, 'error');
  await until(() => store.getState().connection === 'online' && host.sessions >= 3);
  // 다시 붙으면 열지 못했던 파일을 다시 연다.
  await until(() => store.getState().docs['a.ts']?.status === 'ready');
});

test('연결 — [다시 연결] 은 기다리지 않고 바로 시도한다', async () => {
  IdeStore.retryBaseMs = 60_000; // 스스로는 한참 뒤에야 다시 한다
  const host = new FlakyHost();
  host.sessionFails = 1;
  const store = new IdeStore(host);
  live.push(store);
  const starting = store.start();
  await until(() => store.getState().connection === 'retrying');
  store.reconnect();
  await starting;
  assert.equal(store.getState().connection, 'online');
  IdeStore.retryBaseMs = 5;
});

// ── 연결된 폴더 (2026-09-29 사용자 지시) ─────────────────────────────
//
// 폴더를 연결하면 IDE 탐색기에서도 그 폴더가 보여야 한다 — 스토리지와 구분선으로 나뉜 칸에.
// 이 기기의 폴더는 펼쳐 보고 편집기로 연다. 다른 기기에 있으면 이름만 보인다.

import { folderPath, folderRows, parseFolderPath } from '../src/folders';
import type { IdeFolderSource, IdeFoldersState } from '../src/types';

class FakeFolders implements IdeFolderSource {
  files = new Map<string, string>([
    ['src/main.py', 'print(1)'],
    ['README.md', '# hi'],
  ]);
  dirs = new Set<string>(['src']);
  state_: IdeFoldersState = { roots: [{ id: 'r1', name: 'project', detail: 'C:\\work\\project' }] };
  listeners: ((rootId?: string) => void)[] = [];
  saves: { path: string; base: string | null; text: string }[] = [];
  ops: IdeFsOp[] = [];
  async state() {
    return this.state_;
  }
  subscribe(fn: (rootId?: string) => void) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }
  async list(_root: string, dir: string) {
    const prefix = dir ? `${dir}/` : '';
    const names = new Map<string, boolean>();
    for (const d of this.dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) names.set(d, true);
    for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) names.set(f, false);
    return [...names].map(([path, isDir]) => ({ path, isDir }));
  }
  async read(_root: string, path: string) {
    const v = this.files.get(path);
    if (v == null) throw new IdeError('not_found', '없음', 404);
    return { bytes: enc(v), sha: shaOf(v), size: v.length };
  }
  async save(_root: string, path: string, bytes: Uint8Array, base: string | null) {
    const text = new TextDecoder().decode(bytes);
    const cur = this.files.get(path);
    if (base !== null && base !== (cur == null ? '' : shaOf(cur))) throw new IdeError('changed', '바뀜', 409);
    this.saves.push({ path, base, text });
    this.files.set(path, text);
    return { sha: shaOf(text) };
  }
  async stat(_root: string, paths: string[]) {
    const out: Record<string, IdeStat> = {};
    for (const p of paths) {
      const v = this.files.get(p);
      out[p] = v == null ? { kind: 'missing' } : { kind: 'file', sha: shaOf(v) };
    }
    return out;
  }
  async readRaw() {
    return new Uint8Array([1, 2]);
  }
  async fs(_root: string, op: IdeFsOp) {
    this.ops.push(op);
    if (op.op === 'mkdir') this.dirs.add(op.path);
    if (op.op === 'rename') {
      for (const [p, v] of [...this.files]) {
        if (p === op.src || p.startsWith(op.src + '/')) {
          this.files.delete(p);
          this.files.set(op.dst + p.slice(op.src.length), v);
        }
      }
    }
    if (op.op === 'delete') for (const p of [...this.files.keys()]) if (op.paths.some((d) => p === d || p.startsWith(d + '/'))) this.files.delete(p);
  }
  pathOf(_root: string, path: string) {
    return `C:\\work\\project\\${path.replace(/\//g, '\\')}`;
  }
}

async function withFolders(): Promise<{ host: FakeHost; store: IdeStore; folders: FakeFolders }> {
  const host = new FakeHost();
  const folders = new FakeFolders();
  (host as FakeHost & { folders: IdeFolderSource }).folders = folders;
  const out = await started(host);
  await new Promise((r) => setTimeout(r, 0));
  return { ...out, folders };
}

test('연결된 폴더의 주소는 스토리지 경로와 겹치지 않는다', () => {
  const p = folderPath('r1', 'src/main.py');
  assert.deepEqual(parseFolderPath(p), { rootId: 'r1', rel: 'src/main.py' });
  assert.equal(parseFolderPath('src/main.py'), null, '스토리지 경로는 연결된 폴더가 아니다');
  assert.deepEqual(parseFolderPath(folderPath('r1')), { rootId: 'r1', rel: '' });
});

test('연결된 폴더는 탐색기 아래 따로 보이고, 펼치면 한 단계씩 읽는다', async () => {
  const { store } = await withFolders();
  const f = store.getState().folders;
  assert.equal(f.available, true);
  assert.deepEqual(f.roots.map((r) => r.name), ['project']);
  store.toggleFolderDir(folderPath('r1'));
  await new Promise((r) => setTimeout(r, 0));
  const rows = folderRows(store.getState().folders).map((r) => (r.kind === 'note' ? `#${r.text}` : `${r.depth}:${r.kind === 'root' ? r.root.name : r.entry.path.split('/').pop()}`));
  assert.deepEqual(rows, ['0:project', '1:src', '1:README.md'], '폴더 먼저, 이름 순');
});

test('연결된 폴더의 파일을 열고 고쳐 저장한다 — 연 판을 조건으로 건다', async () => {
  const { store, folders } = await withFolders();
  const path = folderPath('r1', 'src/main.py');
  await store.openFile(path, { preview: false });
  assert.equal(store.getState().docs[path].status, 'ready');
  assert.equal(store.displayPath(path), 'project/src/main.py', '내부 주소를 보이지 않는다');
  assert.equal(store.copyablePath(path), 'C:\\work\\project\\src\\main.py');
  modelOf(store, path).edit('print(2)');
  assert.equal(await store.save(path), true);
  assert.deepEqual(folders.saves.at(-1), { path: 'src/main.py', base: shaOf('print(1)'), text: 'print(2)' });
});

test('에이전트가 연결된 폴더의 파일을 바꾸면 깨끗한 버퍼는 다시 읽는다', async () => {
  const { store, folders } = await withFolders();
  const path = folderPath('r1', 'README.md');
  await store.openFile(path, { preview: false });
  folders.files.set('README.md', '# changed');
  for (const fn of folders.listeners) fn('r1');
  await new Promise((r) => setTimeout(r, 400));
  await store.checkDisk('all');
  assert.equal(modelOf(store, path).getValue(), '# changed');
});

test('연결된 폴더 안에서 만들고 이름 바꾸고 지운다 — 열린 탭도 따라간다', async () => {
  const { store, folders } = await withFolders();
  const root = folderPath('r1');
  assert.equal(await store.createFolderEntry(root, 'notes.txt', 'file'), true);
  assert.ok(folders.files.has('notes.txt'));
  const old = folderPath('r1', 'notes.txt');
  assert.ok(store.activeGroup().tabs.some((t) => t.path === old), '새 파일은 곧바로 열린다');
  assert.equal(await store.renameFolderEntry(old, 'todo.txt'), true);
  assert.ok(folders.files.has('todo.txt'));
  assert.ok(store.activeGroup().tabs.some((t) => t.path === folderPath('r1', 'todo.txt')));
  const off = answer(store, 'ok');
  assert.equal(await store.deleteFolderEntries([folderPath('r1', 'todo.txt')], () => false), true);
  off();
  assert.ok(!folders.files.has('todo.txt'));
  assert.ok(!store.activeGroup().tabs.some((t) => t.path === folderPath('r1', 'todo.txt')), '지운 파일의 탭은 닫는다');
});

test('다른 기기에 있는 폴더는 이름만 보인다', async () => {
  const { store, folders } = await withFolders();
  folders.state_ = { roots: [], elsewhere: { deviceName: 'OFFICE-PC', online: true, folders: ['alpha'] } };
  await store.refreshFolders();
  const f = store.getState().folders;
  assert.deepEqual(f.roots, []);
  assert.deepEqual(f.elsewhere, { deviceName: 'OFFICE-PC', online: true, folders: ['alpha'] });
  assert.deepEqual(folderRows(f), []);
});

test('연결을 해제한 폴더의 펼침·목록은 잊는다', async () => {
  const { store, folders } = await withFolders();
  store.toggleFolderDir(folderPath('r1'));
  await new Promise((r) => setTimeout(r, 0));
  folders.state_ = { roots: [] };
  for (const fn of folders.listeners) fn();
  await new Promise((r) => setTimeout(r, 400));
  const f = store.getState().folders;
  assert.equal(f.expanded.size, 0);
  assert.deepEqual(Object.keys(f.dirs), []);
});
