/**
 * 모바일 도구 — 에이전트가 이 **휴대폰**을 조작하는 도구 카탈로그.
 *
 * 데스크톱의 LocalTools 와 같은 레일(connector-mcp hello/mcp_call)을 타되,
 * 서버 네임스페이스를 'mobile' 로 분리한다 — 에이전트에게는
 * `mcp_mobile_<Tool>` 로 보이며, 데스크톱의 `mcp_local_*` 과 이름이 충돌하지
 * 않는다.
 *
 * 파일 도구는 **그 대화에 연결된 폴더** 안에서만 돈다. 사용자가 채팅 위
 * [폴더 연결]로 고른 휴대폰의 폴더(안드로이드 문서 제공자 트리, iOS 폴더)이고,
 * 에이전트에게는 `/<폴더 이름>/…` 가상 경로로 보인다. 폴더가 없는 대화에서는
 * 파일 도구를 거부한다. 나머지 도구(알림·클립보드·위치 등)는 설정의 도구
 * 그룹이 정한다.
 *
 * 결과 계약은 데스크톱 LocalToolResult 와 동일:
 *   { content: [{type:'text', text}], isError? } — mcp_result.result 로 실려
 * 에이전트에게 그대로 간다.
 */
import {
  COPY_FROM_WORKSPACE_TOOL,
  COPY_TO_WORKSPACE_TOOL,
  NO_DOWNLOAD_MESSAGE,
  WORKSPACE_COPY_LIMITS,
  copyTargetDir,
  copyToWorkspaceResult,
  deviceTimeText,
  workspaceCopySchemas,
  workspaceDownloadOf,
  type CopiedFile,
  type SkippedFile,
} from '@dex/protocol';
import {
  NO_FOLDER_MESSAGE,
  pathSegments,
  resolveFolderPath,
  virtualRoot,
  type MobileFolder,
} from './mobile-folders';

export const MOBILE_SERVER = 'mobile';

/**
 * 도구 그룹 — 설정의 [도구 켜기] 단위이자 OS 권한 승인 단위.
 * 그룹을 켜는 순간 해당 OS 권한을 실제로 요청하고(승인 구조), 꺼진 그룹의
 * 도구는 카탈로그에서 빠지며 호출도 거부된다.
 *
 * 파일은 그룹이 아니다 — 대화마다 채팅 위 [폴더 연결]로 연결한 폴더가 범위다.
 */
export type ToolGroup = 'notify' | 'clipboard' | 'device' | 'camera' | 'location' | 'actions';

export const TOOL_GROUPS: Array<{
  id: ToolGroup;
  label: string;
  description: string;
  /** 켤 때 요청할 OS 권한 (없으면 승인 불필요). */
  permission?: 'notifications' | 'camera' | 'location';
}> = [
  { id: 'notify', label: '알림', description: '휴대폰 알림 표시', permission: 'notifications' },
  { id: 'clipboard', label: '클립보드', description: '클립보드 읽기·쓰기' },
  { id: 'device', label: '기기 정보', description: '모델·배터리·네트워크 상태 조회' },
  { id: 'camera', label: '카메라', description: '사진을 찍어 연결한 폴더에 저장', permission: 'camera' },
  { id: 'location', label: '위치', description: '현재 위치(GPS) 조회', permission: 'location' },
  { id: 'actions', label: '동작', description: '공유 시트·URL 열기·진동' },
];

export const TOOL_TO_GROUP: Record<string, ToolGroup> = {
  Notify: 'notify',
  Clipboard: 'clipboard',
  DeviceInfo: 'device',
  TakePhoto: 'camera',
  Location: 'location',
  Share: 'actions',
  OpenUrl: 'actions',
  Vibrate: 'actions',
};

/** 연결한 폴더 안에서만 도는 도구. 서버도 같은 목록으로 이번 턴의 표면을 정한다. */
export const FOLDER_TOOLS: ReadonlySet<string> = new Set([
  'ReadFile',
  'WriteFile',
  'ListDir',
  'DeleteFile',
  'Search',
  'OpenFile',
  'TakePhoto',
  COPY_TO_WORKSPACE_TOOL,
  COPY_FROM_WORKSPACE_TOOL,
]);

export type PermissionState = 'granted' | 'denied' | 'prompt';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** 서버가 읽는 기계용 결과(복사 도구의 `workspaceFiles` — 서버가 그 턴의 sandbox 에 바로 들인다). */
  structuredContent?: Record<string, unknown>;
}

export interface ToolAdvert {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 기기 기능 포트 — rn-port.ts 가 구현하고, 테스트는 인메모리 가짜로 구현한다. */
export interface DevicePort {
  notify(title: string, body: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  deviceInfo(): Promise<Record<string, unknown>>;
  batteryInfo(): Promise<{ level?: number; isCharging?: boolean }>;
  networkStatus(): Promise<{ connected: boolean; connectionType: string }>;
  share(title: string, text: string, url?: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  vibrate(): Promise<void>;
  /** 카메라 촬영 → 임시 파일(file://) URI. 취소하면 던진다. */
  capturePhoto(): Promise<string>;
  /** 이 기기의 로컬 파일을 다른 앱으로 연다(시스템 열기·공유 시트). */
  openFileWith(localUri: string): Promise<void>;
  /** 현재 위치 (GPS). */
  location(): Promise<{ latitude: number; longitude: number; accuracy?: number }>;
  /** OS 권한 요청 — [도구 켜기]가 부른다. */
  requestPermission(kind: 'notifications' | 'camera' | 'location'): Promise<PermissionState>;
}

export interface FolderEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** 수정 시각(ms). 모르면 없다. "오늘 받은 파일" 을 고를 근거다. */
  modified?: number;
}

/**
 * 이 호출의 대화 작업 공간과 주고받는 길 — 호출마다 그 대화(context)로 묶여 온다.
 * 폰은 파일을 경로로 흘려보낸다(RN 의 Blob 은 바이트로 만들 수 없다).
 */
export interface WorkspaceTransfer {
  /** 폰의 로컬 파일(file://)을 이 대화의 첨부 폴더(하위 `relDir`)로 올린다. 같은 이름은 덮어쓴다. */
  upload(localUri: string, name: string, relDir: string): Promise<{ path: string; size: number; sha256?: string }>;
  /** 서버가 내어 준 임시 파일을 로컬 파일(file://)로 받는다. */
  download(url: string, token: string | undefined, name: string): Promise<string>;
  /** 다 쓴 로컬 사본을 지운다. 실패해도 조용히. */
  discard(localUri: string): Promise<void>;
}

/** 연결한 폴더의 파일 작업 — folder-fs.ts 가 플랫폼별로 구현한다. 경로는 폴더 기준 상대 경로. */
export interface FolderFs {
  list(folder: MobileFolder, rel: string): Promise<FolderEntry[]>;
  stat(folder: MobileFolder, rel: string): Promise<{ exists: boolean; isDir: boolean; size: number }>;
  readText(
    folder: MobileFolder,
    rel: string,
    maxBytes: number,
  ): Promise<{ text: string; size: number; truncated: boolean }>;
  writeText(folder: MobileFolder, rel: string, content: string, append: boolean): Promise<void>;
  /** 로컬 파일(카메라 촬영본)을 폴더 안으로 복사한다. */
  importFile(folder: MobileFolder, rel: string, sourceUri: string): Promise<void>;
  remove(folder: MobileFolder, rel: string): Promise<void>;
  /** 다른 앱에 넘길 수 있는 로컬 사본(file://)을 만든다. */
  exportFile(folder: MobileFolder, rel: string): Promise<string>;
}

/** 한 호출이 닿을 수 있는 범위 — 그 대화에 연결된 폴더. */
export interface FolderScope {
  folders: MobileFolder[];
  fs: FolderFs;
  /** 다른 화면(웹·PC)에서 보낸 턴의 호출 — 그 화면의 이름. */
  remoteFrom?: string;
  /** 이 호출의 대화 작업 공간(복사 도구). 호출 문맥에 에이전트·대화가 없으면 없다. */
  workspace?: WorkspaceTransfer;
}

/** 휴대폰 앞에 사람이 있어야 뜻이 있는 폴더 도구 — 다른 화면에서 온 요청에서는 쓰지 않는다. */
export const PRESENCE_TOOLS: ReadonlySet<string> = new Set(['OpenFile', 'TakePhoto']);

const READ_CAP = 200_000;
const SEARCH_FILE_CAP = 1_000_000;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_FILES = 400;
const LIST_CAP = 500;
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tar',
  '7z', 'rar', 'mp3', 'mp4', 'mov', 'm4a', 'wav', 'ogg', 'aac', 'apk', 'ipa', 'so', 'dex', 'bin',
  'woff', 'woff2', 'ttf', 'otf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx',
]);

const str = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc });
const PATH_HELP =
  'Virtual path /<connected folder name>/sub/path. Relative paths start in the first connected folder.';
const FOLDER_NOTE =
  " Works only inside the phone folders the user connected to this conversation (the user's phone, not your server sandbox).";

/** 카탈로그 — hello 프레임에 그대로 실린다. 스키마는 JSON Schema.
 *  enabled 를 주면 켜진 그룹의 도구만 광고한다 ([도구 켜기] 단위 노출).
 *  폴더 도구는 늘 광고한다 — 이번 턴에 보일지는 서버가 그 대화의 폴더로 정하고,
 *  호출을 허락할지는 이 기기가 호출마다 그 대화의 폴더로 다시 정한다. */
export function advertiseMobileTools(enabled?: Partial<Record<ToolGroup, boolean>>): ToolAdvert[] {
  const t = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): ToolAdvert => ({
    server: MOBILE_SERVER,
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  });
  const all: ToolAdvert[] = [
    t('ReadFile', 'Read a text file on the phone.' + FOLDER_NOTE, {
      path: str(PATH_HELP),
      maxBytes: { type: 'number', description: `Max bytes to return (default/cap ${READ_CAP}).` },
    }, ['path']),
    t('WriteFile', 'Write or append to a text file on the phone. Creates missing parent folders.' + FOLDER_NOTE, {
      path: str(PATH_HELP),
      content: str('Text to write.'),
      append: { type: 'boolean', description: 'true appends to the end (default false = overwrite).' },
    }, ['path', 'content']),
    t('ListDir', 'List a folder on the phone (type, size, modified time in the phone\'s local time, name).' + FOLDER_NOTE, {
      path: str(`${PATH_HELP} Empty = the first connected folder.`),
    }),
    t('DeleteFile', 'Delete a file or folder on the phone. A connected folder itself cannot be deleted.' + FOLDER_NOTE, {
      path: str(PATH_HELP),
    }, ['path']),
    t('Search', 'Search text files under a folder on the phone for a literal substring. Returns path:line: match.' + FOLDER_NOTE, {
      query: str('Literal substring to find.'),
      path: str(`${PATH_HELP} Empty = the first connected folder.`),
      maxResults: { type: 'number', description: 'Max matches (default 100, cap 500).' },
    }, ['query']),
    t('OpenFile', 'Open a file from the phone with another app (shows the system open/share sheet to the user).' + FOLDER_NOTE, {
      path: str(PATH_HELP),
    }, ['path']),
    t('TakePhoto', 'Take a photo with the phone camera and save it as a JPEG in a connected folder.' + FOLDER_NOTE, {
      path: str(`${PATH_HELP} Default: photo-<time>.jpg in the first connected folder.`),
    }),
    ...workspaceCopySchemas('phone').map((schema) => ({ server: MOBILE_SERVER, ...schema })),
    t('Notify', '휴대폰에 로컬 알림을 표시합니다.', {
      title: str('알림 제목'),
      body: str('알림 내용'),
    }, ['title', 'body']),
    t('Clipboard', '휴대폰 클립보드를 읽거나 씁니다.', {
      action: { type: 'string', enum: ['read', 'write'], description: 'read 또는 write' },
      text: str('write 일 때 넣을 텍스트'),
    }, ['action']),
    t('DeviceInfo', '휴대폰 기기 정보(모델/OS/배터리/네트워크)를 조회합니다.', {}),
    t('Share', '공유 시트를 엽니다 (다른 앱으로 텍스트/링크 전달).', {
      title: str('공유 제목'),
      text: str('공유할 텍스트'),
      url: str('공유할 링크 (선택)'),
    }, ['text']),
    t('OpenUrl', '휴대폰 브라우저로 URL 을 엽니다.', {
      url: str('열 주소 (http/https)'),
    }, ['url']),
    t('Vibrate', '휴대폰을 짧게 진동시킵니다.', {}),
    t('Location', '휴대폰의 현재 위치(위도/경도)를 조회합니다.', {}),
  ];
  if (!enabled) return all;
  return all.filter((tool) => {
    const group = TOOL_TO_GROUP[tool.name];
    return !group || enabled[group] !== false;
  });
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function joinRel(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

async function searchFolder(
  fs: FolderFs,
  folder: MobileFolder,
  startRel: string,
  query: string,
  maxResults: number,
): Promise<string[]> {
  const hits: string[] = [];
  let files = 0;
  const queue: Array<{ rel: string; depth: number }> = [{ rel: startRel, depth: 0 }];
  while (queue.length && hits.length < maxResults && files < SEARCH_MAX_FILES) {
    const { rel, depth } = queue.shift()!;
    let entries: FolderEntry[];
    try {
      entries = await fs.list(folder, rel);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hits.length >= maxResults || files >= SEARCH_MAX_FILES) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = joinRel(rel, entry.name);
      if (entry.isDir) {
        if (depth < SEARCH_MAX_DEPTH) queue.push({ rel: child, depth: depth + 1 });
        continue;
      }
      if (entry.size > SEARCH_FILE_CAP || BINARY_EXT.has(extensionOf(entry.name))) continue;
      files += 1;
      let text: string;
      try {
        text = (await fs.readText(folder, child, SEARCH_FILE_CAP)).text;
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(query)) continue;
        hits.push(`${virtualRoot(folder)}/${child}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= maxResults) break;
      }
    }
  }
  return hits;
}

async function callFolderTool(
  port: DevicePort,
  tool: string,
  args: Record<string, unknown>,
  scope: FolderScope,
): Promise<ToolResult> {
  const { folders, fs } = scope;
  switch (tool) {
    case 'ReadFile': {
      const at = resolveFolderPath(folders, args.path);
      if (!at.rel) return err('path 가 필요합니다.');
      const maxBytes = Math.max(1, Math.min(READ_CAP, Number(args.maxBytes) || READ_CAP));
      const r = await fs.readText(at.folder, at.rel, maxBytes);
      const suffix = r.truncated ? `\n…(truncated, ${r.size} bytes total)` : '';
      return ok((r.text || '(empty file)') + suffix);
    }
    case 'WriteFile': {
      const at = resolveFolderPath(folders, args.path);
      if (!at.rel) return err('path 가 필요합니다.');
      const content = String(args.content ?? '');
      await fs.writeText(at.folder, at.rel, content, args.append === true);
      return ok(`${args.append === true ? '이어썼습니다' : '저장했습니다'}: ${at.display}`);
    }
    case 'ListDir': {
      const at = resolveFolderPath(folders, args.path ?? '');
      const entries = await fs.list(at.folder, at.rel);
      if (entries.length === 0) return ok(`(비어 있음) ${at.display}`);
      // 수정 시각을 함께 — "오늘 받은 파일" 같은 요청은 이것 없이는 고를 수 없다(2026-10-02 사용자 실측).
      const rows = entries.slice(0, LIST_CAP).map((entry) => {
        const when = deviceTimeText(entry.modified);
        return entry.isDir
          ? `d ${entry.name}/${when ? `  (modified ${when})` : ''}`
          : `- ${entry.name} (${entry.size}B${when ? `, modified ${when}` : ''})`;
      });
      const more = entries.length > LIST_CAP ? `\n…(${entries.length} entries, first ${LIST_CAP} shown)` : '';
      return ok(`${at.display}  (times are the phone's local time)\n${rows.join('\n')}${more}`);
    }
    case 'DeleteFile': {
      const at = resolveFolderPath(folders, args.path);
      if (!at.rel) return err('연결한 폴더 자체는 지울 수 없습니다.');
      await fs.remove(at.folder, at.rel);
      return ok(`삭제했습니다: ${at.display}`);
    }
    case 'Search': {
      const query = String(args.query ?? '');
      if (!query) return err('query 가 필요합니다.');
      const at = resolveFolderPath(folders, args.path ?? '');
      const maxResults = Math.max(1, Math.min(500, Number(args.maxResults) || 100));
      const hits = await searchFolder(fs, at.folder, at.rel, query, maxResults);
      return ok(hits.length ? hits.join('\n') : `'${query}' 를 찾지 못했습니다 (${at.display}).`);
    }
    case 'OpenFile': {
      const at = resolveFolderPath(folders, args.path);
      if (!at.rel) return err('path 가 필요합니다.');
      const local = await fs.exportFile(at.folder, at.rel);
      await port.openFileWith(local);
      return ok(`열기 창을 띄웠습니다: ${at.display}`);
    }
    case 'TakePhoto': {
      const raw = String(args.path ?? args.fileName ?? '').trim();
      const at = resolveFolderPath(folders, raw || `photo-${Date.now()}.jpg`);
      const rel = /\.(jpe?g)$/i.test(at.rel) ? at.rel : `${at.rel || `photo-${Date.now()}`}.jpg`;
      const shot = await port.capturePhoto();
      await fs.importFile(at.folder, rel, shot);
      return ok(`사진을 저장했습니다: ${virtualRoot(at.folder)}/${rel}`);
    }
    case COPY_TO_WORKSPACE_TOOL:
      return copyToWorkspace(args, scope);
    case COPY_FROM_WORKSPACE_TOOL:
      return copyFromWorkspace(args, scope);
    default:
      return err(`알 수 없는 도구: ${tool}`);
  }
}

/**
 * 폰의 파일·폴더 → 이 대화의 작업 공간. 폴더는 구조째(숨김은 건너뛴다). 파일은 앱 캐시에 사본을 만들어
 * 경로로 흘려보낸 뒤 지운다 — 문서 제공자 트리의 파일은 다른 앱이 직접 읽을 수 없다.
 */
async function copyToWorkspace(args: Record<string, unknown>, scope: FolderScope): Promise<ToolResult> {
  const transfer = scope.workspace;
  if (!transfer) return err('어느 대화의 작업 공간인지 알 수 없어 옮기지 못했습니다.');
  const { folders, fs } = scope;
  const inputs = (Array.isArray(args.paths) ? args.paths : [args.paths ?? args.path])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  if (!inputs.length) return err('paths 가 필요합니다.');

  const limits = WORKSPACE_COPY_LIMITS;
  const skipped: SkippedFile[] = [];
  const plan: Array<{ folder: MobileFolder; rel: string; relDir: string; size: number }> = [];
  let planned = 0;
  const show = (folder: MobileFolder, rel: string): string => `${virtualRoot(folder)}/${rel}`;
  const take = (folder: MobileFolder, rel: string, relDir: string, size: number): void => {
    const source = show(folder, rel);
    if (size > limits.maxFileBytes) skipped.push({ source, reason: `larger than ${limits.maxFileBytes / (1024 * 1024)}MB` });
    else if (plan.length >= limits.maxFiles) skipped.push({ source, reason: `more than ${limits.maxFiles} files in one copy` });
    else if (planned + size > limits.maxTotalBytes) skipped.push({ source, reason: 'total size limit for one copy reached' });
    else {
      plan.push({ folder, rel, relDir, size });
      planned += size;
    }
  };
  const walk = async (folder: MobileFolder, rootRel: string, rootName: string, rel: string, depth: number): Promise<void> => {
    let entries: FolderEntry[];
    try {
      entries = await fs.list(folder, rel);
    } catch (e) {
      skipped.push({ source: show(folder, rel), reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const child = joinRel(rel, entry.name);
      if (entry.isDir) {
        if (depth >= limits.maxDepth) skipped.push({ source: show(folder, child), reason: 'folder nested too deep' });
        else await walk(folder, rootRel, rootName, child, depth + 1);
      } else {
        const inside = rootRel ? child.slice(rootRel.length + 1) : child;
        take(folder, child, copyTargetDir(rootName, inside), entry.size);
      }
    }
  };
  for (const input of inputs) {
    let at: ReturnType<typeof resolveFolderPath>;
    try {
      at = resolveFolderPath(folders, input);
    } catch (e) {
      skipped.push({ source: input, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    try {
      const st = await fs.stat(at.folder, at.rel);
      if (!st.exists) skipped.push({ source: at.display, reason: 'not found' });
      else if (st.isDir) await walk(at.folder, at.rel, pathSegments(at.rel).at(-1) ?? at.folder.name, at.rel, 0);
      else take(at.folder, at.rel, '', st.size);
    } catch (e) {
      skipped.push({ source: at.display, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const copied: CopiedFile[] = [];
  for (const item of plan) {
    const source = show(item.folder, item.rel);
    let local = '';
    try {
      local = await fs.exportFile(item.folder, item.rel);
      const name = pathSegments(item.rel).at(-1) ?? 'file';
      const res = await transfer.upload(local, name, item.relDir);
      copied.push({ source, path: res.path, size: res.size || item.size, ...(res.sha256 ? { sha256: res.sha256 } : {}) });
    } catch (e) {
      skipped.push({ source, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      if (local) await transfer.discard(local);
    }
  }
  return copyToWorkspaceResult(copied, skipped);
}

/** 서버가 실어 준 작업 공간 파일 → 연결한 폴더. 있는 파일은 덮어쓰라고 할 때만 바꾼다. */
async function copyFromWorkspace(args: Record<string, unknown>, scope: FolderScope): Promise<ToolResult> {
  const transfer = scope.workspace;
  if (!transfer) return err('어느 대화의 작업 공간인지 알 수 없어 받지 못했습니다.');
  const download = workspaceDownloadOf(args);
  if (!download) return err(NO_DOWNLOAD_MESSAGE);
  const raw = String(args.path ?? '').trim();
  const at = resolveFolderPath(scope.folders, raw);
  let rel = at.rel;
  const here = rel ? await scope.fs.stat(at.folder, rel) : { exists: true, isDir: true, size: 0 };
  if ((here.exists && here.isDir) || /[\\/]$/.test(raw)) rel = joinRel(rel, download.name);
  const shown = `${virtualRoot(at.folder)}/${rel}`;
  const target = await scope.fs.stat(at.folder, rel);
  if (target.exists && target.isDir) return err(`${shown} is a folder.`);
  if (target.exists && args.overwrite !== true) {
    return err(`${shown} already exists. Pass overwrite=true to replace it, or choose another path.`);
  }
  const local = await transfer.download(download.url, download.token, download.name);
  try {
    if (target.exists) await scope.fs.remove(at.folder, rel);
    await scope.fs.importFile(at.folder, rel, local);
  } finally {
    await transfer.discard(local);
  }
  return ok(`Saved ${download.name} to ${shown}.`);
}

export async function callMobileTool(
  port: DevicePort,
  tool: string,
  rawArgs: unknown,
  enabled?: Partial<Record<ToolGroup, boolean>>,
  scope?: FolderScope,
): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  // 꺼진 그룹의 도구는 (카탈로그 재광고 전 레이스로 호출이 와도) 거부한다.
  const group = TOOL_TO_GROUP[tool];
  if (enabled && group && enabled[group] === false) {
    return err(`이 도구는 사용자가 설정에서 꺼 두었습니다 (${group}).`);
  }
  try {
    if (FOLDER_TOOLS.has(tool)) {
      // 폴더 도구는 그 대화에 연결된 폴더 안에서만 — 없으면 이유와 방법을 알린다.
      if (!scope || !scope.folders.length) return err(NO_FOLDER_MESSAGE);
      if (scope.remoteFrom !== undefined && PRESENCE_TOOLS.has(tool)) {
        return err(
          `${tool} 은(는) 이 휴대폰에서 보낸 요청에서만 쓸 수 있습니다 — 이 요청은 ${scope.remoteFrom || '다른 기기'}에서 왔습니다.`,
        );
      }
      return await callFolderTool(port, tool, args, scope);
    }
    switch (tool) {
      case 'Notify': {
        await port.notify(String(args.title ?? '알림'), String(args.body ?? ''));
        return ok('알림을 표시했습니다.');
      }
      case 'Clipboard': {
        if (args.action === 'read') return ok(await port.clipboardRead());
        if (args.action === 'write') {
          await port.clipboardWrite(String(args.text ?? ''));
          return ok('클립보드에 복사했습니다.');
        }
        return err("action 은 'read' 또는 'write' 여야 합니다.");
      }
      case 'DeviceInfo': {
        const [info, battery, net] = await Promise.all([
          port.deviceInfo(),
          port.batteryInfo(),
          port.networkStatus(),
        ]);
        return ok(JSON.stringify({ ...info, battery, network: net }, null, 2));
      }
      case 'Share': {
        await port.share(String(args.title ?? ''), String(args.text ?? ''),
          args.url ? String(args.url) : undefined);
        return ok('공유 시트를 열었습니다.');
      }
      case 'OpenUrl': {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//.test(url)) return err('http/https URL 만 열 수 있습니다.');
        await port.openUrl(url);
        return ok(`열었습니다: ${url}`);
      }
      case 'Vibrate': {
        await port.vibrate();
        return ok('진동했습니다.');
      }
      case 'Location': {
        const pos = await port.location();
        return ok(
          JSON.stringify(
            {
              latitude: pos.latitude,
              longitude: pos.longitude,
              accuracy_m: pos.accuracy ?? null,
              maps: `https://maps.google.com/?q=${pos.latitude},${pos.longitude}`,
            },
            null,
            2,
          ),
        );
      }
      default:
        return err(`알 수 없는 도구: ${tool}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
