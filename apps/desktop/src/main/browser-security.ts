import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { normalizeBrowserUrl } from '@dex/protocol/browser';

export const BROWSER_PARTITION_PREFIX = 'persist:xgen-browser-';

export function browserPartition(serverUrl: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`${serverUrl.replace(/\/+$/, '').toLowerCase()}|${userId}`)
    .digest('hex')
    .slice(0, 24);
  return `${BROWSER_PARTITION_PREFIX}${digest}`;
}

export function allowedBrowserUrl(raw: unknown): string | null {
  return normalizeBrowserUrl(raw);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
  return path;
}

/** Upload/download paths share the structured local-tool allowedRoots scope. */
export function browserPathWithinRoots(path: unknown, roots: string[]): string | null {
  const raw = String(path ?? '').trim();
  if (!raw) return null;
  const absolute = resolve(isAbsolute(expandHome(raw)) ? expandHome(raw) : resolve(homedir(), raw));
  const allowed = (roots.length ? roots : [homedir()]).map((root) => resolve(expandHome(root)));
  return allowed.some((root) => {
    const rel = relative(root, absolute);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  })
    ? absolute
    : null;
}
