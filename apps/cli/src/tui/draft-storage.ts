import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDirectory } from '@dex/engine';
import type { PendingStorage } from '@dex/protocol';

let current: { dir: string; store: PendingStorage } | undefined;

export function localDraftStorage(): PendingStorage {
  const dir = join(dataDirectory(), 'drafts');
  if (current?.dir === dir) return current.store;
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  const filename = (key: string) => {
    const match = /^(.*\/pending\/)([a-zA-Z0-9_-]{1,128})$/.exec(key);
    return join(dir, match ? hash(match[1]) + '.' + match[2] : hash(key));
  };
  const store: PendingStorage = {
    keys(prefix) {
      const start = hash(prefix) + '.';
      try {
        return readdirSync(dir).filter(name => name.startsWith(start) && /^[a-zA-Z0-9_-]{1,128}$/.test(name.slice(start.length)))
          .map(name => prefix + name.slice(start.length));
      } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
    },
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
