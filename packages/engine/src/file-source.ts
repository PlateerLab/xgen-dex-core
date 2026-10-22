/** Disk-backed upload source held by a native rooted file handle. */
import { basename } from 'node:path';
import type { ResumableSource } from '@dex/protocol';
import {
  openStandaloneSource,
  type RootGrant,
  type RootedResolvedPath,
  type RootedSource,
} from './rooted-fs';

/** 파일 경로가 소스를 만든 뒤 다른 객체나 내용으로 바뀌었다. */
export class FileSourceChangedError extends Error {
  readonly code = 'FILE_SOURCE_CHANGED';

  constructor(path: string, cause?: unknown) {
    super(`파일이 업로드 중 바뀌었습니다: ${path}`, cause === undefined ? undefined : { cause });
    this.name = 'FileSourceChangedError';
  }
}

/** 선택한 경로가 일반 파일이 아니어서 업로드 소스로 사용할 수 없다. */
export class FileSourceNotRegularError extends Error {
  readonly code = 'FILE_SOURCE_NOT_REGULAR';

  constructor(path: string) {
    super(`파일이 아닙니다: ${path}`);
    this.name = 'FileSourceNotRegularError';
  }
}

export interface FileSource extends ResumableSource {
  /** The caller that owns the upload lifecycle must close the pinned handle. */
  close(): Promise<void>;
}

function fromOpened(
  path: string,
  source: RootedSource,
  closeOwner: () => void,
  opts: { name?: string; type?: string; signal?: AbortSignal },
): FileSource {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    source.close();
    closeOwner();
  };
  return {
    name: opts.name ?? basename(path),
    size: source.size,
    type: opts.type || 'application/octet-stream',
    lastModified: source.mtimeMs,
    resumeIdentity: source.resumeIdentity,
    async read(offset, length) {
      opts.signal?.throwIfAborted();
      if (closed) throw new FileSourceChangedError(path);
      try {
        const bytes = source.read(offset, length);
        opts.signal?.throwIfAborted();
        return bytes;
      } catch (error) {
        throw sourceError(path, error);
      }
    },
    close,
  };
}

/** Create a source under an already-pinned conversation root. */
export function fileSourceFromRooted(
  path: RootedResolvedPath,
  opts: { name?: string; type?: string; signal?: AbortSignal } = {},
): FileSource {
  opts.signal?.throwIfAborted();
  try {
    return fromOpened(path.displayPath, path.grant.openSource(path.relativePath), () => undefined, opts);
  } catch (error) {
    throw sourceError(path.displayPath, error);
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

function sourceError(path: string, error: unknown): Error {
  return errorCode(error) === 'FILE_SOURCE_NOT_REGULAR' ||
    errorCode(error) === 'EISDIR' || errorCode(error) === 'EINVAL'
    ? new FileSourceNotRegularError(path)
    : new FileSourceChangedError(path, error);
}

export async function fileSource(
  path: string,
  opts: { name?: string; type?: string; signal?: AbortSignal } = {},
): Promise<FileSource> {
  opts.signal?.throwIfAborted();
  let grant: RootGrant;
  let source: RootedSource;
  let canonicalPath: string;
  try {
    ({ grant, source, canonicalPath } = await openStandaloneSource(path));
  } catch (error) {
    throw sourceError(path, error);
  }
  try {
    opts.signal?.throwIfAborted();
    return fromOpened(
      canonicalPath,
      source,
      () => grant.close(),
      { ...opts, name: opts.name ?? basename(path) },
    );
  } catch (error) {
    source.close();
    grant.close();
    throw error;
  }
}

/** 파일 앞부분 몇 바이트(형식 판별용) — 전체를 읽지 않는다. */
export async function readFileHead(path: string, length: number): Promise<Uint8Array> {
  const source = await fileSource(path);
  try {
    return await source.read(0, length);
  } finally {
    await source.close();
  }
}
