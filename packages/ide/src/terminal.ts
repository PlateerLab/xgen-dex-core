/**
 * 터미널 런타임 — xterm 한 개와 샌드박스 셸로 가는 소켓 하나.
 *
 * 화면(TerminalPanel)이 사라져도 이것은 산다: 패널을 닫거나 채팅으로 돌아갔다 와도 같은
 * xterm 이 같은 소켓으로 이어진다. 소켓이 끊기면 같은 id 로 다시 붙고, 서버는 최근 출력을
 * 돌려준다(`ready.replay`) — 그때는 화면을 비우고 그것으로 다시 그린다.
 */
import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { IdeStore, TerminalRuntime } from './store';
import type { TerminalConnection, TerminalServerFrame, ThemeKind } from './types';
import { isMac } from './keys';

/** 서버가 거절한 것 — 다시 붙어도 같다. */
const FATAL_CLOSE = new Set([4400, 4401, 4403, 4404, 4410, 4429]);
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
const PING_MS = 25_000;

/**
 * 터미널의 복사·붙여넣기 키. 셸에 보낼 키(Ctrl+C 중단 등)와 겹치는 것을 가른다.
 *
 *   맥       ⌘C(고른 글자가 있을 때) 복사 · ⌘V 붙여넣기. Ctrl 키는 모두 셸의 것이다.
 *   그 밖    Ctrl+C 는 고른 글자가 있을 때만 복사(없으면 셸에 중단), Ctrl+Shift+C·Ctrl+Insert 복사,
 *            Ctrl+V·Ctrl+Shift+V·Shift+Insert 붙여넣기(윈도 터미널과 같다).
 */
export function terminalClipboardKey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  mac: boolean,
  hasSelection: boolean,
): 'copy' | 'paste' | null {
  if (e.altKey) return null;
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null;
    if (e.code === 'KeyC') return hasSelection ? 'copy' : null;
    if (e.code === 'KeyV') return 'paste';
    return null;
  }
  if (e.metaKey) return null;
  if (e.ctrlKey && e.code === 'KeyC') return e.shiftKey || hasSelection ? 'copy' : null;
  if (e.ctrlKey && !e.shiftKey && e.code === 'Insert') return 'copy';
  if (e.ctrlKey && e.code === 'KeyV') return 'paste';
  if (e.shiftKey && !e.ctrlKey && e.code === 'Insert') return 'paste';
  return null;
}

// 바탕·글자·커서·선택은 앱(XGEN) 색, 16색(ANSI)은 흔한 터미널 색 그대로 — 명령 출력의 색을 바꾸지 않는다.
const DARK: ITheme = {
  background: '#1d1f23',
  foreground: '#e7e9ee',
  cursor: '#7d9cff',
  cursorAccent: '#1d1f23',
  selectionBackground: 'rgba(91, 130, 255, 0.32)',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1d1f23',
  cursor: '#305eeb',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(48, 94, 235, 0.2)',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

/**
 * xterm 은 **처음 터미널을 열 때** 불러온다. 모듈을 읽는 순간 브라우저 전역을 만지므로
 * 서버 렌더(웹)에서 정적으로 불러오면 죽고, 터미널을 안 쓰는 사람에게는 무게만 된다.
 */
type Xterm = {
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
};

let xtermLoading: Promise<Xterm> | null = null;

export function loadXterm(): Promise<Xterm> {
  if (!xtermLoading) {
    xtermLoading = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-search'),
      import('@xterm/addon-web-links'),
    ]).then(
      ([a, b, c, d]) => ({ Terminal: a.Terminal, FitAddon: b.FitAddon, SearchAddon: c.SearchAddon, WebLinksAddon: d.WebLinksAddon }),
      (err) => {
        xtermLoading = null;
        throw err;
      },
    );
  }
  return xtermLoading;
}

export class TerminalView implements TerminalRuntime {
  readonly element: HTMLDivElement;
  readonly term: Terminal;
  readonly search: SearchAddon;
  private readonly fitAddon: FitAddon;
  private conn: TerminalConnection | null = null;
  private opened = false;
  private disposed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private exited = false;
  private lastSize = { rows: 0, cols: 0 };

  constructor(
    x: Xterm,
    private readonly store: IdeStore,
    readonly id: string,
    private readonly cwd: string | undefined,
    theme: ThemeKind,
  ) {
    this.search = new x.SearchAddon();
    this.fitAddon = new x.FitAddon();
    this.element = document.createElement('div');
    this.element.className = 'xide-term-host';
    this.term = new x.Terminal({
      fontFamily: "'Fira Code', 'D2Coding', 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: Math.max(11, store.getState().layout.fontSize - 1),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: theme === 'light' ? LIGHT : DARK,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.search);
    this.term.loadAddon(
      new x.WebLinksAddon((_e, uri) => {
        if (store.host.openExternal) store.host.openExternal(uri);
        else window.open(uri, '_blank', 'noopener');
      }),
    );
    this.term.onData((data) => this.conn?.send({ type: 'input', data }));
    this.term.onBinary((data) => this.conn?.send({ type: 'input', data }));
    this.term.onResize(({ rows, cols }) => this.sendResize(rows, cols));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const action = terminalClipboardKey(e, isMac, this.term.hasSelection());
      if (action === 'copy') {
        // 셸에 Ctrl+C(중단)를 보내지 않고 고른 글자를 복사한다. 복사한 뒤에는 고른 것을 풀어
        // 다음 Ctrl+C 가 다시 중단이 되게 한다(윈도 터미널과 같다).
        e.preventDefault();
        const text = this.term.getSelection();
        if (text) void this.copy(text);
        if (!isMac && !e.shiftKey) this.term.clearSelection();
        return false;
      }
      if (action === 'paste') {
        // 호스트가 클립보드를 읽을 수 있으면(데스크톱) 직접 붙인다. 아니면 xterm 이 셸에 ^V 를
        // 보내지 않게만 막고, 브라우저의 붙여넣기 사건이 xterm 으로 가게 둔다(권한을 묻지 않는 길).
        if (this.store.host.readText) {
          e.preventDefault();
          void this.pasteFromClipboard();
        }
        return false;
      }
      return true;
    });
  }

  private async copy(text: string): Promise<boolean> {
    const ok = (await this.store.host.copyText?.(text)) ?? (await navigator.clipboard?.writeText(text).then(() => true, () => false));
    if (!ok) this.store.notify('error', '복사하지 못했습니다');
    return !!ok;
  }

  /** 고른 글자를 복사한다(메뉴). 고른 것이 없으면 아무것도 하지 않는다. */
  async copySelection(): Promise<void> {
    const text = this.term.getSelection();
    if (text) await this.copy(text);
    this.term.focus();
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  private async readClipboard(): Promise<string | null> {
    try {
      if (this.store.host.readText) return (await this.store.host.readText()) ?? null;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) return await navigator.clipboard.readText();
    } catch {
      /* 권한이 없거나 브라우저가 막았다 */
    }
    return null;
  }

  /** 클립보드의 글을 셸에 붙인다 — 여러 줄은 한 번에(괄호 붙여넣기를 켠 셸이면 그대로 둔다). */
  async pasteFromClipboard(): Promise<void> {
    const text = await this.readClipboard();
    if (text === null) {
      this.store.notify('warning', isMac ? '⌘V 로 붙여 넣으세요' : 'Ctrl+V 로 붙여 넣으세요');
    } else if (text) {
      this.term.paste(text);
    }
    this.term.focus();
  }

  /** 화면에 붙인다(처음이면 xterm 을 연다). 연결이 없으면 연다. */
  attach(parent: HTMLElement, focus = false): void {
    if (this.element.parentElement !== parent) parent.appendChild(this.element);
    if (!this.opened) {
      this.term.open(this.element);
      this.opened = true;
    }
    this.fit();
    if (!this.conn && !this.disposed && !this.retryTimer) this.connect();
    if (focus) this.term.focus();
  }

  detach(): void {
    this.element.remove();
  }

  fit(): void {
    if (!this.opened || !this.element.isConnected || !this.element.clientWidth || !this.element.clientHeight) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* 보이지 않는 동안에는 잴 수 없다 */
    }
  }

  setTheme(theme: ThemeKind): void {
    this.term.options.theme = theme === 'light' ? LIGHT : DARK;
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = Math.max(11, size - 1);
    this.fit();
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.clear();
  }

  private sendResize(rows: number, cols: number): void {
    if (rows === this.lastSize.rows && cols === this.lastSize.cols) return;
    this.lastSize = { rows, cols };
    this.conn?.send({ type: 'resize', rows, cols });
  }

  connect(): void {
    if (this.disposed) return;
    this.exited = false;
    this.store.setTerminal(this.id, { status: this.attempt ? 'reconnecting' : 'connecting', message: undefined });
    const conn = this.store.host.openTerminal(
      this.id,
      { rows: this.term.rows, cols: this.term.cols, cwd: this.cwd },
      {
        onFrame: (f) => this.onFrame(f),
        onClose: (code, reason) => this.onClose(conn, code, reason),
      },
    );
    this.conn = conn;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      // 보고 있을 때만 — 창을 내려 둔 IDE 가 샌드박스를 영원히 붙잡지 않게.
      if (typeof document === 'undefined' || !document.hidden) this.conn?.send({ type: 'ping' });
    }, PING_MS);
  }

  private onFrame(f: TerminalServerFrame): void {
    switch (f.type) {
      case 'ready':
        this.attempt = 0;
        if (f.replay) this.term.reset();
        this.store.setTerminal(this.id, { status: 'open', message: undefined, cwd: f.cwd });
        this.lastSize = { rows: 0, cols: 0 };
        this.sendResize(this.term.rows, this.term.cols);
        break;
      case 'output':
        this.term.write(f.data);
        break;
      case 'exit':
        this.exited = true;
        this.term.write(`\r\n\x1b[2m[프로세스가 끝났습니다${f.code >= 0 ? ` (코드 ${f.code})` : ''}${f.reason ? `: ${f.reason}` : ''}]\x1b[0m\r\n`);
        this.store.setTerminal(this.id, { status: 'exited', exitCode: f.code });
        break;
      case 'synced':
        // 사용자가 터미널에서 바꾼 것이 발행됐다 — 탐색기·소스 제어·열어 둔 파일을 따라가게 한다.
        void this.store.refreshFiles();
        this.store.scheduleGit(300);
        void this.store.checkDisk('all');
        break;
      case 'error':
        this.store.setTerminal(this.id, { status: 'error', message: f.reason });
        break;
      default:
        break;
    }
  }

  private onClose(conn: TerminalConnection, code: number, reason: string): void {
    if (this.conn !== conn) return;
    this.conn = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.disposed || this.exited) return;
    const st = this.store.getState().terminals.find((t) => t.id === this.id);
    if (FATAL_CLOSE.has(code)) {
      this.store.setTerminal(this.id, { status: 'error', message: st?.message || reason || '터미널을 열 수 없습니다' });
      return;
    }
    if (this.attempt >= RETRY_DELAYS.length) {
      this.store.setTerminal(this.id, { status: 'error', message: '연결이 끊겼습니다' });
      return;
    }
    const delay = RETRY_DELAYS[this.attempt];
    this.attempt += 1;
    this.store.setTerminal(this.id, { status: 'reconnecting' });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** 끊긴 뒤·끝난 뒤 다시 — 끝난 셸이면 같은 id 로 새 셸이 뜬다. */
  restart(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.conn?.close();
    this.conn = null;
    this.attempt = 0;
    if (this.exited) this.term.reset();
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.conn?.close();
    this.conn = null;
    this.term.dispose();
    this.element.remove();
  }
}

/** 저장소에 이 터미널의 런타임이 없으면 만든다(xterm 을 처음이면 불러온다). */
export async function ensureTerminalView(
  store: IdeStore,
  id: string,
  cwd: string | undefined,
  theme: ThemeKind,
): Promise<TerminalView | null> {
  const existing = store.terminalRuntimes.get(id);
  if (existing instanceof TerminalView) return existing;
  const x = await loadXterm();
  // 불러오는 사이 누가 만들었거나(두 번 부름) 그 터미널이 닫혔으면 새로 만들지 않는다.
  const again = store.terminalRuntimes.get(id);
  if (again instanceof TerminalView) return again;
  if (!store.getState().terminals.some((t) => t.id === id)) return null;
  const view = new TerminalView(x, store, id, cwd, theme);
  store.terminalRuntimes.set(id, view);
  return view;
}
