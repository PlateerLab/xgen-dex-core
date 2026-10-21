import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  open,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  regular: boolean;
};

export interface AtomicWorkspaceWriteDependencies {
  openExclusive(path: string): Promise<FileHandle>;
  handleIdentity(handle: FileHandle): Promise<FileIdentity>;
  pathIdentity(path: string): Promise<FileIdentity>;
  linkNoReplace(source: string, target: string): Promise<void>;
  replace(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  randomNonce(): string;
}

const OPEN_EXCLUSIVE_NOFOLLOW =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (constants.O_NOFOLLOW ?? 0);

const nodeDependencies: AtomicWorkspaceWriteDependencies = {
  openExclusive: (path) => open(path, OPEN_EXCLUSIVE_NOFOLLOW, 0o600),
  handleIdentity: async (handle) => {
    const value = await handle.stat({ bigint: true });
    return { dev: value.dev, ino: value.ino, regular: value.isFile() };
  },
  pathIdentity: async (path) => {
    const value = await lstat(path, { bigint: true });
    return { dev: value.dev, ino: value.ino, regular: value.isFile() };
  },
  linkNoReplace: link,
  replace: rename,
  remove: (path) => rm(path, { force: true }),
  randomNonce: () => randomBytes(16).toString('hex'),
};

const NO_REPLACE_UNSUPPORTED = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EXDEV',
  'ENOSYS',
  'EINVAL',
  'EMLINK',
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '') || undefined
    : undefined;
}

function workspaceWriteError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function sameIdentity(opened: FileIdentity, visible: FileIdentity): boolean {
  return opened.regular && visible.regular && opened.dev === visible.dev && opened.ino === visible.ino;
}

/**
 * Commit downloaded bytes beside their destination.
 *
 * The random, exclusive staging file prevents preclaimed symlinks from receiving
 * bytes. A hard link is the no-overwrite commit point: unlike an exists check
 * followed by rename, it fails atomically when another writer won the target.
 * Filesystems without that primitive fail closed instead of falling back to a
 * racy replacement.
 *
 * This is still a pathname API. A same-user process that can rewrite the parent
 * directory can race pathname resolution or replace the target after commit.
 * Strong protection against that actor needs platform-native directory handles.
 * Network filesystems that do not honor exclusive create or hard-link semantics
 * are outside this boundary. File bytes are synced before commit, but the parent
 * directory is not synced, so power-loss persistence is not promised here.
 */
export async function atomicWorkspaceWrite(
  target: string,
  bytes: Uint8Array,
  options: { overwrite: boolean; signal?: AbortSignal },
  overrides: Partial<AtomicWorkspaceWriteDependencies> = {},
): Promise<void> {
  const dependencies = { ...nodeDependencies, ...overrides };
  options.signal?.throwIfAborted();

  let staging = '';
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const nonce = dependencies.randomNonce();
    if (!/^[0-9a-f]{32}$/i.test(nonce)) {
      throw workspaceWriteError('WORKSPACE_ATOMIC_STAGE_NONCE_INVALID');
    }
    staging = join(dirname(target), `.xgen-${nonce}.tmp`);
    try {
      handle = await dependencies.openExclusive(staging);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  if (!handle) throw workspaceWriteError('WORKSPACE_ATOMIC_STAGE_UNAVAILABLE');

  try {
    options.signal?.throwIfAborted();
    await handle.writeFile(bytes, options.signal ? { signal: options.signal } : undefined);
    await handle.sync();
    const opened = await dependencies.handleIdentity(handle);
    if (!opened.regular || opened.ino === 0n) {
      throw workspaceWriteError('WORKSPACE_ATOMIC_STAGE_IDENTITY_UNAVAILABLE');
    }
    await handle.close();
    handle = null;

    let visible: FileIdentity;
    try {
      visible = await dependencies.pathIdentity(staging);
    } catch (error) {
      throw workspaceWriteError('WORKSPACE_ATOMIC_STAGE_CHANGED', error);
    }
    if (!sameIdentity(opened, visible)) {
      throw workspaceWriteError('WORKSPACE_ATOMIC_STAGE_CHANGED');
    }
    options.signal?.throwIfAborted();

    if (options.overwrite) {
      await dependencies.replace(staging, target);
    } else {
      try {
        await dependencies.linkNoReplace(staging, target);
      } catch (error) {
        if (NO_REPLACE_UNSUPPORTED.has(errorCode(error) ?? '')) {
          throw workspaceWriteError('WORKSPACE_ATOMIC_COMMIT_UNSUPPORTED', error);
        }
        throw error;
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (staging) await dependencies.remove(staging).catch(() => undefined);
  }
}
