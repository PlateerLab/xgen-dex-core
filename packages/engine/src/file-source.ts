/**
 * 디스크의 파일을 조각 업로드의 소스로 — 데스크톱 메인·CLI·VSCode(Node)가 같이 쓴다.
 *
 * 파일을 통째로 메모리에 올리지 않는다: 업로드 엔진이 조각(기본 8MiB)마다 그 범위만 읽는다.
 * 그래서 1GiB 영상도 몇 조각 크기의 메모리로 올라간다. 올리는 도중 파일이 바뀌면(크기·수정 시각)
 * 그 조각을 짧게 돌려줘서 엔진이 "파일이 바뀌었다" 로 멈추게 한다 — 반쯤 바뀐 파일을 올리지 않는다.
 */
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ResumableSource } from '@dex/protocol';

export async function fileSource(
  path: string,
  opts: { name?: string; type?: string } = {},
): Promise<ResumableSource> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`파일이 아닙니다: ${path}`);
  const size = info.size;
  const mtime = info.mtimeMs;
  return {
    name: opts.name ?? basename(path),
    size,
    type: opts.type || 'application/octet-stream',
    lastModified: Math.floor(mtime),
    async read(offset, length) {
      const fh = await open(path, 'r');
      try {
        const now = await fh.stat();
        if (now.size !== size || now.mtimeMs !== mtime) return new Uint8Array(0);
        const want = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, got);
      } finally {
        await fh.close();
      }
    },
  };
}

/** 파일 앞부분 몇 바이트(형식 판별용) — 전체를 읽지 않는다. */
export async function readFileHead(path: string, length: number): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}
