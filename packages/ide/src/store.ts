/**
 * IDE 한 개(에이전트 하나)의 상태 — 화면과 떨어져 산다.
 *
 * 채팅 탭은 전환할 때마다 다시 그려진다(데스크톱은 탭마다 `key` 가 바뀐다). 편집기의 버퍼·
 * 되돌리기 기록·터미널 연결이 화면과 함께 사라지면 안 되므로, 상태는 여기 두고 화면은
 * 구독만 한다. 호스트는 에이전트마다 이 저장소 하나를 만들어 탭이 닫힐 때까지 들고 있는다.
 *
 * 문서(편집기 버퍼)는 경로마다 하나다. 같은 파일을 두 편집기 묶음에서 열어도, 비교 화면의
 * 오른쪽으로 열어도 같은 Monaco 모델을 쓴다 — 한쪽에서 고치면 다른 쪽에도 보인다.
 */
import type * as Monaco from 'monaco-editor';
import {
  IdeError,
  type IdeFileEntry,
  type IdeFsOp,
  type IdeHost,
  type IdeSearchQuery,
  type IdeSearchResult,
  type IdeTerminalInfo,
  type MonacoApi,
} from './types';
import { basename, dirname, isWithin, join, normalize, uniqueCopyName } from './paths';
import { buildTree, ancestors, type TreeNode } from './tree';
import { decodeText, encodeText, isImagePath, looksBinary, type Eol } from './text';
import {
  gitErrorMessage,
  toWorkspacePath,
  type GitAccount,
  type GitFileStatus,
  type GitStatus,
} from './git-model';

// ── 모양 ──────────────────────────────────────────────────────────────

export type SideViewId = 'explorer' | 'search' | 'scm' | (string & {});

export interface Layout {
  sideView: SideViewId | null;
  sideWidth: number;
  panelOpen: boolean;
  panelHeight: number;
  panelMaximized: boolean;
  chatOpen: boolean;
  chatWidth: number;
  minimap: boolean;
  wordWrap: boolean;
  autoSave: boolean;
  fontSize: number;
}

export const DEFAULT_LAYOUT: Layout = {
  sideView: 'explorer',
  sideWidth: 260,
  panelOpen: false,
  panelHeight: 240,
  panelMaximized: false,
  chatOpen: true,
  chatWidth: 400,
  minimap: true,
  wordWrap: false,
  autoSave: false,
  fontSize: 13,
};

export type TabKind = 'file' | 'diff' | 'image';

export interface DiffSpec {
  repo: string;
  /** 저장소 기준 경로. */
  path: string;
  /** true = 스테이지한 변경(HEAD ↔ 스테이지), false = 작업 트리(스테이지 ↔ 파일). */
  staged: boolean;
  status?: GitFileStatus;
  /** 저장 충돌의 비교 — 왼쪽이 git 이 아니라 **디스크의 지금 판**이다. */
  disk?: boolean;
}

export interface EditorTab {
  id: string;
  kind: TabKind;
  /** workspace 기준 경로. */
  path: string;
  /** 미리보기 탭(기울임) — 다른 파일을 한 번 누르면 이 자리를 바꿔 쓴다. */
  preview: boolean;
  diff?: DiffSpec;
}

export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activeId: string | null;
}

export type DocStatus = 'loading' | 'ready' | 'binary' | 'too_large' | 'missing' | 'error';

export interface DocState {
  path: string;
  status: DocStatus;
  message?: string;
  /** 버퍼가 기대고 있는 디스크 판의 sha. `''` = 아직 없는 파일. */
  sha: string;
  size: number;
  dirty: boolean;
  eol: Eol;
  bom: boolean;
  saving: boolean;
  /** 고치는 사이 디스크 판이 바뀌었다(저장하면 충돌). */
  diskChanged: boolean;
}

/** `idle` = 서버에 있으나 아직 이 화면에 붙이지 않았다(보이면 붙는다). */
export type TerminalStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'exited' | 'error';

export interface TerminalState {
  id: string;
  title: string;
  status: TerminalStatus;
  exitCode?: number;
  message?: string;
  cwd?: string;
}

export interface SearchState {
  query: string;
  replace: string;
  showReplace: boolean;
  showDetails: boolean;
  regex: boolean;
  caseSensitive: boolean;
  word: boolean;
  include: string;
  exclude: string;
  running: boolean;
  result: IdeSearchResult | null;
  error: string | null;
  collapsed: Set<string>;
}

export interface GitState {
  repos: string[];
  statuses: Record<string, GitStatus>;
  loading: boolean;
  loaded: boolean;
  error: { code: string; message: string } | null;
  account: GitAccount | null;
  busy: string | null;
  message: Record<string, string>;
}

export interface Notice {
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
  at: number;
}

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogRequest {
  id: number;
  title: string;
  message?: string;
  detail?: string;
  buttons: DialogButton[];
  /** 입력 한 칸을 받는 대화 상자. */
  input?: { value: string; placeholder?: string; label?: string; password?: boolean; select?: [number, number] };
  /** 입력 여러 칸(자격 등록). */
  fields?: { id: string; label: string; value: string; placeholder?: string; password?: boolean }[];
  validate?: (value: string) => string | null;
  resolve: (result: { button: string; value: string; fields: Record<string, string> }) => void;
}

export interface IdeState {
  ready: boolean;
  readonly: boolean;
  sessionError: string | null;
  files: IdeFileEntry[];
  tree: TreeNode;
  filesLoaded: boolean;
  filesError: string | null;
  expanded: ReadonlySet<string>;
  selected: string | null;
  /** 탐색기 안에서 새 파일·폴더 이름을 받는 줄. */
  creating: { parent: string; kind: 'file' | 'dir' } | null;
  renaming: string | null;
  clipboard: { mode: 'copy' | 'cut'; paths: string[] } | null;
  groups: EditorGroup[];
  activeGroup: string;
  docs: Record<string, DocState>;
  terminals: TerminalState[];
  activeTerminal: string | null;
  layout: Layout;
  git: GitState;
  search: SearchState;
  cursor: { line: number; col: number; selected: number } | null;
  notice: Notice | null;
  dialog: DialogRequest | null;
  quickOpen: { mode: QuickOpenMode; initial: string } | null;
  monacoReady: boolean;
  monacoError: string | null;
}

type Listener = () => void;

const EMPTY_TREE: TreeNode = { path: '', name: '', isDir: true, children: [] };

export function tabIdFor(kind: TabKind, path: string, diff?: DiffSpec): string {
  if (kind === 'diff' && diff?.disk) return `disk:${path}`;
  if (kind === 'diff' && diff) return `diff:${diff.staged ? 'staged' : 'work'}:${diff.repo}:${diff.path}`;
  return `${kind}:${path}`;
}

export type QuickOpenMode = 'files' | 'commands' | 'line' | 'branches';

export function diskUri(monaco: MonacoApi, workflowId: string, path: string): Monaco.Uri {
  return monaco.Uri.from({ scheme: 'xide-disk', path: `/xgen/${workflowId}/${path}` });
}

let groupSeq = 0;
function newGroupId(): string {
  groupSeq += 1;
  return `g${Date.now().toString(36)}${groupSeq}`;
}

let dialogSeq = 0;

/** 다른 탭·다른 에이전트의 모델과 섞이지 않게 에이전트 id 를 주소에 넣는다. */
export function modelUri(monaco: MonacoApi, workflowId: string, path: string): Monaco.Uri {
  return monaco.Uri.from({ scheme: 'file', path: `/xgen/${workflowId}/${path}` });
}

export function originalUri(monaco: MonacoApi, workflowId: string, diff: DiffSpec): Monaco.Uri {
  return monaco.Uri.from({
    scheme: 'xide-git',
    path: `/xgen/${workflowId}/${diff.repo ? diff.repo + '/' : ''}${diff.path}`,
    query: diff.staged ? 'HEAD' : 'index',
  });
}

export function stagedUri(monaco: MonacoApi, workflowId: string, diff: DiffSpec): Monaco.Uri {
  return monaco.Uri.from({
    scheme: 'xide-git',
    path: `/xgen/${workflowId}/${diff.repo ? diff.repo + '/' : ''}${diff.path}`,
    query: 'staged',
  });
}

/** 터미널 하나의 화면·연결 — 상태 저장소 밖(React 상태가 아닌 것). */
export interface TerminalRuntime {
  id: string;
  dispose(): void;
}

export class IdeStore {
  private state: IdeState;
  private readonly listeners = new Set<Listener>();
  private monaco: MonacoApi | null = null;
  private monacoLoading: Promise<MonacoApi> | null = null;
  private readonly loads = new Map<string, Promise<void>>();
  /** 문서마다 "저장된 판" 의 버전 — 되돌리기로 저장 판에 돌아오면 깨끗해진다. */
  private readonly savedVersion = new Map<string, number>();
  private readonly modelSubs = new Map<string, Monaco.IDisposable>();
  private readonly autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closedTabs: EditorTab[] = [];
  private unsubscribeChanges: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private gitTimer: ReturnType<typeof setTimeout> | null = null;
  private filesTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  private disposed = false;
  /** 터미널 런타임(xterm·소켓)은 화면이 바뀌어도 산다 — terminal.ts 가 채운다. */
  readonly terminalRuntimes = new Map<string, TerminalRuntime>();
  /** 편집기 묶음마다 탭별 화면 상태(스크롤·커서). */
  readonly viewStates = new Map<string, unknown>();
  /** 명령 표(명령 팔레트·단축키) — IdeView 가 채운다. */
  commands: IdeCommand[] = [];
  /** 편집기 묶음 id → 그 묶음의 Monaco 편집기(찾기·줄 이동 같은 편집기 명령용). */
  readonly editors = new Map<string, Monaco.editor.IStandaloneCodeEditor>();

  constructor(readonly host: IdeHost) {
    const firstGroup = newGroupId();
    this.state = {
      ready: false,
      readonly: false,
      sessionError: null,
      files: [],
      tree: EMPTY_TREE,
      filesLoaded: false,
      filesError: null,
      expanded: new Set<string>(),
      selected: null,
      creating: null,
      renaming: null,
      clipboard: null,
      groups: [{ id: firstGroup, tabs: [], activeId: null }],
      activeGroup: firstGroup,
      docs: {},
      terminals: [],
      activeTerminal: null,
      layout: { ...DEFAULT_LAYOUT, ...this.readJson<Partial<Layout>>('layout', {}) },
      git: {
        repos: [],
        statuses: {},
        loading: false,
        loaded: false,
        error: null,
        account: null,
        busy: null,
        message: {},
      },
      search: {
        query: '',
        replace: '',
        showReplace: false,
        showDetails: false,
        regex: false,
        caseSensitive: false,
        word: false,
        include: '',
        exclude: '',
        running: false,
        result: null,
        error: null,
        collapsed: new Set<string>(),
      },
      cursor: null,
      notice: null,
      dialog: null,
      quickOpen: null,
      monacoReady: false,
      monacoError: null,
    };
    const expanded = this.readJson<string[]>('expanded', []);
    if (Array.isArray(expanded)) this.state.expanded = new Set(expanded);
  }

  // ── 구독 ──────────────────────────────────────────────────────────

  getState = (): IdeState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<IdeState> | ((s: IdeState) => Partial<IdeState>)): void {
    if (this.disposed) return;
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const fn of [...this.listeners]) fn();
  }

  private patchDoc(path: string, patch: Partial<DocState>): void {
    this.set((s) => {
      const cur = s.docs[path];
      if (!cur) return {};
      return { docs: { ...s.docs, [path]: { ...cur, ...patch } } };
    });
  }

  // ── 기억 ──────────────────────────────────────────────────────────

  private key(name: string): string {
    return `xide:${this.host.workflowId}:${name}`;
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      const raw = this.host.storage?.get(this.key(name));
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown): void {
    try {
      this.host.storage?.set(this.key(name), JSON.stringify(value));
    } catch {
      /* 기억 실패는 기능을 막지 않는다 */
    }
  }

  private persistTabs(): void {
    const s = this.state;
    this.writeJson('tabs', {
      groups: s.groups.map((g) => ({
        tabs: g.tabs.filter((t) => !t.preview || t.id === g.activeId).map((t) => ({ kind: t.kind, path: t.path, diff: t.diff })),
        active: g.tabs.find((t) => t.id === g.activeId)?.path ?? null,
      })),
      activeIndex: s.groups.findIndex((g) => g.id === s.activeGroup),
    });
  }

  // ── 시작·끝 ───────────────────────────────────────────────────────

  private started = false;

  /** 화면이 여러 번 붙어도 시작은 한 번이다. */
  startOnce(): void {
    if (this.started) return;
    this.started = true;
    void this.start();
  }

  async start(): Promise<void> {
    try {
      const info = await this.host.session();
      this.set({
        ready: true,
        readonly: info.readonly,
        sessionError: null,
        terminals: this.state.terminals.length
          ? this.state.terminals
          : info.terminals.map((t, i) => ({
              id: t.id,
              title: terminalTitle(t, i + 1),
              status: 'idle' as TerminalStatus,
              cwd: t.cwd,
            })),
      });
      if (!this.state.activeTerminal && this.state.terminals.length) {
        this.set({ activeTerminal: this.state.terminals[0].id });
      }
    } catch (err) {
      this.set({ sessionError: errorMessage(err, '샌드박스에 연결하지 못했습니다') });
    }
    await this.refreshFiles();
    this.restoreTabs();
    void this.refreshGit();
    if (this.host.subscribeChanges) {
      this.unsubscribeChanges = this.host.subscribeChanges(() => this.notifyRemoteChange());
    }
    // 열어 둔 파일이 바깥(에이전트·터미널)에서 바뀌었는지 — 보이는 탭은 자주, 나머지는 드물게.
    let tick = 0;
    this.pollTimer = setInterval(() => {
      tick += 1;
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.checkDisk(tick % 5 === 0 ? 'all' : 'visible');
      if (!this.host.subscribeChanges && tick % 10 === 0) void this.refreshFiles();
    }, 3000);
    // 노드(테스트)에서 이 타이머 하나가 프로세스를 붙잡지 않게 — 브라우저에는 없는 메서드다.
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeChanges?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.gitTimer) clearTimeout(this.gitTimer);
    if (this.filesTimer) clearTimeout(this.filesTimer);
    for (const t of this.autoSaveTimers.values()) clearTimeout(t);
    for (const rt of this.terminalRuntimes.values()) rt.dispose();
    this.terminalRuntimes.clear();
    for (const sub of this.modelSubs.values()) sub.dispose();
    this.modelSubs.clear();
    if (this.monaco) {
      for (const path of Object.keys(this.state.docs)) {
        this.monaco.editor.getModel(modelUri(this.monaco, this.host.workflowId, path))?.dispose();
      }
    }
    this.listeners.clear();
  }

  /** 바깥(에이전트의 턴·다른 기기)에서 바뀌었다 — 목록·열린 파일·소스 제어를 다시 본다. */
  notifyRemoteChange(): void {
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => {
      void this.refreshFiles();
      void this.checkDisk('all');
      this.scheduleGit();
    }, 400);
  }

  // ── 알림·대화 상자 ────────────────────────────────────────────────

  notify(kind: Notice['kind'], message: string): void {
    this.set({ notice: { kind, message, at: Date.now() } });
    this.host.notify?.(kind, message);
  }

  clearNotice(): void {
    this.set({ notice: null });
  }

  ask(req: Omit<DialogRequest, 'id' | 'resolve'>): Promise<{ button: string; value: string; fields: Record<string, string> }> {
    return new Promise((resolve) => {
      dialogSeq += 1;
      this.set({
        dialog: {
          ...req,
          id: dialogSeq,
          resolve: (r) => {
            this.set({ dialog: null });
            resolve(r);
          },
        },
      });
    });
  }

  async confirm(title: string, message: string, ok: string, danger = false): Promise<boolean> {
    const r = await this.ask({
      title,
      message,
      buttons: [
        { id: 'ok', label: ok, primary: !danger, danger },
        { id: 'cancel', label: '취소' },
      ],
    });
    return r.button === 'ok';
  }

  async prompt(
    title: string,
    options: { value?: string; placeholder?: string; ok?: string; validate?: (v: string) => string | null; select?: [number, number] } = {},
  ): Promise<string | null> {
    const r = await this.ask({
      title,
      buttons: [
        { id: 'ok', label: options.ok ?? '확인', primary: true },
        { id: 'cancel', label: '취소' },
      ],
      input: { value: options.value ?? '', placeholder: options.placeholder, select: options.select },
      validate: options.validate,
    });
    return r.button === 'ok' ? r.value : null;
  }

  // ── 화면 배치 ─────────────────────────────────────────────────────

  setLayout(patch: Partial<Layout>): void {
    this.set((s) => ({ layout: { ...s.layout, ...patch } }));
    this.writeJson('layout', this.state.layout);
  }

  toggleSideView(view: SideViewId): void {
    const cur = this.state.layout.sideView;
    this.setLayout({ sideView: cur === view ? null : view });
  }

  showSideView(view: SideViewId): void {
    this.setLayout({ sideView: view });
  }

  openQuickOpen(mode: QuickOpenMode, initial = ''): void {
    this.set({ quickOpen: { mode, initial } });
  }

  closeQuickOpen(): void {
    this.set({ quickOpen: null });
  }

  setCursor(cursor: IdeState['cursor']): void {
    const cur = this.state.cursor;
    if (cur && cursor && cur.line === cursor.line && cur.col === cursor.col && cur.selected === cursor.selected) return;
    this.set({ cursor });
  }

  // ── 파일 목록 ─────────────────────────────────────────────────────

  async refreshFiles(): Promise<void> {
    try {
      const files = await this.host.listFiles();
      this.set({ files, tree: buildTree(files), filesLoaded: true, filesError: null });
    } catch (err) {
      this.set({ filesLoaded: true, filesError: errorMessage(err, '파일 목록을 불러오지 못했습니다') });
    }
  }

  isDir(path: string): boolean {
    if (!path) return true;
    const p = normalize(path);
    return this.state.files.some((f) => (f.isDir && f.path === p) || f.path.startsWith(p + '/'));
  }

  exists(path: string): boolean {
    const p = normalize(path);
    return this.state.files.some((f) => f.path === p || f.path.startsWith(p + '/'));
  }

  setExpanded(path: string, open: boolean): void {
    this.set((s) => {
      const next = new Set(s.expanded);
      if (open) next.add(path);
      else next.delete(path);
      return { expanded: next };
    });
    this.writeJson('expanded', [...this.state.expanded]);
  }

  collapseAll(): void {
    this.set({ expanded: new Set() });
    this.writeJson('expanded', []);
  }

  reveal(path: string): void {
    const want = ancestors(path);
    if (want.every((d) => this.state.expanded.has(d)) && this.state.selected === path) return;
    this.set((s) => ({ expanded: new Set([...s.expanded, ...want]), selected: path }));
    this.writeJson('expanded', [...this.state.expanded]);
  }

  select(path: string | null): void {
    this.set({ selected: path });
  }

  startCreate(parent: string, kind: 'file' | 'dir'): void {
    if (this.state.readonly) return;
    if (parent) this.setExpanded(parent, true);
    this.set({ creating: { parent, kind }, renaming: null });
    this.showSideView('explorer');
  }

  cancelCreate(): void {
    this.set({ creating: null });
  }

  startRename(path: string): void {
    if (this.state.readonly) return;
    this.set({ renaming: path, creating: null });
  }

  cancelRename(): void {
    this.set({ renaming: null });
  }

  // ── Monaco ────────────────────────────────────────────────────────

  loadMonaco(): Promise<MonacoApi> {
    if (this.monaco) return Promise.resolve(this.monaco);
    if (!this.monacoLoading) {
      this.monacoLoading = this.host.loadMonaco().then(
        (m) => {
          this.monaco = m;
          ignoreMonacoCancellation();
          this.set({ monacoReady: true, monacoError: null });
          return m;
        },
        (err) => {
          this.monacoLoading = null;
          this.set({ monacoError: errorMessage(err, '편집기를 불러오지 못했습니다') });
          throw err;
        },
      );
    }
    return this.monacoLoading;
  }

  getMonaco(): MonacoApi | null {
    return this.monaco;
  }

  getModel(path: string): Monaco.editor.ITextModel | null {
    if (!this.monaco) return null;
    return this.monaco.editor.getModel(modelUri(this.monaco, this.host.workflowId, path));
  }

  // ── 문서 ──────────────────────────────────────────────────────────

  /** 문서를 준비한다(이미 있으면 그대로). 텍스트면 Monaco 모델까지 만든다. */
  ensureDoc(path: string, opts: { forceText?: boolean } = {}): Promise<void> {
    const p = normalize(path);
    const cur = this.state.docs[p];
    if (cur && cur.status !== 'error' && cur.status !== 'missing' && !(opts.forceText && cur.status === 'binary')) {
      return this.loads.get(p) ?? Promise.resolve();
    }
    const job = this.loadDoc(p, opts).finally(() => this.loads.delete(p));
    this.loads.set(p, job);
    return job;
  }

  private async loadDoc(path: string, opts: { forceText?: boolean }): Promise<void> {
    this.set((s) => ({
      docs: {
        ...s.docs,
        [path]: {
          path,
          status: 'loading',
          sha: '',
          size: 0,
          dirty: false,
          eol: 'LF',
          bom: false,
          saving: false,
          diskChanged: false,
        },
      },
    }));
    let read;
    try {
      [read] = await Promise.all([this.host.readFile(path), this.loadMonaco()]);
    } catch (err) {
      if (err instanceof IdeError && err.code === 'too_large') {
        this.patchDoc(path, { status: 'too_large', message: err.message, size: Number(err.detail?.size ?? 0) });
      } else if (err instanceof IdeError && err.code === 'not_found') {
        this.patchDoc(path, { status: 'missing', message: '파일이 없습니다' });
      } else {
        this.patchDoc(path, { status: 'error', message: errorMessage(err, '파일을 열지 못했습니다') });
      }
      return;
    }
    if (!opts.forceText && looksBinary(read.bytes)) {
      this.patchDoc(path, { status: 'binary', sha: read.sha, size: read.size });
      return;
    }
    const decoded = decodeText(read.bytes);
    const monaco = this.monaco!;
    const uri = modelUri(monaco, this.host.workflowId, path);
    let model = monaco.editor.getModel(uri);
    if (model) model.setValue(decoded.text);
    else model = monaco.editor.createModel(decoded.text, undefined, uri);
    model.setEOL(decoded.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    this.savedVersion.set(path, model.getAlternativeVersionId());
    this.modelSubs.get(path)?.dispose();
    this.modelSubs.set(
      path,
      model.onDidChangeContent(() => this.onModelChange(path)),
    );
    this.patchDoc(path, {
      status: 'ready',
      sha: read.sha,
      size: read.size,
      eol: decoded.eol,
      bom: decoded.bom,
      dirty: false,
      diskChanged: false,
      message: undefined,
    });
  }

  private onModelChange(path: string): void {
    const model = this.getModel(path);
    const doc = this.state.docs[path];
    if (!model || !doc) return;
    const dirty = model.getAlternativeVersionId() !== this.savedVersion.get(path);
    if (dirty !== doc.dirty) this.patchDoc(path, { dirty });
    if (dirty) this.pinPreviewTabsOf(path);
    if (dirty && this.state.layout.autoSave) {
      clearTimeout(this.autoSaveTimers.get(path));
      this.autoSaveTimers.set(
        path,
        setTimeout(() => {
          this.autoSaveTimers.delete(path);
          if (this.state.docs[path]?.dirty && !this.state.docs[path]?.diskChanged) void this.save(path, { quiet: true });
        }, 1000),
      );
    }
  }

  /** 문서를 쓰는 탭이 하나도 없으면 버린다(모델까지). */
  private releaseDocIfUnused(path: string): void {
    const used = this.state.groups.some((g) =>
      g.tabs.some((t) => t.path === path && (t.kind === 'file' || (t.kind === 'diff' && !t.diff?.staged))),
    );
    if (used) return;
    this.modelSubs.get(path)?.dispose();
    this.modelSubs.delete(path);
    this.savedVersion.delete(path);
    clearTimeout(this.autoSaveTimers.get(path));
    this.autoSaveTimers.delete(path);
    this.getModel(path)?.dispose();
    this.set((s) => {
      const docs = { ...s.docs };
      delete docs[path];
      return { docs };
    });
  }

  async save(path: string, opts: { force?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    const doc = this.state.docs[path];
    const model = this.getModel(path);
    if (!doc || !model || doc.status !== 'ready' || this.state.readonly) return false;
    if (doc.saving) return false;
    const version = model.getAlternativeVersionId();
    const bytes = encodeText(model.getValue(), doc.eol, doc.bom);
    this.patchDoc(path, { saving: true });
    try {
      const out = await this.host.saveFile(path, bytes, opts.force ? null : doc.sha);
      this.savedVersion.set(path, version);
      this.patchDoc(path, {
        saving: false,
        sha: out.sha,
        size: bytes.length,
        dirty: model.getAlternativeVersionId() !== version,
        diskChanged: false,
      });
      if (!this.exists(path)) void this.refreshFiles();
      this.scheduleGit();
      if (out.conflicts?.length) {
        this.notify('warning', '다른 곳에서 같은 파일을 고쳐 두 판을 모두 남겼습니다. 탐색기에서 .conflict 파일을 확인하세요.');
      } else if (!opts.quiet) {
        this.set({ notice: { kind: 'success', message: `${basename(path)} 저장됨`, at: Date.now() } });
      }
      return true;
    } catch (err) {
      this.patchDoc(path, { saving: false });
      if (err instanceof IdeError && err.code === 'changed') {
        this.patchDoc(path, { diskChanged: true });
        return this.resolveSaveConflict(path);
      }
      this.notify('error', errorMessage(err, `${basename(path)} 을(를) 저장하지 못했습니다`));
      return false;
    }
  }

  /** 저장했더니 디스크 판이 그사이 바뀌었다 — 비교·덮어쓰기·되돌리기 중 고른다. */
  private async resolveSaveConflict(path: string): Promise<boolean> {
    const r = await this.ask({
      title: `${basename(path)} 이(가) 그사이 바뀌었습니다`,
      message: '에이전트나 터미널이 이 파일을 먼저 고쳤습니다. 어떻게 할까요?',
      buttons: [
        { id: 'compare', label: '비교', primary: true },
        { id: 'overwrite', label: '내 판으로 덮어쓰기', danger: true },
        { id: 'revert', label: '바뀐 판 불러오기' },
        { id: 'cancel', label: '취소' },
      ],
    });
    if (r.button === 'overwrite') return this.save(path, { force: true });
    if (r.button === 'revert') {
      await this.reloadFromDisk(path, { discard: true });
      return false;
    }
    if (r.button === 'compare') await this.openDiskCompare(path);
    return false;
  }

  /** 디스크 판(왼쪽)과 내 버퍼(오른쪽)를 나란히 본다. */
  async openDiskCompare(path: string): Promise<void> {
    const monaco = await this.loadMonaco();
    let read;
    try {
      read = await this.host.readFile(path);
    } catch (err) {
      this.notify('error', errorMessage(err, '디스크 판을 읽지 못했습니다'));
      return;
    }
    const uri = diskUri(monaco, this.host.workflowId, path);
    const text = decodeText(read.bytes).text;
    const existing = monaco.editor.getModel(uri);
    if (existing) existing.setValue(text);
    else monaco.editor.createModel(text, undefined, uri);
    const diff: DiffSpec = { repo: '', path, staged: false, status: 'modified', disk: true };
    this.openTab({ id: tabIdFor('diff', path, diff), kind: 'diff', path, preview: false, diff });
  }

  /** 줄 끝을 바꿨다(상태 표시줄) — 다음 저장이 그 줄 끝으로 쓴다. */
  setDocEol(path: string, eol: Eol): void {
    this.patchDoc(path, { eol });
    this.onModelChange(path);
  }

  async saveAll(): Promise<void> {
    for (const doc of Object.values(this.state.docs)) {
      if (doc.dirty && doc.status === 'ready') await this.save(doc.path, { quiet: true });
    }
  }

  /** 디스크에서 다시 읽는다. `discard` 면 고친 것을 버린다(되돌리기 기록은 남긴다). */
  async reloadFromDisk(path: string, opts: { discard?: boolean } = {}): Promise<void> {
    const doc = this.state.docs[path];
    const model = this.getModel(path);
    if (!doc || !model) return;
    if (doc.dirty && !opts.discard) return;
    let read;
    try {
      read = await this.host.readFile(path);
    } catch (err) {
      if (err instanceof IdeError && err.code === 'not_found') {
        this.patchDoc(path, { diskChanged: true, message: '디스크에서 지워졌습니다' });
      }
      return;
    }
    const decoded = decodeText(read.bytes);
    if (model.getValue() !== decoded.text) {
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: decoded.text }], () => null);
      model.pushStackElement();
    }
    this.savedVersion.set(path, model.getAlternativeVersionId());
    this.patchDoc(path, {
      sha: read.sha,
      size: read.size,
      eol: decoded.eol,
      bom: decoded.bom,
      dirty: false,
      diskChanged: false,
      message: undefined,
    });
  }

  /** 열어 둔 파일의 디스크 판을 본다 — 바뀌었으면 깨끗한 버퍼는 조용히 다시 읽는다. */
  async checkDisk(which: 'visible' | 'all'): Promise<void> {
    const docs = Object.values(this.state.docs).filter((d) => d.status === 'ready' && d.sha);
    const visible = new Set(
      this.state.groups.map((g) => g.tabs.find((t) => t.id === g.activeId)?.path).filter(Boolean) as string[],
    );
    const paths = docs.map((d) => d.path).filter((p) => which === 'all' || visible.has(p));
    if (!paths.length) return;
    let stats;
    try {
      stats = await this.host.stat(paths);
    } catch {
      return;
    }
    for (const path of paths) {
      const st = stats[path];
      const doc = this.state.docs[path];
      if (!st || !doc || doc.saving) continue;
      if (st.kind === 'file' && st.sha && st.sha !== doc.sha) {
        if (doc.dirty) {
          if (!doc.diskChanged) this.patchDoc(path, { diskChanged: true });
        } else {
          await this.reloadFromDisk(path);
        }
      } else if (st.kind === 'missing' && !doc.diskChanged) {
        this.patchDoc(path, { diskChanged: true, message: '디스크에서 지워졌습니다' });
      }
    }
  }

  // ── 탭·편집기 묶음 ────────────────────────────────────────────────

  activeGroup(): EditorGroup {
    return this.state.groups.find((g) => g.id === this.state.activeGroup) ?? this.state.groups[0];
  }

  activeTab(): EditorTab | null {
    const g = this.activeGroup();
    return g.tabs.find((t) => t.id === g.activeId) ?? null;
  }

  setActiveGroup(id: string): void {
    if (this.state.activeGroup !== id && this.state.groups.some((g) => g.id === id)) this.set({ activeGroup: id });
  }

  /** 탭을 연다. 미리보기 탭은 같은 묶음의 기존 미리보기 자리를 바꿔 쓴다. */
  openTab(tab: EditorTab, opts: { groupId?: string; background?: boolean } = {}): void {
    const groupId = opts.groupId ?? this.state.activeGroup;
    this.set((s) => {
      const groups = s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const existing = g.tabs.find((t) => t.id === tab.id);
        if (existing) {
          const tabs = tab.preview ? g.tabs : g.tabs.map((t) => (t.id === tab.id ? { ...t, preview: false } : t));
          return { ...g, tabs, activeId: opts.background ? g.activeId : tab.id };
        }
        let tabs = g.tabs;
        if (tab.preview) {
          const idx = tabs.findIndex((t) => t.preview);
          if (idx >= 0) {
            const replaced = tabs[idx];
            tabs = [...tabs.slice(0, idx), tab, ...tabs.slice(idx + 1)];
            queueMicrotask(() => this.releaseDocIfUnused(replaced.path));
            return { ...g, tabs, activeId: opts.background ? g.activeId : tab.id };
          }
        }
        const at = g.activeId ? tabs.findIndex((t) => t.id === g.activeId) + 1 : tabs.length;
        tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
        return { ...g, tabs, activeId: opts.background ? g.activeId : tab.id };
      });
      return { groups, activeGroup: groupId };
    });
    this.persistTabs();
  }

  /** 파일을 연다 — 그림은 그림으로, 나머지는 편집기로. */
  async openFile(
    path: string,
    opts: { preview?: boolean; groupId?: string; line?: number; col?: number; length?: number; forceText?: boolean } = {},
  ): Promise<void> {
    const p = normalize(path);
    if (!p) return;
    const kind: TabKind = isImagePath(p) && !opts.forceText ? 'image' : 'file';
    this.openTab({ id: tabIdFor(kind, p), kind, path: p, preview: opts.preview ?? false }, { groupId: opts.groupId });
    this.reveal(p);
    if (kind === 'file') {
      await this.ensureDoc(p, { forceText: opts.forceText });
      if (opts.line) this.pendingReveal = { path: p, line: opts.line, col: opts.col ?? 1, length: opts.length ?? 0 };
      this.set({});
    }
  }

  /** 줄로 이동해야 하는 문서 — 편집기가 모델을 붙인 뒤 소비한다. */
  pendingReveal: { path: string; line: number; col: number; length: number } | null = null;

  openDiff(diff: DiffSpec, opts: { preview?: boolean } = {}): void {
    const path = toWorkspacePath(diff.repo, diff.path);
    this.openTab({ id: tabIdFor('diff', path, diff), kind: 'diff', path, preview: opts.preview ?? true, diff });
    if (!diff.staged && diff.status !== 'deleted') void this.ensureDoc(path);
  }

  pinTab(groupId: string, tabId: string): void {
    this.set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)) } : g,
      ),
    }));
    this.persistTabs();
  }

  private pinPreviewTabsOf(path: string): void {
    if (!this.state.groups.some((g) => g.tabs.some((t) => t.path === path && t.preview && t.kind === 'file'))) return;
    this.set((s) => ({
      groups: s.groups.map((g) => ({
        ...g,
        tabs: g.tabs.map((t) => (t.path === path && t.preview && t.kind === 'file' ? { ...t, preview: false } : t)),
      })),
    }));
    this.persistTabs();
  }

  activateTab(groupId: string, tabId: string): void {
    this.set((s) => ({
      activeGroup: groupId,
      groups: s.groups.map((g) => (g.id === groupId ? { ...g, activeId: tabId } : g)),
    }));
    const tab = this.state.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
    if (tab && tab.kind !== 'diff') this.reveal(tab.path);
    this.persistTabs();
  }

  /** 탭을 닫는다. 고친 채면 먼저 묻는다(저장·저장 안 함·취소). */
  async closeTab(groupId: string, tabId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const group = this.state.groups.find((g) => g.id === groupId);
    const tab = group?.tabs.find((t) => t.id === tabId);
    if (!group || !tab) return true;
    const doc = this.state.docs[tab.path];
    // 이 탭이 그 문서를 보여 주는 **마지막** 탭인가(다른 묶음의 같은 파일·작업 트리 비교도 센다).
    const viewsDoc = (t: EditorTab) =>
      t.path === tab.path && (t.kind === 'file' || (t.kind === 'diff' && !t.diff?.staged));
    const others = this.state.groups.reduce(
      (n, g) => n + g.tabs.filter((t) => viewsDoc(t) && !(g.id === groupId && t.id === tabId)).length,
      0,
    );
    const lastView = viewsDoc(tab) && others === 0;
    if (!opts.force && lastView && doc?.dirty) {
      const r = await this.ask({
        title: `${basename(tab.path)} 의 변경 내용을 저장할까요?`,
        message: '저장하지 않으면 변경 내용이 사라집니다.',
        buttons: [
          { id: 'save', label: '저장', primary: true },
          { id: 'discard', label: '저장 안 함', danger: true },
          { id: 'cancel', label: '취소' },
        ],
      });
      if (r.button === 'cancel') return false;
      if (r.button === 'save' && !(await this.save(tab.path))) return false;
    }
    this.set((s) => {
      let groups = s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const idx = g.tabs.findIndex((t) => t.id === tabId);
        const tabs = g.tabs.filter((t) => t.id !== tabId);
        let activeId = g.activeId;
        if (activeId === tabId) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
        return { ...g, tabs, activeId };
      });
      let activeGroup = s.activeGroup;
      // 빈 묶음은 접는다(하나는 남긴다).
      if (groups.length > 1) {
        const emptied = groups.find((g) => g.id === groupId && g.tabs.length === 0);
        if (emptied) {
          const i = groups.indexOf(emptied);
          groups = groups.filter((g) => g !== emptied);
          if (activeGroup === groupId) activeGroup = groups[Math.max(0, i - 1)].id;
          this.editors.delete(groupId);
        }
      }
      return { groups, activeGroup };
    });
    this.closedTabs.push(tab);
    if (this.closedTabs.length > 30) this.closedTabs.shift();
    this.viewStates.delete(`${groupId}:${tabId}`);
    this.releaseDocIfUnused(tab.path);
    this.persistTabs();
    return true;
  }

  async closeTabs(groupId: string, which: 'others' | 'right' | 'all' | 'saved', pivot?: string): Promise<void> {
    const group = this.state.groups.find((g) => g.id === groupId);
    if (!group) return;
    const idx = pivot ? group.tabs.findIndex((t) => t.id === pivot) : -1;
    const targets = group.tabs.filter((t, i) => {
      if (which === 'others') return t.id !== pivot;
      if (which === 'right') return i > idx;
      if (which === 'saved') return !this.state.docs[t.path]?.dirty;
      return true;
    });
    for (const t of targets) {
      if (!(await this.closeTab(groupId, t.id))) break;
    }
  }

  async closeAllGroups(): Promise<void> {
    for (const g of [...this.state.groups]) await this.closeTabs(g.id, 'all');
  }

  reopenClosedTab(): void {
    const tab = this.closedTabs.pop();
    if (!tab) return;
    if (tab.kind === 'diff' && tab.diff) this.openDiff(tab.diff, { preview: false });
    else void this.openFile(tab.path, { preview: false });
  }

  cycleTab(delta: 1 | -1): void {
    const g = this.activeGroup();
    if (!g.tabs.length) return;
    const i = g.tabs.findIndex((t) => t.id === g.activeId);
    const next = g.tabs[(i + delta + g.tabs.length) % g.tabs.length];
    this.activateTab(g.id, next.id);
  }

  moveTab(fromGroup: string, tabId: string, toGroup: string, index: number): void {
    const src = this.state.groups.find((g) => g.id === fromGroup);
    const tab = src?.tabs.find((t) => t.id === tabId);
    if (!src || !tab) return;
    this.set((s) => {
      let groups = s.groups.map((g) => {
        if (g.id === fromGroup && g.id === toGroup) {
          const tabs = g.tabs.filter((t) => t.id !== tabId);
          const at = Math.max(0, Math.min(index, tabs.length));
          return { ...g, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], activeId: tabId };
        }
        if (g.id === fromGroup) {
          const tabs = g.tabs.filter((t) => t.id !== tabId);
          const activeId = g.activeId === tabId ? tabs[0]?.id ?? null : g.activeId;
          return { ...g, tabs, activeId };
        }
        if (g.id === toGroup) {
          const tabs = g.tabs.filter((t) => t.id !== tabId);
          const at = Math.max(0, Math.min(index, tabs.length));
          return { ...g, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], activeId: tabId };
        }
        return g;
      });
      if (groups.length > 1) groups = groups.filter((g) => g.tabs.length > 0);
      return { groups, activeGroup: toGroup };
    });
    this.persistTabs();
  }

  /**
   * 편집기를 오른쪽으로 나눈다(최대 3묶음). 기본은 지금 탭을 새 묶음에도 연다(편집기의
   * "나누기"). `empty` 면 빈 묶음을 만든다("옆에 열기"). 새(또는 오른쪽) 묶음 id 를 돌려준다.
   */
  splitRight(opts: { tabId?: string; empty?: boolean } = {}): string {
    const g = this.activeGroup();
    const tab = opts.empty ? undefined : g.tabs.find((t) => t.id === (opts.tabId ?? g.activeId));
    const idx = this.state.groups.indexOf(g);
    if (this.state.groups.length >= 3) {
      const next = this.state.groups[Math.min(idx + 1, this.state.groups.length - 1)];
      if (tab && next.id !== g.id) this.openTab({ ...tab, preview: false }, { groupId: next.id });
      return next.id;
    }
    const id = newGroupId();
    this.set((s) => {
      const groups = [...s.groups];
      groups.splice(idx + 1, 0, { id, tabs: tab ? [{ ...tab, preview: false }] : [], activeId: tab?.id ?? null });
      return { groups, activeGroup: id };
    });
    this.persistTabs();
    return id;
  }

  /** 옆 묶음에 연다 — 없으면 만든다. */
  async openToSide(path: string): Promise<void> {
    const groups = this.state.groups;
    const idx = groups.findIndex((g) => g.id === this.state.activeGroup);
    const target = groups[idx + 1]?.id ?? this.splitRight({ empty: true });
    await this.openFile(path, { preview: false, groupId: target });
  }

  focusGroup(index: number): void {
    const g = this.state.groups[index];
    if (g) {
      this.set({ activeGroup: g.id });
      this.editors.get(g.id)?.focus();
    }
  }

  private restoreTabs(): void {
    const saved = this.readJson<{ groups?: { tabs: { kind: TabKind; path: string; diff?: DiffSpec }[]; active: string | null }[]; activeIndex?: number }>('tabs', {});
    if (!saved.groups?.length) return;
    const known = new Set(this.state.files.map((f) => f.path));
    const groups: EditorGroup[] = [];
    for (const sg of saved.groups.slice(0, 3)) {
      const tabs: EditorTab[] = [];
      for (const t of sg.tabs ?? []) {
        if (t.kind !== 'diff' && !known.has(t.path)) continue;
        tabs.push({ id: tabIdFor(t.kind, t.path, t.diff), kind: t.kind, path: t.path, preview: false, diff: t.diff });
      }
      if (!tabs.length) continue;
      const active = tabs.find((t) => t.path === sg.active && t.kind !== 'diff') ?? tabs[0];
      groups.push({ id: newGroupId(), tabs, activeId: active.id });
    }
    if (!groups.length) return;
    const activeGroup = groups[Math.max(0, Math.min(saved.activeIndex ?? 0, groups.length - 1))].id;
    this.set({ groups, activeGroup });
    for (const g of groups) {
      for (const t of g.tabs) {
        if (t.kind === 'file') void this.ensureDoc(t.path);
        else if (t.kind === 'diff' && t.diff && !t.diff.staged) void this.ensureDoc(t.path);
      }
    }
  }

  // ── 파일 작업 ─────────────────────────────────────────────────────

  private async runFs(op: IdeFsOp, done: string): Promise<boolean> {
    try {
      await this.host.fs(op);
      await this.refreshFiles();
      this.scheduleGit();
      this.set({ notice: { kind: 'success', message: done, at: Date.now() } });
      return true;
    } catch (err) {
      this.notify('error', errorMessage(err, '작업을 마치지 못했습니다'));
      return false;
    }
  }

  async createEntry(parent: string, name: string, kind: 'file' | 'dir'): Promise<boolean> {
    const path = join(parent, name);
    this.set({ creating: null });
    if (this.exists(path)) {
      this.notify('warning', `${name} 은(는) 이미 있습니다`);
      return false;
    }
    if (kind === 'dir') return this.runFs({ op: 'mkdir', path }, `${name} 폴더를 만들었습니다`);
    try {
      await this.host.saveFile(path, new Uint8Array(), '');
    } catch (err) {
      this.notify('error', errorMessage(err, `${name} 을(를) 만들지 못했습니다`));
      return false;
    }
    await this.refreshFiles();
    this.scheduleGit();
    await this.openFile(path, { preview: false });
    return true;
  }

  async renameEntry(path: string, newName: string): Promise<boolean> {
    this.set({ renaming: null });
    const dst = join(dirname(path), newName);
    if (dst === path) return true;
    return this.moveEntry(path, dst);
  }

  /** 옮기기·이름 바꾸기 — 열린 탭과 고친 버퍼도 따라간다. */
  async moveEntry(src: string, dst: string): Promise<boolean> {
    if (isWithin(dst, src)) {
      this.notify('warning', '폴더를 자기 안으로 옮길 수 없습니다');
      return false;
    }
    const dirtyInside = Object.values(this.state.docs).filter((d) => d.dirty && isWithin(d.path, src));
    if (dirtyInside.length) {
      const ok = await this.confirm(
        '저장하지 않은 파일이 있습니다',
        '옮기기 전에 저장합니다.',
        '저장하고 옮기기',
      );
      if (!ok) return false;
      for (const d of dirtyInside) if (!(await this.save(d.path, { quiet: true }))) return false;
    }
    const ok = await this.runFs({ op: 'rename', src, dst }, `${basename(dst)}(으)로 옮겼습니다`);
    if (!ok) return false;
    // 열린 탭을 새 경로로 옮긴다(문서는 새로 읽는다 — sha 는 같다).
    const moved = new Set<string>();
    this.set((s) => ({
      groups: s.groups.map((g) => {
        let activeId = g.activeId;
        const tabs = g.tabs.map((t) => {
          if (t.kind === 'diff' || !isWithin(t.path, src)) return t;
          const path = dst + t.path.slice(src.length);
          moved.add(t.path);
          const id = tabIdFor(t.kind, path);
          if (activeId === t.id) activeId = id;
          return { ...t, id, path };
        });
        return { ...g, tabs, activeId };
      }),
    }));
    for (const old of moved) {
      this.releaseDocIfUnused(old);
      const next = dst + old.slice(src.length);
      if (!isImagePath(next)) void this.ensureDoc(next);
    }
    if (this.state.selected && isWithin(this.state.selected, src)) this.select(dst + this.state.selected.slice(src.length));
    this.persistTabs();
    return true;
  }

  async deleteEntries(paths: string[]): Promise<boolean> {
    if (!paths.length || this.state.readonly) return false;
    const label = paths.length === 1 ? basename(paths[0]) : `${paths.length}개 항목`;
    const hasDir = paths.some((p) => this.isDir(p));
    const ok = await this.confirm(
      `${label} 을(를) 지울까요?`,
      hasDir ? '폴더와 그 안의 모든 파일을 지웁니다. 되돌릴 수 없습니다.' : '되돌릴 수 없습니다.',
      '지우기',
      true,
    );
    if (!ok) return false;
    const done = await this.runFs({ op: 'delete', paths }, `${label} 을(를) 지웠습니다`);
    if (!done) return false;
    for (const g of [...this.state.groups]) {
      for (const t of g.tabs) {
        if (t.kind !== 'diff' && paths.some((p) => isWithin(t.path, p))) await this.closeTab(g.id, t.id, { force: true });
      }
    }
    return true;
  }

  async duplicateOrPaste(targetDir: string): Promise<void> {
    const clip = this.state.clipboard;
    if (!clip || this.state.readonly) return;
    const taken = new Set(this.childNames(targetDir));
    for (const src of clip.paths) {
      const name = basename(src);
      if (clip.mode === 'cut') {
        if (dirname(src) === targetDir) continue;
        let dst = join(targetDir, name);
        if (taken.has(name)) {
          const replace = await this.confirm(`${name} 이(가) 이미 있습니다`, '같은 이름이 있어 옮길 수 없습니다. 이름을 바꿔 옮길까요?', '이름 바꿔 옮기기');
          if (!replace) continue;
          dst = join(targetDir, uniqueCopyName(name, taken));
        }
        if (await this.moveEntry(src, dst)) taken.add(basename(dst));
      } else {
        const dstName = uniqueCopyName(name, taken);
        taken.add(dstName);
        await this.runFs({ op: 'copy', src, dst: join(targetDir, dstName) }, `${dstName}(으)로 복사했습니다`);
      }
    }
    if (clip.mode === 'cut') this.set({ clipboard: null });
  }

  childNames(dir: string): string[] {
    const prefix = dir ? dir + '/' : '';
    const out = new Set<string>();
    for (const f of this.state.files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (rest) out.add(rest.split('/')[0]);
    }
    return [...out];
  }

  setClipboard(mode: 'copy' | 'cut', paths: string[]): void {
    this.set({ clipboard: paths.length ? { mode, paths } : null });
  }

  /** 운영체제에서 끌어다 놓은 파일을 올린다(같은 이름이 있으면 묻는다). */
  async upload(targetDir: string, files: { name: string; bytes: Uint8Array }[]): Promise<void> {
    if (this.state.readonly) return;
    let done = 0;
    for (const f of files) {
      const path = join(targetDir, f.name);
      let base: string | null = '';
      if (this.exists(path)) {
        const ok = await this.confirm(`${f.name} 이(가) 이미 있습니다`, '올린 파일로 바꿀까요?', '바꾸기', true);
        if (!ok) continue;
        base = null;
      }
      try {
        await this.host.saveFile(path, f.bytes, base);
        done += 1;
        if (this.state.docs[path] && !this.state.docs[path].dirty) void this.reloadFromDisk(path);
      } catch (err) {
        this.notify('error', errorMessage(err, `${f.name} 을(를) 올리지 못했습니다`));
      }
    }
    if (done) {
      await this.refreshFiles();
      this.scheduleGit();
      this.set({ notice: { kind: 'success', message: `${done}개 파일을 올렸습니다`, at: Date.now() } });
    }
  }

  // ── 찾기 ──────────────────────────────────────────────────────────

  setSearch(patch: Partial<SearchState>): void {
    this.set((s) => ({ search: { ...s.search, ...patch } }));
  }

  async runSearch(): Promise<void> {
    const s = this.state.search;
    const query = s.query;
    if (!query) {
      this.setSearch({ result: null, error: null, running: false });
      return;
    }
    const seq = ++this.searchSeq;
    this.setSearch({ running: true, error: null });
    const q: IdeSearchQuery = {
      query,
      regex: s.regex,
      case: s.caseSensitive,
      word: s.word,
      include: s.include,
      exclude: s.exclude,
    };
    try {
      const result = await this.host.search(q);
      if (seq !== this.searchSeq) return;
      this.setSearch({ result, running: false, collapsed: new Set() });
    } catch (err) {
      if (seq !== this.searchSeq) return;
      this.setSearch({ running: false, error: errorMessage(err, '찾지 못했습니다'), result: null });
    }
  }

  async replaceInFiles(files?: string[]): Promise<void> {
    const s = this.state.search;
    const targets = files ?? s.result?.files.map((f) => f.path) ?? [];
    if (!targets.length || this.state.readonly) return;
    const total = (s.result?.files ?? []).filter((f) => targets.includes(f.path)).reduce((n, f) => n + f.matches.length, 0);
    const ok = await this.confirm(
      '모두 바꿀까요?',
      `${targets.length}개 파일의 ${total}개 결과를 "${s.replace}" (으)로 바꿉니다.`,
      '바꾸기',
      true,
    );
    if (!ok) return;
    // 열려 있고 고친 파일은 먼저 저장한다 — 그대로 두면 바꾸기가 디스크를 고친 뒤 편집기 저장이 덮는다.
    for (const p of targets) if (this.state.docs[p]?.dirty && !(await this.save(p, { quiet: true }))) return;
    try {
      const out = await this.host.replace({
        query: s.query,
        regex: s.regex,
        case: s.caseSensitive,
        word: s.word,
        include: s.include,
        exclude: s.exclude,
        replacement: s.replace,
        files: targets,
      });
      const n = out.changed.reduce((a, c) => a + c.count, 0);
      this.set({ notice: { kind: 'success', message: `${out.changed.length}개 파일에서 ${n}개를 바꿨습니다`, at: Date.now() } });
      for (const c of out.changed) if (this.state.docs[c.path]) await this.reloadFromDisk(c.path);
      await this.runSearch();
      this.scheduleGit();
    } catch (err) {
      this.notify('error', errorMessage(err, '바꾸지 못했습니다'));
    }
  }

  // ── 소스 제어 ─────────────────────────────────────────────────────

  private setGit(patch: Partial<GitState>): void {
    this.set((s) => ({ git: { ...s.git, ...patch } }));
  }

  scheduleGit(delay = 800): void {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => void this.refreshGit(), delay);
  }

  async refreshGit(): Promise<void> {
    if (this.state.git.loading) return;
    this.setGit({ loading: true });
    try {
      const found = await this.host.git<{ repos: { path: string }[] }>({ op: 'repos' });
      const repos = (found.repos ?? []).map((r) => r.path);
      const statuses: Record<string, GitStatus> = {};
      await Promise.all(
        repos.map(async (repo) => {
          try {
            statuses[repo] = await this.host.git<GitStatus>({ op: 'status', repo });
          } catch {
            /* 한 저장소가 망가져도 나머지는 보인다 */
          }
        }),
      );
      this.setGit({ repos, statuses, loading: false, loaded: true, error: null });
    } catch (err) {
      const code = err instanceof IdeError ? err.code : 'error';
      this.setGit({ loading: false, loaded: true, error: { code, message: gitErrorMessage(code, errorMessage(err, '')) } });
    }
  }

  async refreshAccount(): Promise<void> {
    try {
      const account = await this.host.git<GitAccount>({ op: 'account' });
      this.setGit({ account });
    } catch {
      /* 계정 정보는 보조다 */
    }
  }

  setCommitMessage(repo: string, message: string): void {
    this.setGit({ message: { ...this.state.git.message, [repo]: message } });
  }

  /** git 동작 하나 — 실패는 알맞은 다음 행동과 함께 알린다. 성공하면 상태를 다시 본다. */
  async gitRun<T = Record<string, unknown>>(args: Record<string, unknown>, label: string): Promise<T | null> {
    if (this.state.git.busy) return null;
    this.setGit({ busy: label });
    try {
      const out = await this.host.git<T>(args);
      this.setGit({ busy: null });
      await this.refreshGit();
      if (['checkout', 'pull', 'sync', 'merge', 'stash', 'discard', 'clone'].includes(String(args.op))) {
        await this.refreshFiles();
        await this.checkDisk('all');
      }
      return out;
    } catch (err) {
      this.setGit({ busy: null });
      const code = err instanceof IdeError ? err.code : 'error';
      const msg = gitErrorMessage(code, errorMessage(err, ''));
      if (code === 'auth') {
        const go = await this.confirm('로그인이 필요합니다', msg, '토큰 등록');
        if (go) await this.promptCredential(this.remoteHostOf(String(args.repo ?? '')));
      } else if (code === 'identity') {
        const go = await this.confirm('커밋할 이름이 없습니다', msg, '이름과 메일 설정');
        if (go) await this.promptIdentity();
      } else {
        this.notify('error', msg);
      }
      await this.refreshGit();
      return null;
    }
  }

  remoteHostOf(repo: string): string {
    const st = this.state.git.statuses[repo];
    const r = st?.remotes.find((x) => x.name === 'origin') ?? st?.remotes[0];
    return r?.protocol === 'https' || r?.protocol === 'http' ? r.host : '';
  }

  async promptIdentity(): Promise<void> {
    const cur = this.state.git.account?.identity ?? { name: '', email: '' };
    const r = await this.ask({
      title: '커밋할 이름과 메일',
      message: '이 에이전트의 샌드박스에서 만드는 커밋에 쓰입니다.',
      fields: [
        { id: 'name', label: '이름', value: cur.name, placeholder: '홍길동' },
        { id: 'email', label: '메일', value: cur.email, placeholder: 'name@example.com' },
      ],
      buttons: [
        { id: 'ok', label: '저장', primary: true },
        { id: 'cancel', label: '취소' },
      ],
    });
    if (r.button !== 'ok') return;
    const out = await this.gitRun<GitAccount>({ op: 'identity', name: r.fields.name, email: r.fields.email }, '이름 저장');
    if (out) await this.refreshAccount();
  }

  async promptCredential(host = ''): Promise<void> {
    const r = await this.ask({
      title: '원격 저장소 토큰 등록',
      message: 'HTTPS 로 푸시·풀할 때 쓰는 개인 액세스 토큰입니다. 이 에이전트도 같은 토큰으로 푸시할 수 있습니다.',
      fields: [
        { id: 'host', label: '호스트', value: host, placeholder: 'github.com' },
        { id: 'username', label: '사용자 이름', value: '', placeholder: 'GitHub·GitLab 계정 이름' },
        { id: 'token', label: '토큰', value: '', placeholder: '개인 액세스 토큰', password: true },
      ],
      buttons: [
        { id: 'ok', label: '등록', primary: true },
        { id: 'cancel', label: '취소' },
      ],
    });
    if (r.button !== 'ok') return;
    const out = await this.gitRun(
      { op: 'credential_set', host: r.fields.host, username: r.fields.username, token: r.fields.token },
      '토큰 등록',
    );
    if (out) {
      await this.refreshAccount();
      this.set({ notice: { kind: 'success', message: '토큰을 등록했습니다', at: Date.now() } });
    }
  }

  async removeCredential(host: string, username: string): Promise<void> {
    const ok = await this.confirm(`${host} 토큰을 지울까요?`, '이 에이전트의 샌드박스에서 이 호스트로 푸시할 수 없게 됩니다.', '지우기', true);
    if (!ok) return;
    const out = await this.gitRun({ op: 'credential_remove', host, username }, '토큰 삭제');
    if (out) await this.refreshAccount();
  }

  // ── 터미널 ────────────────────────────────────────────────────────

  addTerminal(info?: Partial<IdeTerminalInfo>): string {
    const id = info?.id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const n = this.state.terminals.length + 1;
    this.set((s) => ({
      terminals: [...s.terminals, { id, title: `bash ${n}`, status: 'idle', cwd: info?.cwd }],
      activeTerminal: id,
      layout: { ...s.layout, panelOpen: true },
    }));
    this.writeJson('layout', this.state.layout);
    return id;
  }

  setTerminal(id: string, patch: Partial<TerminalState>): void {
    this.set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }

  setActiveTerminal(id: string): void {
    this.set({ activeTerminal: id });
  }

  async killTerminal(id: string): Promise<void> {
    const rt = this.terminalRuntimes.get(id);
    this.terminalRuntimes.delete(id);
    rt?.dispose();
    this.set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id);
      const activeTerminal = s.activeTerminal === id ? terminals[terminals.length - 1]?.id ?? null : s.activeTerminal;
      // 마지막 터미널을 닫으면 패널도 닫는다(새 셸을 저절로 띄우지 않는다).
      const layout = terminals.length ? s.layout : { ...s.layout, panelOpen: false, panelMaximized: false };
      return { terminals, activeTerminal, layout };
    });
    this.writeJson('layout', this.state.layout);
    try {
      await this.host.closeTerminal(id);
    } catch {
      /* 이미 닫혔다 */
    }
  }

  togglePanel(): void {
    this.setLayout({ panelOpen: !this.state.layout.panelOpen });
  }

  /** 터미널을 보이게 — 없으면 하나 연다. */
  showTerminal(newOne = false, cwd?: string): void {
    if (this.state.readonly) return;
    if (newOne || !this.state.terminals.length) this.addTerminal({ cwd });
    else this.setLayout({ panelOpen: true });
  }
}

export interface IdeCommand {
  id: string;
  title: string;
  category?: string;
  keybinding?: string;
  when?: (s: IdeState) => boolean;
  run: () => void | Promise<void>;
}

export function terminalTitle(t: IdeTerminalInfo, n: number): string {
  return `${t.shell || 'bash'} ${n}`;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof IdeError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

let cancellationGuard = false;

/**
 * Monaco 는 편집기·모델을 치우며 진행 중이던 요청(단어 강조·언어 worker)을 취소하고, 그 취소를
 * 잡히지 않은 거부(`Canceled`)로 흘린다. VS Code 는 이것을 오류로 치지 않는다 — 여기서도 그것 하나만
 * 조용히 삼킨다(다른 오류는 그대로 보인다).
 */
function ignoreMonacoCancellation(): void {
  if (cancellationGuard || typeof window === 'undefined') return;
  cancellationGuard = true;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: unknown; message?: unknown } | null;
    if (r && r.name === 'Canceled' && r.message === 'Canceled') e.preventDefault();
  });
}
