import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDirectory } from '@dex/engine';
import type { DeviceDraftStorage } from '@dex/protocol';

const directory = () => join(dataDirectory(), 'drafts');
const filename = (key: string) => join(directory(), createHash('sha256').update(key).digest('hex'));

export const draftStorage: DeviceDraftStorage = {
  read(key) {
    try { return readFileSync(filename(key), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  },
  write(key, value) {
    const path = filename(key);
    if (value === null) { rmSync(path, { force: true }); return; }
    mkdirSync(directory(), { mode: 0o700, recursive: true });
    const tmp = path + '.' + randomUUID();
    try {
      writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } finally { rmSync(tmp, { force: true }); }
  },
};
