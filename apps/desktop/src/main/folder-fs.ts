/**
 * IDE folder operations through the same pinned native boundary as local tools.
 * File data and mutations are handle-relative. Only `reveal` returns a pathname
 * to the OS UI, and deleted entries are quarantined into the private stage
 * before a trusted path is handed to the OS trash service.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { platform } from 'node:process';
import {
  RootGrant,
  resolveRootedPath,
  type RootedResolvedPath,
  type RootedSource,
} from '@dex/engine/rooted-fs';
import { atomicWorkspaceWrite } from '@dex/engine/atomic-workspace-write';

export const FOLDER_READ_MAX = 10 * 1024 * 1024;
export const FOLDER_RAW_MAX = 50 * 1024 * 1024;
export const FOLDER_LIST_MAX = 5000;
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
  /** Receives only a verified path inside the private native stage. */
  trash?(trustedStagePath: string): Promise<void>;
  /** UI-only pathname handoff; no file bytes or mutations use this path. */
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

const grants = new Map<string, Map<string, RootGrant>>();
const grantScope = new AsyncLocalStorage<string>();
const DEFAULT_SCOPE = '';

function grantFor(root: string): RootGrant {
  const key = resolve(root);
  const scope = grantScope.getStore() ?? DEFAULT_SCOPE;
  let byScope = grants.get(key);
  if (!byScope) {
    byScope = new Map();
    grants.set(key, byScope);
  }
  let grant = byScope.get(scope);
  if (!grant) {
    grant = new RootGrant(key);
    byScope.set(scope, grant);
  }
  return grant;
}

/** Revoke a folder object capability when the host removes or re-grants it. */
export function closeFolderFsRoot(root: string, scopeKey?: string): void {
  const key = resolve(root);
  const byScope = grants.get(key);
  if (!byScope) return;
  if (scopeKey === undefined) {
    for (const grant of byScope.values()) grant.close();
    grants.delete(key);
  } else {
    byScope.get(scopeKey)?.close();
    byScope.delete(scopeKey);
    if (byScope.size === 0) grants.delete(key);
  }
}

/** Close every IDE folder capability on account/session shutdown. */
export function closeAllFolderFsRoots(): void {
  for (const byScope of grants.values()) for (const grant of byScope.values()) grant.close();
  grants.clear();
}

function cleanRel(rel: unknown): string {
  const parts: string[] = [];
  for (const segment of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new FolderFsError('forbidden', '폴더 밖의 경로입니다');
    parts.push(segment);
  }
  return parts.join('/');
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

function notFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

function folderError(error: unknown, fallback = '파일 작업에 실패했습니다'): Error {
  if (error instanceof FolderFsError) return error;
  const code = errorCode(error);
  if (notFound(error)) return new FolderFsError('not_found', '파일 또는 폴더가 없습니다');
  if (code === 'EEXIST') return new FolderFsError('exists', '같은 이름이 이미 있습니다');
  if (code === 'FILE_SOURCE_CHANGED') return new FolderFsError('changed', '그사이 파일이 바뀌었습니다');
  if (code === 'PATH_DOMAIN_MISMATCH' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
    return new FolderFsError('forbidden', '연결한 폴더 밖의 경로입니다');
  }
  return error instanceof Error ? error : new FolderFsError('io_error', fallback);
}

async function rooted(root: string, path: unknown, allowMissing = false): Promise<RootedResolvedPath> {
  const rel = cleanRel(path);
  try {
    return await resolveRootedPath(rel, resolve(root), [grantFor(root)], { allowMissing });
  } catch (error) {
    throw folderError(error);
  }
}

const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');

function readAll(source: RootedSource): Uint8Array {
  return source.read(0, source.size);
}

async function currentSha(path: RootedResolvedPath): Promise<{ sha: string; source: RootedSource | null }> {
  let source: RootedSource;
  try {
    source = path.grant.openSource(path.relativePath);
  } catch (error) {
    if (notFound(error)) return { sha: '', source: null };
    if (errorCode(error) === 'EINVAL' || errorCode(error) === 'EISDIR') {
      throw new FolderFsError('not_file', '파일이 아닙니다');
    }
    throw folderError(error);
  }
  try {
    const sha = source.size > FOLDER_READ_MAX
      ? `mtime:${source.mtimeMs}:${source.size}`
      : sha1(readAll(source));
    return { sha, source };
  } catch (error) {
    source.close();
    throw folderError(error);
  }
}

export async function listFolder(root: string, dir: string): Promise<FolderEntry[]> {
  const rel = cleanRel(dir);
  const path = await rooted(root, rel);
  try {
    return path.grant.list(path.relativePath)
      .filter((entry) => !HIDDEN.has(entry.name))
      .slice(0, FOLDER_LIST_MAX)
      .map((entry) => ({
        path: joinRel(rel, entry.name),
        isDir: entry.type === 'directory',
        size: entry.type === 'file' ? entry.size : null,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
      }));
  } catch (error) {
    if (notFound(error)) throw new FolderFsError('not_found', '폴더가 없습니다');
    throw folderError(error);
  }
}

export async function readFolderFile(root: string, path: string): Promise<{ bytes: Uint8Array; sha: string; size: number }> {
  const target = await rooted(root, path);
  let source: RootedSource | undefined;
  try {
    source = target.grant.openSource(target.relativePath);
    if (source.size > FOLDER_READ_MAX) {
      throw new FolderFsError('too_large', '파일이 너무 큽니다', { size: source.size });
    }
    const bytes = readAll(source);
    return { bytes, sha: sha1(bytes), size: bytes.length };
  } catch (error) {
    if (errorCode(error) === 'EINVAL' || errorCode(error) === 'EISDIR') {
      throw new FolderFsError('not_file', '파일이 아닙니다');
    }
    throw folderError(error);
  } finally {
    source?.close();
  }
}

export async function saveFolderFile(
  root: string,
  path: string,
  bytes: Uint8Array,
  baseSha: string | null,
): Promise<{ sha: string }> {
  const rel = cleanRel(path);
  if (!rel) throw new FolderFsError('forbidden', '폴더 자체에는 쓸 수 없습니다');
  const target = await rooted(root, rel, true);
  let current: RootedSource | null = null;
  try {
    let overwrite = true;
    let expected;
    if (baseSha !== null) {
      const value = await currentSha(target);
      current = value.source;
      if (value.sha !== baseSha) {
        throw new FolderFsError('changed', '그사이 파일이 바뀌었습니다', { current_sha: value.sha });
      }
      overwrite = baseSha !== '';
      expected = current?.identity;
    }
    target.grant.mkdirs(dirname(target.relativePath) === '.' ? '' : dirname(target.relativePath));
    if (current) {
      target.grant.writeExpected(target.relativePath, bytes, current.identity);
    } else if (baseSha === null) {
      // Legacy unconditional writes also work on write-only files.
      target.grant.write(target.relativePath, bytes);
    } else {
      await atomicWorkspaceWrite(target, bytes, {
        overwrite,
        ...(expected ? { expected } : {}),
        ...(!overwrite ? { creationMode: 0o666 & ~process.umask() } : {}),
      });
    }
    return { sha: sha1(bytes) };
  } catch (error) {
    if (errorCode(error) === 'FILE_SOURCE_CHANGED' || (baseSha === '' && errorCode(error) === 'EEXIST')) {
      throw new FolderFsError('changed', '그사이 파일이 바뀌었습니다');
    }
    throw folderError(error);
  } finally {
    current?.close();
  }
}

export async function statFolderFiles(root: string, paths: string[]): Promise<Record<string, FolderStat>> {
  const output: Record<string, FolderStat> = {};
  for (const input of paths) {
    try {
      const path = await rooted(root, input);
      const info = path.grant.stat(path.relativePath);
      if (info.type === 'directory') output[input] = { kind: 'dir', mtime: info.mtimeMs };
      else if (info.type !== 'file') output[input] = { kind: 'other' };
      else {
        const value = await currentSha(path);
        try {
          output[input] = { kind: 'file', size: info.size, mtime: info.mtimeMs, sha: value.sha };
        } finally {
          value.source?.close();
        }
      }
    } catch {
      output[input] = { kind: 'missing' };
    }
  }
  return output;
}

export async function readFolderRaw(root: string, path: string): Promise<Uint8Array> {
  const target = await rooted(root, path);
  let source: RootedSource | undefined;
  try {
    source = target.grant.openSource(target.relativePath);
    if (source.size > FOLDER_RAW_MAX) {
      throw new FolderFsError('too_large', '파일이 너무 큽니다', { size: source.size });
    }
    return readAll(source);
  } catch (error) {
    if (notFound(error) || errorCode(error) === 'EINVAL' || errorCode(error) === 'EISDIR') {
      throw new FolderFsError('not_found', '파일이 없습니다');
    }
    throw folderError(error);
  } finally {
    source?.close();
  }
}

export type FolderFsOp =
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; src: string; dst: string }
  | { op: 'copy'; src: string; dst: string }
  | { op: 'delete'; paths: string[] };

async function assertMissing(path: RootedResolvedPath): Promise<void> {
  try {
    path.grant.stat(path.relativePath);
    throw new FolderFsError('exists', '같은 이름이 이미 있습니다');
  } catch (error) {
    if (notFound(error)) return;
    throw error;
  }
}

function copyTree(grant: RootGrant, source: string, target: string): void {
  for (const entry of grant.list(source)) {
    if (entry.type === 'symlink') continue;
    const childSource = joinRel(source, entry.name);
    const childTarget = joinRel(target, entry.name);
    if (entry.type === 'directory') {
      grant.mkdirs(childTarget);
      copyTree(grant, childSource, childTarget);
      if (platform !== 'win32') grant.setMode(childTarget, entry.mode);
    } else if (entry.type === 'file') {
      grant.copyFileNoReplace(childSource, childTarget);
    }
  }
}

export async function runFolderOp(root: string, op: FolderFsOp, deps: FolderFsDeps = {}): Promise<void> {
  if (op.op === 'mkdir') {
    const target = await rooted(root, op.path, true);
    target.grant.mkdirs(target.relativePath);
    return;
  }
  if (op.op === 'rename' || op.op === 'copy') {
    const sourceRel = cleanRel(op.src);
    const targetRel = cleanRel(op.dst);
    if (!sourceRel || !targetRel) throw new FolderFsError('forbidden', '폴더 자체는 옮길 수 없습니다');
    const source = await rooted(root, sourceRel);
    const target = await rooted(root, targetRel, true);
    if (source.grant !== target.grant) throw new FolderFsError('forbidden', '연결한 폴더 밖의 경로입니다');
    await assertMissing(target);
    try {
      if (op.op === 'rename') {
        source.grant.renameNoReplace(source.relativePath, target.relativePath);
      } else {
        const info = source.grant.stat(source.relativePath);
        if (info.type === 'directory') {
          if (target.relativePath.startsWith(`${source.relativePath}/`)) {
            throw new FolderFsError('forbidden', '폴더를 자기 안으로 복사할 수 없습니다');
          }
          source.grant.mkdirs(target.relativePath);
          copyTree(source.grant, source.relativePath, target.relativePath);
          if (platform !== 'win32') source.grant.setMode(target.relativePath, info.mode);
        } else if (info.type === 'file') {
          source.grant.mkdirs(dirname(target.relativePath) === '.' ? '' : dirname(target.relativePath));
          source.grant.copyFileNoReplace(source.relativePath, target.relativePath);
        } else {
          throw new FolderFsError('not_file', '복사할 수 있는 파일 또는 폴더가 아닙니다');
        }
      }
      return;
    } catch (error) {
      throw folderError(error);
    }
  }
  for (const input of op.paths) {
    const rel = cleanRel(input);
    if (!rel) throw new FolderFsError('forbidden', '연결한 폴더 자체는 여기서 지울 수 없습니다');
    const path = await rooted(root, rel);
    let quarantine;
    try {
      quarantine = path.grant.beginQuarantine(path.relativePath);
    } catch (error) {
      throw folderError(error);
    }
    try {
      if (deps.trash) await deps.trash(quarantine.path);
      else await rm(quarantine.path, { recursive: true, force: true });
    } catch (error) {
      try {
        quarantine.rollback();
      } catch (rollbackError) {
        throw new FolderFsError('io_error', '삭제 작업에 실패했습니다. 원본은 복구 경로에 남아 있습니다.', {
          recovery_path: quarantine.path,
          rollback_code: errorCode(rollbackError),
        });
      }
      throw folderError(error);
    } finally {
      quarantine.close();
    }
  }
}

export async function folderFsCall(
  root: string,
  op: string,
  args: Record<string, unknown>,
  deps: FolderFsDeps = {},
  scopeKey: string = DEFAULT_SCOPE,
): Promise<unknown> {
  return grantScope.run(scopeKey, () => folderFsCallInScope(root, op, args, deps));
}

async function folderFsCallInScope(
  root: string,
  op: string,
  args: Record<string, unknown>,
  deps: FolderFsDeps,
): Promise<unknown> {
  switch (op) {
    case 'list': return listFolder(root, String(args.dir ?? ''));
    case 'read': return readFolderFile(root, String(args.path ?? ''));
    case 'save':
      return saveFolderFile(
        root,
        String(args.path ?? ''),
        args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(),
        typeof args.baseSha === 'string' ? args.baseSha : null,
      );
    case 'stat': return statFolderFiles(root, Array.isArray(args.paths) ? args.paths.map(String) : []);
    case 'raw': return readFolderRaw(root, String(args.path ?? ''));
    case 'fs': return runFolderOp(root, args.op as FolderFsOp, deps);
    case 'reveal': {
      const path = await rooted(root, String(args.path ?? ''));
      deps.reveal?.(path.displayPath);
      return null;
    }
    default: throw new FolderFsError('bad_request', `알 수 없는 작업: ${op}`);
  }
}
