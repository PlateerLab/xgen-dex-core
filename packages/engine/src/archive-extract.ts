/**
 * 내려받은 런타임 압축(tar.gz · zip)을 **안전하게** 푼다.
 *
 * 풀기 전에 항목을 전부 훑어 본다 — 절대 경로 · `..` · 드라이브 문자 · 역슬래시 ·
 * 설치 폴더를 벗어나는 링크 · 이상한 항목 종류(장치 파일 등) · 크기/개수 상한.
 * 하나라도 걸리면 아무것도 풀지 않는다. 해시를 확인한 파일이라도 이 검사는 한다
 * (해시는 "받은 것이 고정한 것과 같다" 만 말해 준다).
 *
 * tar.gz 는 `tar` 패키지(데스크톱 음성 전처리 설치와 같은 것), zip 은 외부 의존 없이
 * 여기서 읽는다 — Windows 런타임(Node · uv)은 zip 으로만 배포되고, 필요한 것은
 * 저장(0) · deflate(8) 두 방식과 중앙 디렉터리뿐이다. ZIP64 · 암호화 · 분할은 거부한다.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
/**
 * `tar` 는 쓸 때만 불러온다 — CLI 번들은 서드파티를 external 로 두고 `tar` 를 싣지 않는다.
 * 엔진 index 를 불러오기만 해도 깨지지 않게, 런타임 설치(데스크톱)에서만 로드한다.
 */
const loadTar = (): Promise<typeof import('tar')> => import('tar');

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

export interface ExtractLimits {
  maxExpandedBytes: number;
  maxEntries: number;
}

export interface ExtractOptions extends ExtractLimits {
  format: 'tar.gz' | 'zip';
  /** 맨 위 경로 몇 단계를 벗길지(`node-v24.22.3-linux-x64/bin/node` → `bin/node`). */
  strip: number;
  signal?: AbortSignal;
}

function safeRelative(p: string): boolean {
  if (!p) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  if (posix.isAbsolute(p) || /^[a-z]:/i.test(p)) return false;
  return !p.split('/').includes('..');
}

/** 앞 `strip` 단계를 벗긴 경로. 벗길 것이 남지 않으면(맨 위 폴더 자체) 빈 문자열. */
export function stripPath(p: string, strip: number): string {
  const parts = p
    .replace(/^\.\//, '')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  return parts.slice(strip).join('/');
}

/**
 * 한 항목을 검사한다. `linkpath` 는 심볼릭 링크면 그 항목 기준 상대, 하드 링크면 압축 기준.
 * 검사는 **벗긴 뒤의** 경로로 한다 — 실제로 디스크에 놓일 자리이기 때문이다.
 */
export function validateArchiveEntry(path: string, type: string, linkpath = '', strip = 0): void {
  const raw = path.replace(/^\.\//, '');
  if (!safeRelative(raw)) throw new UnsafeArchiveError(`안전하지 않은 압축 항목입니다: ${path}`);
  if (!['File', 'OldFile', 'ContiguousFile', 'Directory', 'SymbolicLink', 'Link'].includes(type)) {
    throw new UnsafeArchiveError(`허용하지 않는 압축 항목 종류입니다: ${type} (${path})`);
  }
  const placed = stripPath(raw, strip);
  if (!placed) return; // 벗겨지는 맨 위 폴더
  if (type === 'SymbolicLink') {
    if (
      !linkpath ||
      posix.isAbsolute(linkpath) ||
      linkpath.includes('\\') ||
      /^[a-z]:/i.test(linkpath)
    ) {
      throw new UnsafeArchiveError(`설치 폴더를 벗어나는 링크입니다: ${path}`);
    }
    const target = posix.normalize(posix.join(posix.dirname(placed), linkpath));
    if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) {
      throw new UnsafeArchiveError(`설치 폴더를 벗어나는 링크입니다: ${path}`);
    }
  }
  if (type === 'Link') {
    if (!safeRelative(linkpath.replace(/^\.\//, '')) || !stripPath(linkpath, strip)) {
      throw new UnsafeArchiveError(`설치 폴더를 벗어나는 링크입니다: ${path}`);
    }
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

// ── tar.gz ──────────────────────────────────────────────────────────

async function extractTarGz(archive: string, dest: string, opts: ExtractOptions): Promise<void> {
  const tar = await loadTar();
  let expanded = 0;
  let entries = 0;
  let problem: Error | undefined;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      if (problem) return;
      try {
        validateArchiveEntry(entry.path, entry.type, entry.linkpath ?? '', opts.strip);
        expanded += entry.size ?? 0;
        entries++;
        if (expanded > opts.maxExpandedBytes || entries > opts.maxEntries) {
          throw new UnsafeArchiveError('압축 파일이 너무 큽니다.');
        }
      } catch (error) {
        problem = error as Error;
      }
    },
  });
  if (problem) throw problem;
  if (!entries) throw new UnsafeArchiveError('빈 압축 파일입니다.');
  checkAbort(opts.signal);
  await mkdir(dest, { recursive: true });
  await tar.x({ file: archive, cwd: dest, strict: true, preservePaths: false, strip: opts.strip });
}

// ── zip ─────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  mode: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

async function readZipDirectory(archive: string): Promise<ZipEntry[]> {
  const fh = await open(archive, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new UnsafeArchiveError('zip 파일이 올바르지 않습니다.');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new UnsafeArchiveError('zip 끝 정보(EOCD)를 찾지 못했습니다.');
    const disk = tail.readUInt16LE(at + 4);
    const cdDisk = tail.readUInt16LE(at + 6);
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (disk !== 0 || cdDisk !== 0) throw new UnsafeArchiveError('분할 zip 은 지원하지 않습니다.');
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new UnsafeArchiveError('ZIP64 는 지원하지 않습니다.');
    }
    if (cdOffset + cdSize > size)
      throw new UnsafeArchiveError('zip 중앙 디렉터리가 파일 밖을 가리킵니다.');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) {
        throw new UnsafeArchiveError('zip 중앙 디렉터리가 손상되었습니다.');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd
        .subarray(p + 46, p + 46 + nameLen)
        .toString(flags & 0x800 ? 'utf8' : 'latin1');
      p += 46 + nameLen + extraLen + commentLen;
      if (
        compressedSize === 0xffffffff ||
        uncompressed === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new UnsafeArchiveError('ZIP64 는 지원하지 않습니다.');
      }
      entries.push({
        name,
        method,
        flags,
        crc,
        compressedSize,
        size: uncompressed,
        localOffset,
        mode: external >>> 16,
      });
    }
    return entries;
  } finally {
    await fh.close();
  }
}

function zipEntryType(entry: ZipEntry): string {
  const kind = entry.mode & 0o170000;
  if (kind === 0o120000) return 'SymbolicLink';
  if (entry.name.endsWith('/') || kind === 0o040000) return 'Directory';
  if (kind !== 0 && kind !== 0o100000) return 'Other';
  return 'File';
}

/** zlib.crc32 는 Node 22.2+ 에 있다. 없으면 크기 검사만 한다. */
const crc32: ((data: Uint8Array, value?: number) => number) | undefined = (
  zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }
).crc32;

async function extractZip(archive: string, dest: string, opts: ExtractOptions): Promise<void> {
  const entries = await readZipDirectory(archive);
  if (!entries.length) throw new UnsafeArchiveError('빈 압축 파일입니다.');
  if (entries.length > opts.maxEntries) throw new UnsafeArchiveError('압축 파일이 너무 큽니다.');
  let expanded = 0;
  for (const entry of entries) {
    const type = zipEntryType(entry);
    // zip 안의 심볼릭 링크는 런타임 배포물에 없다 — 받을 이유가 없으니 거부한다.
    if (type === 'SymbolicLink' || type === 'Other') {
      throw new UnsafeArchiveError(`허용하지 않는 압축 항목 종류입니다: ${entry.name}`);
    }
    validateArchiveEntry(entry.name.replace(/\/$/, ''), type, '', opts.strip);
    if (entry.flags & 0x1) throw new UnsafeArchiveError('암호화된 zip 은 지원하지 않습니다.');
    if (type === 'File' && entry.method !== 0 && entry.method !== 8) {
      throw new UnsafeArchiveError(`지원하지 않는 zip 압축 방식입니다: ${entry.method}`);
    }
    expanded += entry.size;
    if (expanded > opts.maxExpandedBytes) throw new UnsafeArchiveError('압축 파일이 너무 큽니다.');
  }
  const root = resolve(dest);
  await mkdir(root, { recursive: true });
  const fh = await open(archive, 'r');
  try {
    const archiveSize = (await stat(archive)).size;
    for (const entry of entries) {
      checkAbort(opts.signal);
      const rel = stripPath(entry.name.replace(/\/$/, ''), opts.strip);
      if (!rel) continue;
      const target = resolve(root, ...rel.split('/'));
      if (target !== root && !target.startsWith(root + sep)) {
        throw new UnsafeArchiveError(`안전하지 않은 압축 항목입니다: ${entry.name}`);
      }
      if (zipEntryType(entry) === 'Directory') {
        await mkdir(target, { recursive: true });
        continue;
      }
      const header = Buffer.alloc(30);
      await fh.read(header, 0, 30, entry.localOffset);
      if (header.readUInt32LE(0) !== LFH_SIG)
        throw new UnsafeArchiveError('zip 항목 머리가 손상되었습니다.');
      const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (start + entry.compressedSize > archiveSize)
        throw new UnsafeArchiveError('zip 항목이 파일 밖을 가리킵니다.');
      await mkdir(dirname(target), { recursive: true });
      let written = 0;
      let crc = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          written += chunk.length;
          if (written > entry.size)
            return done(new UnsafeArchiveError(`zip 항목 크기가 다릅니다: ${entry.name}`));
          if (crc32) crc = crc32(chunk, crc);
          done(null, chunk);
        },
      });
      const source = entry.compressedSize
        ? createReadStream(archive, { start, end: start + entry.compressedSize - 1 })
        : null;
      const mode = entry.mode & 0o111 ? 0o755 : 0o644;
      const out = createWriteStream(join(target), { flags: 'wx', mode });
      if (!source) {
        out.end();
        await new Promise<void>((ok, fail) => {
          out.once('finish', () => ok());
          out.once('error', fail);
        });
      } else if (entry.method === 8) {
        await pipeline(source, zlib.createInflateRaw(), meter, out, { signal: opts.signal });
      } else {
        await pipeline(source, meter, out, { signal: opts.signal });
      }
      if (written !== entry.size)
        throw new UnsafeArchiveError(`zip 항목 크기가 다릅니다: ${entry.name}`);
      if (crc32 && crc >>> 0 !== entry.crc >>> 0) {
        throw new UnsafeArchiveError(`zip 항목이 손상되었습니다(CRC): ${entry.name}`);
      }
    }
  } finally {
    await fh.close();
  }
}

/** 검사한 뒤 `dest` 에 푼다. `dest` 는 비어 있는 새 폴더여야 한다(부르는 쪽이 임시 폴더를 준다). */
export async function safeExtract(
  archive: string,
  dest: string,
  opts: ExtractOptions,
): Promise<void> {
  checkAbort(opts.signal);
  if (opts.format === 'zip') await extractZip(archive, dest, opts);
  else await extractTarGz(archive, dest, opts);
}
