/**
 * IDE 보기가 호스트(데스크톱 앱·웹)에게 바라는 것 — 이것만 구현하면 같은 IDE 가 뜬다.
 *
 * IDE 는 새 저장소가 아니다. 에이전트가 이미 가진 것을 편집기처럼 보여 주는 보기다:
 *
 *   탐색기     = 그 에이전트의 스토리지 목록 그대로(`listFiles`)
 *   편집기     = 샌드박스의 파일(`readFile`/`saveFile` — 저장은 읽은 판을 조건으로 건다)
 *   터미널     = 에이전트 샌드박스 안의 셸(`openTerminal`) — 연결이 끊겨도 셸은 산다
 *   찾기       = 샌드박스 안에서 찾는다(`search`/`replace`)
 *   소스 제어  = 샌드박스 안의 git(`git`)
 *
 * 서버 주소·인증·소켓은 호스트의 일이다. 데스크톱은 렌더러에서 직접 소켓을 못 열어
 * 메인 프로세스가 대신 열고, 웹은 쿠키로 바로 연다 — 그 차이가 이 경계 밖에 있다.
 */
import type * as Monaco from 'monaco-editor';

export type MonacoApi = typeof Monaco;

/** 스토리지 목록의 한 항목. `path` 는 workspace 기준(앞에 `/` 없음). */
export interface IdeFileEntry {
  path: string;
  isDir: boolean;
  size?: number | null;
  modifiedAt?: string | null;
  /** 마지막으로 바꾼 쪽의 이름(에이전트·웹·IDE·PC 이름) — 툴팁에만 쓴다. */
  originName?: string | null;
}

export interface IdeSessionInfo {
  /** 고정된 에이전트 — 보기만 한다(쓰기·터미널 없음). */
  readonly: boolean;
  /** 서버에 살아 있는 터미널(다시 열면 이어 붙인다). */
  terminals: IdeTerminalInfo[];
  user?: { id?: string; name?: string };
  limits?: { editorMaxBytes?: number; rawMaxBytes?: number };
}

export interface IdeReadResult {
  bytes: Uint8Array;
  sha: string;
  size: number;
}

export interface IdeSaveResult {
  sha: string;
  /** 색인에 반영되며 생긴 일 — 그사이 다른 기기가 같은 파일을 고쳤으면 conflicts 에 남는다. */
  conflicts?: string[];
}

export interface IdeStat {
  kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other' | 'invalid' | 'error';
  size?: number;
  mtime?: number;
  sha?: string;
}

export type IdeFsOp =
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; src: string; dst: string }
  | { op: 'copy'; src: string; dst: string }
  | { op: 'delete'; paths: string[] };

export interface IdeSearchQuery {
  query: string;
  regex?: boolean;
  case?: boolean;
  word?: boolean;
  include?: string;
  exclude?: string;
  max?: number;
}

export interface IdeSearchMatch {
  line: number;
  /** 1부터, UTF-16 단위(편집기와 같은 단위). */
  col: number;
  len: number;
  preview: string;
  /** preview 안에서 일치가 시작하는 곳(UTF-16). */
  at: number;
}

export interface IdeSearchResult {
  files: { path: string; matches: IdeSearchMatch[] }[];
  total: number;
  truncated: boolean;
}

export interface IdeReplaceResult {
  changed: { path: string; count: number }[];
  skipped: { path: string; reason: string }[];
}

export interface IdeTerminalInfo {
  id: string;
  cwd?: string;
  shell?: string;
  running?: boolean;
  attached?: number;
}

/** 터미널 소켓 프레임 — 서버 프로토콜 그대로. */
export type TerminalServerFrame =
  | { type: 'ready'; id: string; replay: boolean; cwd?: string; shell?: string }
  | { type: 'output'; data: string }
  | { type: 'synced'; seq?: number; changed?: number; deleted?: number; conflicts?: string[] }
  | { type: 'exit'; code: number; reason?: string }
  | { type: 'error'; code: string; reason: string }
  | { type: 'pong' };

export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'ping' }
  | { type: 'kill' };

export interface TerminalConnection {
  send(frame: TerminalClientFrame): void;
  close(): void;
}

export interface TerminalHandlers {
  onFrame(frame: TerminalServerFrame): void;
  /** 소켓이 닫혔다. `code` 가 4xxx 면 서버가 거절한 것이다(다시 붙어도 같다). */
  onClose(code: number, reason: string): void;
}

/** 호스트가 던지는 실패. `code` 로 화면이 다음 행동을 고른다. */
export class IdeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IdeError';
  }
}

export interface IdeHost {
  /** 에이전트 id — 편집기 모델의 주소와 저장 키에 들어간다. */
  readonly workflowId: string;
  /** 탐색기 머리에 쓰는 이름. */
  readonly agentName: string;

  session(): Promise<IdeSessionInfo>;
  listFiles(): Promise<IdeFileEntry[]>;
  /** 스토리지가 바뀌면 부른다(구독 해제 함수를 돌려준다). 없으면 IDE 가 스스로 주기적으로 본다. */
  subscribeChanges?(onChange: () => void): () => void;

  readFile(path: string): Promise<IdeReadResult>;
  /** `baseSha` = 편집기가 연 판. `''` = 새 파일, `null` = 조건 없이. 어긋나면 IdeError('changed'). */
  saveFile(path: string, bytes: Uint8Array, baseSha: string | null): Promise<IdeSaveResult>;
  stat(paths: string[]): Promise<Record<string, IdeStat>>;
  /** 그림 미리보기용 원바이트. */
  readRaw(path: string): Promise<Uint8Array>;
  fs(op: IdeFsOp): Promise<void>;

  search(query: IdeSearchQuery): Promise<IdeSearchResult>;
  replace(query: IdeSearchQuery & { replacement: string; files: string[] }): Promise<IdeReplaceResult>;

  /** 소스 제어 — `{op: 'status', repo: ''}` 등. 실패는 IdeError(code: auth·identity·not_repo…). */
  git<T = Record<string, unknown>>(args: Record<string, unknown>): Promise<T>;

  terminals(): Promise<IdeTerminalInfo[]>;
  closeTerminal(id: string): Promise<void>;
  openTerminal(
    id: string,
    options: { rows: number; cols: number; cwd?: string },
    handlers: TerminalHandlers,
  ): TerminalConnection;

  /** 편집기 — 호스트의 번들러가 Monaco 와 그 worker 를 책임진다. */
  loadMonaco(): Promise<MonacoApi>;

  /** 화면 상태(열어 둔 탭·패널 크기)를 기억할 곳. 없으면 기억하지 않는다. */
  storage?: { get(key: string): string | null; set(key: string, value: string): void };
  /** 알림(토스트). 없으면 상태 표시줄에만 남긴다. */
  notify?(kind: 'info' | 'success' | 'warning' | 'error', message: string): void;
  /** 바깥 주소 열기(원격 저장소 웹 주소·터미널 링크). */
  openExternal?(url: string): void;
  /** 파일 내려받기. */
  download?(path: string): Promise<void> | void;
  /** 클립보드 쓰기(경로 복사). 없으면 navigator.clipboard. */
  copyText?(text: string): Promise<boolean> | boolean;
}

export type ThemeKind = 'dark' | 'light';
