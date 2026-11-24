// Renderer receives an unguessable handle. Only preload can register a native File's path.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const directory = join(homedir(), '.xgen-dex', 'draft-file-handles');
const valid = /^draft-[0-9a-f-]{36}$/;

export function rememberDraftFile(path: string) {
  const ref = 'draft-' + randomUUID();
  const { size, mtimeMs, dev, ino } = statSync(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, ref), JSON.stringify({ path, size, mtimeMs, dev, ino }), { flag: 'wx', mode: 0o600 });
  return ref;
}

export function resolveDraftFile(ref: string) {
  if (!valid.test(ref)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(join(directory, ref), 'utf8'));
    const stat = statSync(saved.path);
    if (stat.isFile() && stat.size === saved.size && stat.mtimeMs === saved.mtimeMs &&
        stat.dev === saved.dev && stat.ino === saved.ino) return saved.path as string;
  } catch { /* Selected file was removed, or the local handle was cleared. */ }
  throw new Error('첨부 파일이 변경되었거나 이동했습니다. 파일을 다시 선택해 주세요.');
}

export function forgetDraftFile(ref: string) {
  if (valid.test(ref)) rmSync(join(directory, ref), { force: true });
}
