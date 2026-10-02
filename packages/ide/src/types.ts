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
 *   연결된 폴더 = 이 대화에 연결한 기기의 폴더(`folders`) — 탐색기 아래 따로 보이고, 편집기로
 *                연다. 이 기기에 있는 폴더만 펼쳐지고, 다른 기기에 있으면 이름만 보인다.
 *
 * 서버 주소·인증·소켓은 호스트의 일이다. 데스크톱은 렌더러에서 직접 소켓을 못 열어
 * 메인 프로세스가 대신 열고, 웹은 쿠키로 바로 연다 — 그 차이가 이 경계 밖에 있다.
 */
import type * as Monaco from 'monaco-editor';
import type { ReactNode } from 'react';

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

/** 이 대화에 연결된 폴더 한 개 — 탐색기 [연결된 폴더] 칸의 뿌리. */
export interface IdeFolderRoot {
  id: string;
  name: string;
  /** 툴팁에 쓰는 이 기기의 경로(데스크톱). */
  detail?: string;
  /** 폴더를 찾을 수 없다(지웠거나 옮겼다). */
  missing?: boolean;
  /** 이 창에서 폴더 접근을 다시 허용해야 쓸 수 있다(웹). */
  needsGrant?: boolean;
}

export interface IdeFoldersState {
  /** 이 기기에 있는 폴더 — 펼쳐 보고 편집기로 연다. */
  roots: IdeFolderRoot[];
  /** 이 대화의 폴더가 다른 기기에 있다 — 그 기기와 폴더 이름만 보인다. */
  elsewhere?: { deviceName: string; online: boolean; folders: string[] } | null;
}

/**
 * 연결된 폴더 — 호스트가 이 기기의 파일을 다룬다(데스크톱은 디스크, 웹은 브라우저가 허용한 폴더).
 * 경로는 모두 **폴더 안** 기준이다(`''` = 폴더 자체). 실패는 IdeError(code: not_found·changed·…).
 */
export interface IdeFolderSource {
  state(): Promise<IdeFoldersState>;
  /** 폴더가 바뀌면 부른다 — 연결·해제·옮김(`rootId` 없음) 또는 그 폴더 안의 파일(`rootId`). */
  subscribe(onChange: (rootId?: string) => void): () => void;
  /** 폴더 안 한 단계. 항목의 `path` 는 폴더 안 경로다. */
  list(rootId: string, dir: string): Promise<IdeFileEntry[]>;
  read(rootId: string, path: string): Promise<IdeReadResult>;
  /** `baseSha` 규칙은 `saveFile` 과 같다(`''` = 새 파일, `null` = 조건 없이). */
  save(rootId: string, path: string, bytes: Uint8Array, baseSha: string | null): Promise<IdeSaveResult>;
  stat(rootId: string, paths: string[]): Promise<Record<string, IdeStat>>;
  readRaw(rootId: string, path: string): Promise<Uint8Array>;
  fs(rootId: string, op: IdeFsOp): Promise<void>;
  /** 이 창에서 폴더 접근을 허용받는다(웹 — 사용자의 클릭 안에서 불러야 한다). */
  grant?(rootId: string): Promise<void>;
  /** 운영체제의 파일 관리자로 연다(데스크톱). */
  reveal?(rootId: string, path: string): void;
  /** 복사할 경로 — 이 기기의 절대 경로. 없으면 `<폴더 이름>/<경로>`. */
  pathOf?(rootId: string, path: string): string;
  /** [폴더 연결] 창을 연다. */
  manage?(): void;
  /** 지우면 운영체제의 휴지통으로 간다(데스크톱). 아니면 바로 지워진다. */
  trashes?: boolean;
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
  /**
   * 클립보드 읽기(터미널 붙여넣기). 읽지 못하면 null. 없으면 터미널은 키보드 붙여넣기를
   * 브라우저의 붙여넣기 사건에 맡기고, 메뉴의 [붙여넣기] 는 navigator.clipboard 로 읽는다.
   */
  readText?(): Promise<string | null> | string | null;
  /** 이 대화에 연결된 폴더. 없으면 탐색기에 [연결된 폴더] 칸이 없다. */
  folders?: IdeFolderSource;
  /**
   * 편집기 대신 **그려서 보여 줄** 파일 — 문서·PDF·소리·영상, 그리고 글이지만 그려 보는 쪽이 나은 md·csv.
   * 없으면 그런 파일은 예전처럼 "텍스트가 아니라 열지 않았다" 로 남는다.
   */
  preview?: IdePreview;
}

/**
 * 어떻게 보여 주는가.
 *
 *   view    편집기로 열지 않고 그린다(docx·pptx·xlsx·hwp·pdf·소리·영상). 탭 하나가 통째로 미리보기다.
 *   toggle  편집기로 열되 [미리보기] 로 그려 볼 수 있다(md·csv). 처음에는 그린 쪽을 보여 준다.
 */
export type IdePreviewMode = 'view' | 'toggle';

/** 미리보기 한 장에 필요한 것 — 바이트를 어디서 읽는지는 IDE 가 정한다(스토리지든 연결된 폴더든). */
export interface IdePreviewRequest {
  /** workspace 기준 경로(연결된 폴더면 그 표식 경로). */
  path: string;
  /** 파일 이름. */
  name: string;
  /** 연결된 폴더(이 기기)의 파일이다 — 서버가 그려 주는 문서 렌더가 없다. */
  local: boolean;
  /** 원바이트 — IDE 가 고른 길(샌드박스·연결된 폴더)로 읽는다. */
  readRaw(): Promise<Uint8Array>;
  /** toggle 에서 편집기의 **지금 글**(저장 전 내용 포함). 없으면 바이트를 읽어 그린다. */
  text?: string;
  /** 파일이 바뀌면 달라진다 — 다시 그리는 열쇠. */
  version: string;
  theme: ThemeKind;
  /** 내려받기(없으면 단추를 숨긴다). */
  download?: () => void;
}

/** 호스트가 가진 미리보기 부품을 IDE 에 꽂는 자리 — 데스크톱·웹의 [파일 저장소] 와 같은 렌더러를 쓴다. */
export interface IdePreview {
  mode(path: string): IdePreviewMode | null;
  render(req: IdePreviewRequest): ReactNode;
}

export type ThemeKind = 'dark' | 'light';
