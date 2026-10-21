import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  atomicWorkspaceWrite,
  type AtomicWorkspaceWriteDependencies,
} from '@dex/engine/atomic-workspace-write';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'xgen-atomic-workspace-'));
}

async function assertNoStagingFiles(dir: string): Promise<void> {
  assert.equal((await readdir(dir)).some((name) => /^\.xgen-[0-9a-f]{32}\.tmp$/i.test(name)), false);
}

test('exclusive random staging skips a preclaimed name', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    const claimedNonce = 'a'.repeat(32);
    const claimed = join(dir, `.xgen-${claimedNonce}.tmp`);
    await writeFile(claimed, 'CLAIMED');
    const nonces = [claimedNonce, 'b'.repeat(32)];

    await atomicWorkspaceWrite(
      target,
      new TextEncoder().encode('PAYLOAD'),
      { overwrite: false },
      { randomNonce: () => nonces.shift() ?? 'c'.repeat(32) },
    );

    assert.equal(await readFile(claimed, 'utf8'), 'CLAIMED');
    assert.equal(await readFile(target, 'utf8'), 'PAYLOAD');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exclusive staging never follows a preclaimed symlink', { skip: platform() === 'win32' }, async () => {
  const dir = await fixture();
  try {
    const outside = join(dir, 'outside.txt');
    const target = join(dir, 'saved.txt');
    const claimedNonce = 'a'.repeat(32);
    const claimed = join(dir, `.xgen-${claimedNonce}.tmp`);
    await writeFile(outside, 'SAFE');
    await symlink(outside, claimed, 'file');
    const nonces = [claimedNonce, 'b'.repeat(32)];

    await atomicWorkspaceWrite(
      target,
      new TextEncoder().encode('PAYLOAD'),
      { overwrite: false },
      { randomNonce: () => nonces.shift() ?? 'c'.repeat(32) },
    );

    assert.equal(await readFile(outside, 'utf8'), 'SAFE');
    assert.equal(await readFile(target, 'utf8'), 'PAYLOAD');
    assert.equal((await lstat(claimed)).isSymbolicLink(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no-replace commit preserves a target created after staging', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    const createThenLink: AtomicWorkspaceWriteDependencies['linkNoReplace'] = async (source, destination) => {
      await writeFile(destination, 'RACER', { flag: 'wx' });
      await link(source, destination);
    };

    await assert.rejects(
      atomicWorkspaceWrite(target, new TextEncoder().encode('PAYLOAD'), { overwrite: false }, {
        linkNoReplace: createThenLink,
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
    assert.equal(await readFile(target, 'utf8'), 'RACER');
    await assertNoStagingFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing targets are preserved by the atomic no-replace primitive', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    await writeFile(target, 'EXISTING');
    await assert.rejects(
      atomicWorkspaceWrite(target, new TextEncoder().encode('PAYLOAD'), { overwrite: false }),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
    assert.equal(await readFile(target, 'utf8'), 'EXISTING');
    await assertNoStagingFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsupported hard links fail closed without replacing the target', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    const unsupported: AtomicWorkspaceWriteDependencies['linkNoReplace'] = async () => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    };
    await assert.rejects(
      atomicWorkspaceWrite(target, new TextEncoder().encode('PAYLOAD'), { overwrite: false }, {
        linkNoReplace: unsupported,
      }),
      /WORKSPACE_ATOMIC_COMMIT_UNSUPPORTED/,
    );
    await assert.rejects(readFile(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assertNoStagingFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unusable or changed staging identities fail closed and clean up', async () => {
  for (const candidate of [
    {
      expected: /WORKSPACE_ATOMIC_STAGE_IDENTITY_UNAVAILABLE/,
      overrides: {
        handleIdentity: async () => ({ dev: 1n, ino: 0n, regular: true }),
      },
    },
    {
      expected: /WORKSPACE_ATOMIC_STAGE_CHANGED/,
      overrides: {
        pathIdentity: async (path: string) => {
          const value = await lstat(path, { bigint: true });
          return { dev: value.dev, ino: value.ino + 1n, regular: value.isFile() };
        },
      },
    },
  ] as const) {
    const dir = await fixture();
    try {
      const target = join(dir, 'saved.txt');
      await assert.rejects(
        atomicWorkspaceWrite(
          target,
          new TextEncoder().encode('PAYLOAD'),
          { overwrite: false },
          candidate.overrides,
        ),
        candidate.expected,
      );
      await assert.rejects(readFile(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      await assertNoStagingFiles(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('cancellation before commit removes staging and leaves the target absent', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    const abort = new AbortController();
    const handleIdentity: AtomicWorkspaceWriteDependencies['handleIdentity'] = async (handle) => {
      const value = await handle.stat({ bigint: true });
      abort.abort();
      return { dev: value.dev, ino: value.ino, regular: value.isFile() };
    };
    await assert.rejects(
      atomicWorkspaceWrite(target, new TextEncoder().encode('PAYLOAD'), {
        overwrite: false,
        signal: abort.signal,
      }, { handleIdentity }),
      (error: Error) => error.name === 'AbortError',
    );
    await assert.rejects(readFile(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assertNoStagingFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('overwrite atomically replaces the target after staging and sync', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'saved.txt');
    await writeFile(target, 'OLD');
    await atomicWorkspaceWrite(target, new TextEncoder().encode('NEW'), { overwrite: true });
    assert.equal(await readFile(target, 'utf8'), 'NEW');
    await assertNoStagingFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
