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
  dispose() {
    this.disposed = true;
    monacoModels.delete(this.uri.toString());
  }
  private fire() {
    for (const f of this.listeners) f();
  }
}

class FakeUri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  toString() {
    return `${this.scheme}://${this.path}?${this.query}`;
  }
}

const monacoModels = new Map<string, FakeModel>();
const fakeMonaco = {
  Uri: { from: (c: { scheme: string; path: string; query?: string }) => new FakeUri(c.scheme, c.path, c.query) },
  editor: {
    EndOfLineSequence: { LF: 0, CRLF: 1 },
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
  async git<T>(): Promise<T> {
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
