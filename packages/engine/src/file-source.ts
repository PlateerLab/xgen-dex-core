/**
 * 디스크의 파일을 조각 업로드의 소스로 — 데스크톱 메인·CLI·VSCode(Node)가 같이 쓴다.
 *
 * 파일을 통째로 메모리에 올리지 않는다: 업로드 엔진이 조각(기본 8MiB)마다 그 범위만 읽는다.
 * 그래서 1GiB 영상도 몇 조각 크기의 메모리로 올라간다. 소스를 만들 때 실제 파일의 identity 를
 * 잡고, 조각마다 새로 연 파일이 같은 identity 인지 읽기 전후로 확인한다. 경로가 다른 파일이나
 * 심볼릭 링크로 바뀌거나 원본 inode 내용이 바뀌면 명시적으로 실패한다.
 */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ResumableSource } from '@dex/protocol';

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

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

const READ_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  // regular-file 검사 전에 FIFO/device open 이 기다리지 않게 한다. 일반 파일에는 영향이 없다.
  (constants.O_NONBLOCK ?? 0);

function identityOf(info: BigIntStats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function changed(path: string, cause?: unknown): FileSourceChangedError {
  return cause instanceof FileSourceChangedError ? cause : new FileSourceChangedError(path, cause);
}

function sourceError(path: string, cause: unknown): FileSourceChangedError | FileSourceNotRegularError {
  return cause instanceof FileSourceNotRegularError ? cause : changed(path, cause);
}

async function openedIdentity(fh: FileHandle, path: string): Promise<FileIdentity> {
  try {
    const info = await fh.stat({ bigint: true });
    if (!info.isFile()) throw new FileSourceNotRegularError(path);
    return identityOf(info);
  } catch (error) {
    throw sourceError(path, error);
  }
}

async function pathIdentity(path: string): Promise<FileIdentity> {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new FileSourceNotRegularError(path);
    return identityOf(info);
  } catch (error) {
    throw sourceError(path, error);
  }
}

async function openSameFile(path: string, expected?: FileIdentity): Promise<{ fh: FileHandle; identity: FileIdentity }> {
  let fh: FileHandle;
  try {
    // `path` 는 이미 realpath 한 최종 대상이다. O_NOFOLLOW 는 그 leaf 가 검사 뒤
    // 심볼릭 링크로 바뀌는 경계를 닫고, 지원하지 않는 플랫폼은 아래 identity 대조가 막는다.
    fh = await open(path, READ_FLAGS);
  } catch (error) {
    throw changed(path, error);
  }
  try {
    const identity = await openedIdentity(fh, path);
    if (expected && !sameIdentity(identity, expected)) throw changed(path);
    // open 이 parent 경로를 따라간 뒤 그 parent 가 바뀌었는지도 확인한다. 이후 경로가
    // 바뀌어도 실제 read 는 이미 연 handle 에서 하므로 다른 파일을 따라가지 않는다.
    if (!sameIdentity(await pathIdentity(path), identity)) throw changed(path);
    return { fh, identity };
  } catch (error) {
    await fh.close().catch(() => undefined);
    // A non-regular initial selection is a usage error. Once the source exists, any
    // type or identity change is an upload-time mutation instead.
    throw expected ? changed(path, error) : sourceError(path, error);
  }
}

export async function fileSource(
  path: string,
  opts: { name?: string; type?: string; signal?: AbortSignal } = {},
): Promise<ResumableSource> {
  opts.signal?.throwIfAborted();
  // 사용자가 고른 안전한 심볼릭 링크는 지금 가리키는 실제 파일로 고정한다. 이후
  // 원래 링크가 바뀌어도 새 대상을 따라가지 않는다.
  const canonical = await realpath(path);
  const initial = await openSameFile(canonical);
  await initial.fh.close();
  opts.signal?.throwIfAborted();
  const identity = initial.identity;
  const size = Number(identity.size);
  const resumeIdentity = createHash('sha256')
    .update(JSON.stringify([
      'node-file-v1',
      identity.dev.toString(),
      identity.ino.toString(),
      identity.size.toString(),
      identity.mtimeNs.toString(),
      identity.ctimeNs.toString(),
    ]))
    .digest('hex');
  return {
    name: opts.name ?? basename(path),
    size,
    type: opts.type || 'application/octet-stream',
    lastModified: Number(identity.mtimeNs / 1_000_000n),
    resumeIdentity,
    async read(offset, length) {
      opts.signal?.throwIfAborted();
      const { fh } = await openSameFile(canonical, identity);
      try {
        opts.signal?.throwIfAborted();
        const want = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          opts.signal?.throwIfAborted();
          const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        const after = await openedIdentity(fh, canonical);
        if (!sameIdentity(after, identity) || got !== want) throw changed(canonical);
        opts.signal?.throwIfAborted();
        return new Uint8Array(buf.buffer, buf.byteOffset, got);
      } finally {
        await fh.close();
      }
    },
  };
}

/** 파일 앞부분 몇 바이트(형식 판별용) — 전체를 읽지 않는다. */
export async function readFileHead(path: string, length: number): Promise<Uint8Array> {
  const source = await fileSource(path);
  return source.read(0, length);
}
