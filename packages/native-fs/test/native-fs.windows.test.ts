import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv, platform } from 'node:process';
import { test } from 'node:test';
import { configureNativeFsStage, openNativeRoot, openPrivateStageSource } from '../src/index';

function securityScript(script: string, target: string): string {
  const modulePath = join(processEnv.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, target,
  ], { encoding: 'utf8', env: { ...processEnv, PSModulePath: modulePath } }).trim();
}

test('Windows root and source handles stay bound across pathname moves', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-move-'));
  const rootPath = join(base, 'root');
  const movedPath = join(base, 'moved');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  assert.throws(() => openNativeRoot(base), { code: 'EACCES' });
  await writeFile(join(rootPath, 'source.txt'), 'inside');
  const root = openNativeRoot(rootPath);
  const nodeStat = await stat(rootPath, { bigint: true });
  assert.equal(root.dev, nodeStat.dev.toString());
  assert.equal(root.ino, nodeStat.ino.toString());
  let source: ReturnType<typeof root.openSource> | undefined = root.openSource('source.txt');
  t.after(async () => { source?.close(); root.close(); await rm(base, { recursive: true, force: true }); });

  await assert.rejects(rename(rootPath, movedPath), (error: unknown) =>
    ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''));
  source.close();
  source = undefined;
  await rename(rootPath, movedPath);
  await mkdir(rootPath);
  await writeFile(join(rootPath, 'source.txt'), 'outside');
  source = root.openSource('source.txt');
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'inside');
  root.write('created.txt', Buffer.from('created'));
  assert.equal(await readFile(join(movedPath, 'created.txt'), 'utf8'), 'created');
  assert.equal(await readFile(join(rootPath, 'source.txt'), 'utf8'), 'outside');

  await rename(join(movedPath, 'source.txt'), join(movedPath, 'renamed.txt'));
  assert.throws(() => source.read(0, 1), { code: 'FILE_SOURCE_CHANGED' });
});

test('Windows configured stage is owned by the current user with a protected private DACL', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-stage-acl-'));
  const stagePath = join(base, 'stage');
  await mkdir(stagePath);
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  configureNativeFsStage(stagePath);
  const script = join(base, 'stage-security.ps1');
  await writeFile(script, `
param([string]$Folder)
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $Folder
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$trustees = @($acl.Access | ForEach-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
})
$private = @($trustees | Where-Object { $_ -ne $current -and $_ -ne 'S-1-5-18' }).Count -eq 0
Write-Output "$($acl.AreAccessRulesProtected)|$($owner -eq $current)|$private"
`);
  const actual = securityScript(script, stagePath);
  assert.equal(actual, 'True|True|True');
});

test('Windows source change time rejects restored-mtime mutation', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-source-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const path = join(rootPath, 'source.txt');
  await writeFile(path, 'first!');
  const initial = await stat(path);
  const root = openNativeRoot(rootPath);
  const source = root.openSource('source.txt');
  t.after(async () => { source.close(); root.close(); await rm(base, { recursive: true, force: true }); });
  await writeFile(path, 'second');
  await utimes(path, initial.atime, initial.mtime);
  assert.throws(() => source.read(0, 1), { code: 'FILE_SOURCE_CHANGED' });
});

test('Windows rooted copy, move, stage, and conditional atomic write use pinned objects', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-atomic-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  await writeFile(join(rootPath, 'source.txt'), 'first');
  const root = openNativeRoot(rootPath);
  t.after(async () => { root.close(); await rm(base, { recursive: true, force: true }); });

  root.copyFileNoReplace('source.txt', 'copy.txt');
  assert.equal(await readFile(join(rootPath, 'copy.txt'), 'utf8'), 'first');
  assert.throws(() => root.copyFileNoReplace('source.txt', 'copy.txt'), { code: 'EEXIST' });
  root.renameNoReplace('copy.txt', 'renamed.txt');
  assert.equal(await readFile(join(rootPath, 'renamed.txt'), 'utf8'), 'first');
  assert.throws(() => root.renameNoReplace('source.txt', 'renamed.txt'), { code: 'EEXIST' });

  const expectedSource = root.openSource('renamed.txt');
  const expected = expectedSource.identity();
  expectedSource.close();
  root.atomicWrite('renamed.txt', Buffer.from('second'), true, expected);
  assert.equal(await readFile(join(rootPath, 'renamed.txt'), 'utf8'), 'second');
  assert.throws(() => root.atomicWrite('renamed.txt', Buffer.from('third'), true, expected), { code: 'FILE_SOURCE_CHANGED' });
  const stagedPath = root.moveToStage('renamed.txt');
  assert.equal(await readFile(stagedPath, 'utf8'), 'second');
  await assert.rejects(readFile(join(rootPath, 'renamed.txt')), { code: 'ENOENT' });
});


test('Windows atomic replacement preserves an existing custom DACL', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-acl-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const target = join(rootPath, 'shared.txt');
  await writeFile(target, 'before');
  const root = openNativeRoot(rootPath);
  t.after(async () => { root.close(); await rm(base, { recursive: true, force: true }); });

  // Everyone is an unambiguous well-known SID even on localized Windows hosts.
  execFileSync('icacls.exe', [target, '/grant', '*S-1-1-0:R']);
  const aclScript = join(base, 'acl.ps1');
  await writeFile(aclScript, `
param([string]$File)
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $File
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$grants = @($acl.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0'
} | ForEach-Object { "$( $_.FileSystemRights ):$( $_.AccessControlType ):$( $_.IsInherited )" })
Write-Output "$owner|$($grants -join ';')"
`);
  const security = (): string => securityScript(aclScript, target);
  const before = security();
  assert.match(before, /\|[^|]+/);
  root.atomicWrite('shared.txt', Buffer.from('after'), true);
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.equal(security(), before);
});

test('Windows atomic replacement retains DACL inheritance from the target parent', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-inherit-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const target = join(rootPath, 'inherited.txt');
  t.after(async () => { await rm(base, { recursive: true, force: true }); });

  // Make an inheritable grant whose later removal has an observable effect.
  execFileSync('icacls.exe', [rootPath, '/inheritance:d']);
  execFileSync('icacls.exe', [rootPath, '/remove:g', '*S-1-1-0']);
  execFileSync('icacls.exe', [rootPath, '/grant', '*S-1-1-0:(OI)(CI)R']);
  await writeFile(target, 'before');
  const root = openNativeRoot(rootPath);
  t.after(() => root.close());

  const aclScript = join(base, 'inheritance.ps1');
  await writeFile(aclScript, `
param([string]$File)
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $File
$inheritedEveryone = @($acl.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' -and
  $_.IsInherited -and $_.AccessControlType -eq 'Allow'
})
Write-Output "$($acl.AreAccessRulesProtected)|$($inheritedEveryone.Count)"
`);
  const security = (): string => securityScript(aclScript, target);
  const before = security();
  assert.match(before, /^False\|[1-9]\d*$/);

  root.atomicWrite('inherited.txt', Buffer.from('after'), true);
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.equal(security(), before);

  execFileSync('icacls.exe', [rootPath, '/remove:g', '*S-1-1-0']);
  assert.equal(security(), 'False|0');
});

test('Windows expected write mutates the held file without replacing its identity', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-expected-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const target = join(rootPath, 'editor.txt');
  await writeFile(target, 'before');
  const root = openNativeRoot(rootPath);
  t.after(async () => { root.close(); await rm(base, { recursive: true, force: true }); });

  const source = root.openSource('editor.txt');
  const expected = source.identity();
  source.close();
  const before = await stat(target, { bigint: true });
  root.writeExpected('editor.txt', Buffer.from('after'), expected);
  const after = await stat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.throws(() => root.writeExpected('editor.txt', Buffer.from('stale'), expected),
    { code: 'FILE_SOURCE_CHANGED' });
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('Windows provisions a private stage on a different target volume', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-volume-'));
  const stagePath = join(base, 'stage');
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const defaultVolume = (await stat(base, { bigint: true })).dev;
  let other: string | undefined;
  for (let letter = 68; letter <= 90; letter += 1) {
    const drive = `${String.fromCharCode(letter)}:\\`;
    try {
      if ((await stat(drive, { bigint: true })).dev === defaultVolume) continue;
      other = await mkdtemp(join(drive, 'dex-native-win-volume-'));
      break;
    } catch { /* Drive absent or not writable. */ }
  }
  t.after(async () => {
    if (other) await rm(other, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });
  if (!other) return t.skip('No second writable volume is available');
  const rootPath = join(other, 'root');
  await mkdir(rootPath);
  const root = openNativeRoot(rootPath);
  t.after(() => root.close());
  root.atomicWrite('created.txt', Buffer.from('content'), false);
  assert.equal(await readFile(join(rootPath, 'created.txt'), 'utf8'), 'content');
  const moved = root.moveToStage('created.txt');
  assert.equal((await stat(moved, { bigint: true })).dev, (await stat(rootPath, { bigint: true })).dev);
  assert.equal(await readFile(moved, 'utf8'), 'content');
  assert.throws(() => openNativeRoot(other), { code: 'EACCES' });
});

test('Windows quarantine rollback uses pinned handles after root closure and keeps collision retryable', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-quarantine-'));
  const rootPath = join(base, 'root');
  const stagePath = join(base, 'stage');
  await mkdir(rootPath);
  await mkdir(stagePath);
  configureNativeFsStage(stagePath);
  const original = join(rootPath, 'old.txt');
  await writeFile(original, 'old');
  const root = openNativeRoot(rootPath);
  t.after(async () => { root.close(); await rm(base, { recursive: true, force: true }); });

  const quarantine = root.beginQuarantine('old.txt');
  assert.equal(await readFile(quarantine.path, 'utf8'), 'old');
  root.close();
  await writeFile(original, 'new');
  assert.throws(() => quarantine.rollback(), { code: 'EEXIST' });
  assert.equal(await readFile(original, 'utf8'), 'new');
  assert.equal(await readFile(quarantine.path, 'utf8'), 'old');
  await rm(original);
  quarantine.rollback();
  assert.equal(await readFile(original, 'utf8'), 'old');
  await assert.rejects(readFile(quarantine.path), { code: 'ENOENT' });
  quarantine.close();
});

test('Windows private-stage browser source reads only regular no-follow descendants', { skip: platform !== 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dex-native-win-browser-'));
  const stagePath = join(base, 'stage');
  const browserPath = join(stagePath, 'browser-output');
  await mkdir(stagePath);
  await mkdir(browserPath);
  configureNativeFsStage(stagePath);
  await writeFile(join(browserPath, 'capture.har'), 'captured');
  t.after(async () => { await rm(base, { recursive: true, force: true }); });

  const source = openPrivateStageSource('browser-output/capture.har');
  assert.equal(Buffer.from(source.read(0, source.size)).toString(), 'captured');
  source.close();
  assert.throws(() => openPrivateStageSource('../outside'), { code: 'PATH_DOMAIN_MISMATCH' });

  const outside = join(base, 'outside.txt');
  await writeFile(outside, 'outside');
  try {
    await symlink(outside, join(browserPath, 'link.txt'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  assert.throws(() => openPrivateStageSource('browser-output/link.txt'), { code: 'ELOOP' });
});
