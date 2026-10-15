/**
 * 이 대화에 연결한 폴더의 파일 — IDE 탐색기 [연결된 폴더] 와 편집기가 쓴다.
 *
 * 경로는 모두 **폴더 안** 기준(`/` 구분, `''` = 폴더 자체)이고, 디스크에 닿기 전에 폴더 밖으로
 * 나가지 않는지 확인한다(심볼릭 링크를 따라가도 폴더 밖이면 거부 — 에이전트의 폴더 도구와 같은
 * 경계). 저장은 연 판(sha)을 조건으로 건다. 지우면 운영체제의 휴지통으로 간다.
 *
 * Electron 을 모른다 — 휴지통·파일 관리자는 호출부가 넣어 준다(단위 테스트가 그대로 돈다).
 */
import { createHash } from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { resolveWithinRootsReal } from '@dex/engine/local-tools';

/** 편집기로 여는 파일의 상한 — 넘으면 too_large(편집기가 "너무 크다" 를 보인다). */
export const FOLDER_READ_MAX = 10 * 1024 * 1024;
/** 그림 미리보기의 상한. */
export const FOLDER_RAW_MAX = 50 * 1024 * 1024;
/** 한 폴더에서 보여 주는 항목 수. */
export const FOLDER_LIST_MAX = 5000;
/** VS Code 가 기본으로 감추는 것과 같다. */
const HIDDEN = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db']);

export class FolderFsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FolderFsError';
  }
}

export interface FolderFsDeps {
  /** 지우기 — 휴지통으로. 없으면 바로 지운다. */
  trash?(abs: string): Promise<void>;
  /** 파일 관리자로 보기. */
  reveal?(abs: string): void;
}

export interface FolderEntry {
  path: string;
  isDir: boolean;
  size?: number | null;
  modifiedAt?: string | null;
}

export interface FolderStat {
  kind: 'file' | 'dir' | 'missing' | 'other';
  size?: number;
  mtime?: number;
  sha?: string;
}

function cleanRel(rel: unknown): string {
  const parts: string[] = [];
  for (const seg of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new FolderFsError('forbidden', '폴더 밖의 경로입니다');
    parts.push(seg);
  }
  return parts.join('/');
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 폴더 안의 절대 경로 — 밖이면 던진다. */
async function inside(root: string, rel: string): Promise<string> {
  const r = cleanRel(rel);
  const target = r ? join(root, ...r.split('/')) : root;
  const abs = await resolveWithinRootsReal(target, [root]);
  if (!abs) throw new FolderFsError('forbidden', '연결한 폴더 밖의 경로입니다');
  return abs;
}

const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');

function notFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function statOrNull(abs: string) {
  try {
    return await fsp.stat(abs);
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function currentSha(abs: string): Promise<string> {
  const st = await statOrNull(abs);
  if (!st) return '';
  if (!st.isFile()) throw new FolderFsError('not_file', '파일이 아닙니다');
  if (st.size > FOLDER_READ_MAX) return `mtime:${st.mtimeMs}:${st.size}`;
  return sha1(await fsp.readFile(abs));
}

export async function listFolder(root: string, dir: string): Promise<FolderEntry[]> {
  const rel = cleanRel(dir);
  const abs = await inside(root, rel);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (notFound(err)) throw new FolderFsError('not_found', '폴더가 없습니다');
    throw err;
  }
  const shown = entries.filter((e) => !HIDDEN.has(e.name)).slice(0, FOLDER_LIST_MAX);
  return Promise.all(
    shown.map(async (e): Promise<FolderEntry> => {
      const path = joinRel(rel, e.name);
      try {
        // 링크는 가리키는 것을 본다 — 폴더를 가리키면 폴더로 펼친다(밖이면 펼칠 때 거부된다).
        const st = await fsp.stat(join(abs, e.name));
        return { path, isDir: st.isDirectory(), size: st.isFile() ? st.size : null, modifiedAt: st.mtime.toISOString() };
      } catch {
        return { path, isDir: e.isDirectory() };
      }
    }),
  );
}

export async function readFolderFile(root: string, path: string): Promise<{ bytes: Uint8Array; sha: string; size: number }> {
  const abs = await inside(root, path);
  const st = await statOrNull(abs);
  if (!st) throw new FolderFsError('not_found', '파일이 없습니다');
  if (!st.isFile()) throw new FolderFsError('not_file', '파일이 아닙니다');
  if (st.size > FOLDER_READ_MAX) throw new FolderFsError('too_large', '파일이 너무 큽니다', { size: st.size });
  const bytes = await fsp.readFile(abs);
  return { bytes, sha: sha1(bytes), size: bytes.length };
}

export async function saveFolderFile(
  root: string,
  path: string,
  bytes: Uint8Array,
  baseSha: string | null,
): Promise<{ sha: string }> {
  const rel = cleanRel(path);
  if (!rel) throw new FolderFsError('forbidden', '폴더 자체에는 쓸 수 없습니다');
  const abs = await inside(root, rel);
  if (baseSha !== null) {
    const cur = await currentSha(abs);
    if (cur !== baseSha) throw new FolderFsError('changed', '그사이 파일이 바뀌었습니다', { current_sha: cur });
  }
  await fsp.mkdir(await inside(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
  await fsp.writeFile(abs, bytes);
  return { sha: sha1(bytes) };
}

export async function statFolderFiles(root: string, paths: string[]): Promise<Record<string, FolderStat>> {
  const out: Record<string, FolderStat> = {};
  for (const path of paths) {
    try {
      const abs = await inside(root, path);
      const st = await statOrNull(abs);
      if (!st) out[path] = { kind: 'missing' };
      else if (st.isDirectory()) out[path] = { kind: 'dir', mtime: st.mtimeMs };
      else if (!st.isFile()) out[path] = { kind: 'other' };
      else out[path] = { kind: 'file', size: st.size, mtime: st.mtimeMs, sha: await currentSha(abs) };
    } catch {
      out[path] = { kind: 'missing' };
    }
  }
  return out;
}

export async function readFolderRaw(root: string, path: string): Promise<Uint8Array> {
  const abs = await inside(root, path);
  const st = await statOrNull(abs);
  if (!st || !st.isFile()) throw new FolderFsError('not_found', '파일이 없습니다');
  if (st.size > FOLDER_RAW_MAX) throw new FolderFsError('too_large', '파일이 너무 큽니다', { size: st.size });
  return fsp.readFile(abs);
}

export type FolderFsOp =
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; src: string; dst: string }
  | { op: 'copy'; src: string; dst: string }
  | { op: 'delete'; paths: string[] };

export async function runFolderOp(root: string, op: FolderFsOp, deps: FolderFsDeps = {}): Promise<void> {
  if (op.op === 'mkdir') {
    await fsp.mkdir(await inside(root, op.path), { recursive: true });
    return;
  }
  if (op.op === 'rename' || op.op === 'copy') {
    if (!cleanRel(op.src) || !cleanRel(op.dst)) throw new FolderFsError('forbidden', '폴더 자체는 옮길 수 없습니다');
    const src = await inside(root, op.src);
    const dst = await inside(root, op.dst);
    if (await statOrNull(dst)) throw new FolderFsError('exists', '같은 이름이 이미 있습니다');
    if (op.op === 'rename') await fsp.rename(src, dst);
    else await fsp.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  for (const path of op.paths) {
    if (!cleanRel(path)) throw new FolderFsError('forbidden', '연결한 폴더 자체는 여기서 지울 수 없습니다');
    const abs = await inside(root, path);
    if (deps.trash) await deps.trash(abs);
    else await fsp.rm(abs, { recursive: true, force: true });
  }
}

/** 한 번의 IPC 호출 — 렌더러의 IDE 호스트가 부른다. */
export async function folderFsCall(
  root: string,
  op: string,
  args: Record<string, unknown>,
  deps: FolderFsDeps = {},
): Promise<unknown> {
  switch (op) {
    case 'list':
      return listFolder(root, String(args.dir ?? ''));
    case 'read':
      return readFolderFile(root, String(args.path ?? ''));
    case 'save':
      return saveFolderFile(
        root,
        String(args.path ?? ''),
        args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(),
        typeof args.baseSha === 'string' ? args.baseSha : null,
      );
    case 'stat':
      return statFolderFiles(root, Array.isArray(args.paths) ? args.paths.map(String) : []);
    case 'raw':
      return readFolderRaw(root, String(args.path ?? ''));
    case 'fs':
      return runFolderOp(root, args.op as FolderFsOp, deps);
    case 'reveal': {
      const abs = await inside(root, String(args.path ?? ''));
      deps.reveal?.(abs);
      return null;
    }
    default:
      throw new FolderFsError('bad_request', `알 수 없는 작업: ${op}`);
  }
}
