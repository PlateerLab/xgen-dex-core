import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDirectory } from '@dex/engine';
import type { DeviceDraftStorage } from '@dex/protocol';

let current: { dir: string; store: DeviceDraftStorage } | undefined;

export function localDraftStorage(): DeviceDraftStorage {
  const dir = join(dataDirectory(), 'drafts');
  if (current?.dir === dir) return current.store;
  const filename = (key: string) => join(dir, createHash('sha256').update(key).digest('hex'));
  const store: DeviceDraftStorage = {
    read(key) {
      try { return readFileSync(filename(key), 'utf8'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
    },
    write(key, value) {
      const path = filename(key);
      if (value === null) { rmSync(path, { force: true }); return; }
      mkdirSync(dir, { mode: 0o700, recursive: true });
      const tmp = path + '.' + randomUUID();
      try {
        writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, path);
      } finally { rmSync(tmp, { force: true }); }
    },
  };
  current = {dir, store};
  return store;
}
