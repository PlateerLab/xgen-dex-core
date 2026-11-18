/** 시험용 압축 파일 만들기 — zip(저장/deflate)과 tar.gz. */
import { crc32, deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import * as tar from 'tar';

export interface ZipInput {
  name: string;
  data?: string | Buffer;
  deflate?: boolean;
  /** 중앙 디렉터리에 적을 CRC 를 일부러 틀리게 한다. */
  badCrc?: boolean;
  /** unix 모드(외부 속성 상위 16비트). */
  mode?: number;
}

export function writeZip(path: string, entries: ZipInput[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw =
      e.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(e.data)
          ? e.data
          : Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const crc = (crc32(raw) ^ (e.badCrc ? 1 : 0)) >>> 0;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
}

/** `cwd` 아래의 `entries` 를 tar.gz 로 묶는다(심볼릭 링크는 그대로). */
export async function writeTarGz(path: string, cwd: string, entries: string[]): Promise<void> {
  await tar.c({ gzip: true, file: path, cwd, portable: true }, entries);
}
