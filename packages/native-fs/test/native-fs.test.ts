import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { platform } from 'node:process';
import { test } from 'node:test';
import { configureNativeFsStage, openNativeRoot, openPrivateStageSource, type NativeRoot } from '../src/index';

async function fixture(): Promise<{ base: string; rootPath: string; stagePath: string; root: NativeRoot }> {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-fs-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  await chmod(stagePath, 0o700);
  const canonicalStagePath = configureNativeFsStage(stagePath);
  return { base, rootPath, stagePath: canonicalStagePath, root: openNativeRoot(rootPath) };
}

function closeFixture(t: { after(fn: () => unknown): void }, value: Awaited<ReturnType<typeof fixture>>): void {
  t.after(async () => {
    value.root.close();
    await rm(value.base, { recursive: true, force: true });
  });
}

async function waitReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`racer exited before ready (${code})`)));
  });
}

test('this platform provides the rooted native backend', async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  assert.equal(value.root.stat('').type, 'directory');
});

test('a root handle remains bound to the approved object after its pathname is replaced', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  await writeFile(join(value.rootPath, 'owned.txt'), 'owned');
  const moved = join(value.base, 'moved-root');
  const outside = join(value.base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'owned.txt'), 'outside');
  await rename(value.rootPath, moved);
  await symlink(outside, value.rootPath, 'dir');

  const source = value.root.openSource('owned.txt');
  t.after(() => source.close());
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'owned');
  value.root.write('created.txt', Buffer.from('inside'));
  assert.equal(await readFile(join(moved, 'created.txt'), 'utf8'), 'inside');
  await assert.rejects(readFile(join(outside, 'created.txt')), { code: 'ENOENT' });
});

test('ancestor and leaf symlink swaps are rejected without touching the outside sentinel', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const outside = join(value.base, 'outside');
  await mkdir(join(value.rootPath, 'parent'));
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel.txt'), 'outside');

  await rename(join(value.rootPath, 'parent'), join(value.rootPath, 'old-parent'));
  await symlink(outside, join(value.rootPath, 'parent'), 'dir');
  assert.throws(
    () => value.root.write('parent/sentinel.txt', Buffer.from('changed')),
    (error: NodeJS.ErrnoException) => error.code === 'ELOOP' || error.code === 'ENOTDIR',
  );

  await symlink(join(outside, 'sentinel.txt'), join(value.rootPath, 'leaf.txt'), 'file');
  assert.throws(() => value.root.openSource('leaf.txt'), { code: 'ELOOP' });
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');
});

test('a grant containing the private stage is rejected through aliases too', { skip: platform === 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-stage-mask-'));
  const stagePath = join(base, 'private-stage');
  const alias = join(tmpdir(), `dex-native-stage-alias-${process.pid}-${Date.now()}`);
  await mkdir(stagePath);
  await chmod(stagePath, 0o700);
  configureNativeFsStage(stagePath);
  await symlink(base, alias, 'dir');
  t.after(async () => { await rm(alias, { force: true }); await rm(base, { recursive: true, force: true }); });
  assert.throws(() => openNativeRoot(base), { code: 'EACCES' });
  assert.throws(() => openNativeRoot(alias), { code: 'EACCES' });
});

test('the stage cannot be configured inside an existing grant', { skip: platform === 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-stage-late-'));
  const rootPath = join(base, 'root');
  const outsideStage = join(base, 'outside-stage');
  const stagePath = join(rootPath, 'private-stage');
  await mkdir(rootPath);
  await mkdir(outsideStage);
  await mkdir(stagePath);
  await chmod(outsideStage, 0o700);
  await chmod(stagePath, 0o700);
  configureNativeFsStage(outsideStage);
  const root = openNativeRoot(rootPath);
  t.after(async () => { root.close(); await rm(base, { recursive: true, force: true }); });
  assert.throws(() => configureNativeFsStage(stagePath), { code: 'EACCES' });
});

test('the private stage and every grant must be disjoint in both directions', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-stage-disjoint-'));
  const stagePath = join(base, 'private-stage');
  const stageChild = join(stagePath, 'browser-private');
  await mkdir(stageChild, { recursive: true });
  await chmod(stagePath, 0o700);
  configureNativeFsStage(stagePath);
  assert.throws(() => openNativeRoot(stageChild), { code: 'EACCES' });

  const other = await mkdtemp(join(tmpdir(), 'dex-native-stage-parent-'));
  const rootPath = join(other, 'grant');
  await mkdir(rootPath);
  await chmod(other, 0o700);
  const root = openNativeRoot(rootPath);
  t.after(async () => {
    root.close();
    await rm(base, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });
  assert.throws(() => configureNativeFsStage(other), { code: 'EACCES' });
});

test('source reads are parallel and an in-place mutation with restored mtime is rejected', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const path = join(value.rootPath, 'source.bin');
  const bytes = Buffer.alloc(256 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  await writeFile(path, bytes);
  const before = await stat(path);
  const source = value.root.openSource('source.bin');
  t.after(() => source.close());
  const ranges = await Promise.all([
    Promise.resolve().then(() => source.read(0, 65536)),
    Promise.resolve().then(() => source.read(65536, 65536)),
    Promise.resolve().then(() => source.read(131072, 65536)),
    Promise.resolve().then(() => source.read(196608, 65536)),
  ]);
  assert.deepEqual(Buffer.concat(ranges.map((range) => Buffer.from(range))), bytes);
  await writeFile(path, Buffer.alloc(bytes.length, 9));
  await utimes(path, before.atime, before.mtime);
  assert.throws(() => source.read(0, 1), { code: 'FILE_SOURCE_CHANGED' });
});

test('atomic no-replace loses safely to a concurrent target creator', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const target = join(value.rootPath, 'result.bin');
  const racer = spawn(process.execPath, ['-e', `
    const fs=require('node:fs');
    const stage=${JSON.stringify(value.stagePath)};
    const target=${JSON.stringify(target)};
    process.stdout.write('ready\\n');
    const end=Date.now()+5000;
    while(Date.now()<end){
      if(fs.readdirSync(stage).length){
        try{fs.writeFileSync(target,'racer',{flag:'wx'});}catch{}
        process.exit(0);
      }
    }
    process.exit(2);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  await waitReady(racer);
  assert.throws(
    () => value.root.atomicWrite('result.bin', Buffer.alloc(64 * 1024 * 1024, 3), false),
    { code: 'EEXIST' },
  );
  assert.equal(await new Promise<number | null>((resolve) => racer.on('exit', resolve)), 0);
  assert.equal(await readFile(target, 'utf8'), 'racer');
});

test('conditional replace, native copy, rename and quarantine stay rooted', async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  await writeFile(join(value.rootPath, 'source.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
  await writeFile(join(value.rootPath, 'edited.txt'), 'first');
  const opened = value.root.openSource('edited.txt');
  const expected = opened.identity();
  opened.close();
  value.root.write('edited.txt', Buffer.from('other'));
  assert.throws(
    () => value.root.atomicWrite('edited.txt', Buffer.from('stale editor'), true, expected),
    { code: 'FILE_SOURCE_CHANGED' },
  );
  assert.equal(await readFile(join(value.rootPath, 'edited.txt'), 'utf8'), 'other');
  if (platform !== 'win32') {
    await chmod(join(value.rootPath, 'edited.txt'), 0o751);
    const current = value.root.openSource('edited.txt');
    const currentIdentity = current.identity();
    current.close();
    value.root.atomicWrite('edited.txt', Buffer.from('saved'), true, currentIdentity);
    assert.equal((await stat(join(value.rootPath, 'edited.txt'))).mode & 0o777, 0o751);
    assert.equal(await readFile(join(value.rootPath, 'edited.txt'), 'utf8'), 'saved');
  }

  value.root.mkdirs('nested');
  value.root.copyFileNoReplace('source.bin', 'nested/copied.bin');
  assert.deepEqual(
    await readFile(join(value.rootPath, 'nested', 'copied.bin')),
    Buffer.alloc(2 * 1024 * 1024, 7),
  );
  value.root.renameNoReplace('nested/copied.bin', 'nested/renamed.bin');
  assert.throws(() => value.root.renameNoReplace('source.bin', 'nested/renamed.bin'), { code: 'EEXIST' });

  const quarantined = value.root.moveToStage('nested');
  assert.equal(dirname(quarantined), value.stagePath);
  await assert.rejects(readFile(join(value.rootPath, 'nested', 'renamed.bin')), { code: 'ENOENT' });
  assert.equal((await readFile(join(quarantined, 'renamed.bin'))).byteLength, 2 * 1024 * 1024);
});

test('expected in-place write retains the file object and rejects stale content', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const path = join(value.rootPath, 'editor.sh');
  await writeFile(path, 'old');
  await chmod(path, 0o751);
  if (platform === 'darwin') execFileSync('xattr', ['-w', 'com.xgen.native-save-test', 'retained', path]);
  const before = await stat(path);
  const source = value.root.openSource('editor.sh');
  const identity = source.identity();
  source.close();
  value.root.writeExpected('editor.sh', Buffer.from('updated'), identity);
  const after = await stat(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, 0o751);
  if (platform === 'darwin') {
    assert.equal(execFileSync('xattr', ['-p', 'com.xgen.native-save-test', path], { encoding: 'utf8' }).trimEnd(), 'retained');
  }
  assert.equal(await readFile(path, 'utf8'), 'updated');
  assert.throws(() => value.root.writeExpected('editor.sh', Buffer.from('stale'), identity), { code: 'FILE_SOURCE_CHANGED' });
  assert.equal(await readFile(path, 'utf8'), 'updated');
});

test('rooted copy retains ordinary source permission bits', { skip: platform === 'win32' }, async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  await writeFile(join(value.rootPath, 'run.sh'), '#!/bin/sh\n');
  await chmod(join(value.rootPath, 'run.sh'), 0o754);
  value.root.copyFileNoReplace('run.sh', 'copy.sh');
  assert.equal((await stat(join(value.rootPath, 'copy.sh'))).mode & 0o777, 0o754);
});

test('a separate filesystem gets a private stage outside every grant', { skip: platform !== 'linux' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-cross-volume-'));
  const defaultStage = join(base, 'default-stage');
  await mkdir(defaultStage, { mode: 0o700 });
  configureNativeFsStage(defaultStage);
  const mount = process.env.DEX_NATIVE_SECOND_VOLUME || '/dev/shm';
  let external: string;
  try {
    external = await mkdtemp(join(mount, 'dex-native-cross-volume-'));
  } catch {
    t.skip('no writable second filesystem');
    await rm(base, { recursive: true, force: true });
    return;
  }
  t.after(async () => {
    await rm(external, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });
  if ((await stat(external)).dev === (await stat(defaultStage)).dev) {
    t.skip('candidate path is on the default filesystem');
    return;
  }
  const rootPath = join(external, 'grant');
  await mkdir(rootPath);
  const root = openNativeRoot(rootPath);
  t.after(() => root.close());
  root.atomicWrite('created.txt', Buffer.from('created'), false);
  await writeFile(join(rootPath, 'trash.txt'), 'trash');
  const moved = root.moveToStage('trash.txt');
  assert.equal(await readFile(moved, 'utf8'), 'trash');
  assert.equal((await stat(moved)).dev, (await stat(rootPath)).dev);
  assert.equal((await stat(dirname(moved))).mode & 0o777, 0o700);
  assert.throws(() => openNativeRoot(external), { code: 'EACCES' });
});

test('quarantine rollback uses the pinned parent after root revocation and never overwrites a racer', async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const original = join(value.rootPath, 'old.txt');
  await writeFile(original, 'old');
  const transaction = value.root.beginQuarantine('old.txt');
  value.root.close();
  await writeFile(original, 'new');
  try {
    assert.throws(() => transaction.rollback(), { code: 'EEXIST' });
    assert.equal(await readFile(original, 'utf8'), 'new');
    assert.equal(await readFile(transaction.path, 'utf8'), 'old');
    await rm(original);
    transaction.rollback();
    assert.equal(await readFile(original, 'utf8'), 'old');
  } finally {
    transaction.close();
  }
});

test('the latest configured private stage is used on its filesystem', async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const latest = join(value.base, 'latest-stage');
  await mkdir(latest, { mode: 0o700 });
  configureNativeFsStage(latest);
  await writeFile(join(value.rootPath, 'entry.txt'), 'entry');
  const moved = value.root.moveToStage('entry.txt');
  assert.equal(dirname(moved), await realpath(latest));
});

test('trusted private-stage output reads stay pinned and never grant the stage subtree', async (t) => {
  const value = await fixture();
  closeFixture(t, value);
  const scratch = join(value.stagePath, 'browser-output');
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(join(scratch, 'capture.har'), 'capture');
  const source = openPrivateStageSource('browser-output/capture.har');
  t.after(() => source.close());
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'capture');
  assert.throws(() => openNativeRoot(scratch), { code: 'EACCES' });
  assert.throws(() => openPrivateStageSource('../capture.har'), { code: 'PATH_DOMAIN_MISMATCH' });
  if (platform !== 'win32') {
    await symlink(value.rootPath, join(scratch, 'outside'), 'dir');
    assert.throws(
      () => openPrivateStageSource('browser-output/outside/missing.txt'),
      (error: NodeJS.ErrnoException) => error.code === 'ELOOP' || error.code === 'ENOTDIR',
    );
  }
});
