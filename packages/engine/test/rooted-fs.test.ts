import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { test } from 'node:test';
import {
  RootGrant,
  configureNativeFsStage,
  openPrivateStageSource,
  resolveRootedPath,
} from '../src/rooted-fs';

async function fixture(): Promise<{ base: string; root: string; stage: string; grant: RootGrant }> {
  const base = await mkdtemp(join(tmpdir(), 'dex-rooted-fs-'));
  const root = join(base, 'root');
  const stage = join(base, 'stage');
  await mkdir(root);
  await mkdir(stage);
  await chmod(stage, 0o700);
  configureNativeFsStage(stage);
  return { base, root, stage, grant: new RootGrant(root) };
}

test('a moved root keeps its object capability when the old pathname points outside', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await writeFile(join(value.root, 'owned.txt'), 'owned');
  const moved = join(value.base, 'moved');
  const outside = join(value.base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'owned.txt'), 'outside');
  await rename(value.root, moved);
  await symlink(outside, value.root, 'dir');

  const resolved = await resolveRootedPath('owned.txt', value.root, [value.grant]);
  const source = resolved.grant.openSource(resolved.relativePath);
  t.after(() => source.close());
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'owned');
});

test('an explicit in-root symlink is canonicalized once and read through the pinned root', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await mkdir(join(value.root, 'actual'));
  await writeFile(join(value.root, 'actual', 'file.txt'), 'allowed');
  await symlink(join(value.root, 'actual'), join(value.root, 'alias'), 'dir');

  const resolved = await resolveRootedPath('alias/file.txt', value.root, [value.grant]);
  assert.equal(resolved.relativePath, 'actual/file.txt');
  const source = resolved.grant.openSource(resolved.relativePath);
  t.after(() => source.close());
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'allowed');
});

test('ancestor and leaf swaps after canonicalization fail closed', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  const outside = join(value.base, 'outside');
  await mkdir(join(value.root, 'parent'));
  await mkdir(outside);
  await writeFile(join(value.root, 'parent', 'file.txt'), 'inside');
  await writeFile(join(outside, 'file.txt'), 'outside');
  const ancestor = await resolveRootedPath('parent/file.txt', value.root, [value.grant]);
  await rename(join(value.root, 'parent'), join(value.root, 'old-parent'));
  await symlink(outside, join(value.root, 'parent'), 'dir');
  assert.throws(
    () => ancestor.grant.openSource(ancestor.relativePath),
    (error: NodeJS.ErrnoException) => error.code === 'ELOOP' || error.code === 'ENOTDIR',
  );

  await writeFile(join(value.root, 'leaf.txt'), 'inside');
  const leaf = await resolveRootedPath('leaf.txt', value.root, [value.grant]);
  await rm(join(value.root, 'leaf.txt'));
  await symlink(join(outside, 'file.txt'), join(value.root, 'leaf.txt'), 'file');
  assert.throws(() => leaf.grant.openSource(leaf.relativePath), { code: 'ELOOP' });
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside');
});

test('engine adapts a trusted private-stage file to the stable source API', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await mkdir(join(value.stage, 'browser-output'));
  await writeFile(join(value.stage, 'browser-output', 'result.bin'), 'result');
  const source = openPrivateStageSource('browser-output/result.bin');
  t.after(() => source.close());
  assert.equal(source.size, 6);
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'result');
  source.assertUnchanged();
});
