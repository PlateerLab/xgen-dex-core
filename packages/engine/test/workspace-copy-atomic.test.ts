import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWorkspaceWrite } from '@dex/engine/atomic-workspace-write';
import {
  RootGrant,
  configureNativeFsStage,
  resolveRootedPath,
} from '@dex/engine/rooted-fs';

async function fixture(): Promise<{ base: string; root: string; stage: string; grant: RootGrant }> {
  const base = await mkdtemp(join(tmpdir(), 'xgen-native-atomic-'));
  const root = join(base, 'root');
  const stage = join(base, 'stage');
  await mkdir(root);
  await mkdir(stage);
  await chmod(stage, 0o700);
  configureNativeFsStage(stage);
  return { base, root, stage, grant: new RootGrant(root) };
}

async function target(grant: RootGrant, root: string, name = 'saved.txt') {
  return resolveRootedPath(name, root, [grant], { allowMissing: true });
}

async function childReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`racer exited before ready (${code})`)));
  });
}

test('native private stage commits without exposing staging names in the grant', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await atomicWorkspaceWrite(await target(value.grant, value.root), Buffer.from('PAYLOAD'), { overwrite: false });
  assert.equal(await readFile(join(value.root, 'saved.txt'), 'utf8'), 'PAYLOAD');
  assert.deepEqual(await readdir(value.stage), []);
  assert.deepEqual(value.grant.list('').map((entry) => entry.name), ['saved.txt']);
});

test('native no-replace preserves an existing target', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await writeFile(join(value.root, 'saved.txt'), 'EXISTING');
  await assert.rejects(
    atomicWorkspaceWrite(await target(value.grant, value.root), Buffer.from('PAYLOAD'), { overwrite: false }),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
  assert.equal(await readFile(join(value.root, 'saved.txt'), 'utf8'), 'EXISTING');
  assert.deepEqual(await readdir(value.stage), []);
});

test('native no-replace loses safely to a target racer', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  const targetPath = join(value.root, 'saved.txt');
  const racer = spawn(process.execPath, ['-e', `
    const fs=require('fs');
    const stage=${JSON.stringify(value.stage)};
    const target=${JSON.stringify(targetPath)};
    process.stdout.write('ready\\n');
    const end=Date.now()+5000;
    while(Date.now()<end){
      if(fs.readdirSync(stage).length){
        try{fs.writeFileSync(target,'RACER',{flag:'wx'});}catch{}
        process.exit(0);
      }
    }
    process.exit(2);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  await childReady(racer);
  const payload = Buffer.alloc(64 * 1024 * 1024, 7);
  await assert.rejects(
    atomicWorkspaceWrite(await target(value.grant, value.root), payload, { overwrite: false }),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
  assert.equal(await new Promise<number | null>((resolve) => racer.on('exit', resolve)), 0);
  assert.equal(await readFile(targetPath, 'utf8'), 'RACER');
  assert.deepEqual(await readdir(value.stage), []);
});

test('tampering with the private stage name fails closed', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  const targetPath = join(value.root, 'saved.txt');
  const racer = spawn(process.execPath, ['-e', `
    const fs=require('fs'),p=require('path');
    const stage=${JSON.stringify(value.stage)};
    process.stdout.write('ready\\n');
    const end=Date.now()+5000;
    while(Date.now()<end){
      const names=fs.readdirSync(stage);
      if(names.length){
        const original=p.join(stage,names[0]);
        try{fs.renameSync(original,p.join(stage,'moved-by-racer'));fs.writeFileSync(original,'REPLACEMENT',{flag:'wx'});process.exit(0);}catch{}
      }
    }
    process.exit(2);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  await childReady(racer);
  await assert.rejects(
    atomicWorkspaceWrite(await target(value.grant, value.root), Buffer.alloc(64 * 1024 * 1024, 9), { overwrite: true }),
    (error: NodeJS.ErrnoException) => error.code === 'EIO',
  );
  assert.equal(await new Promise<number | null>((resolve) => racer.on('exit', resolve)), 0);
  await assert.rejects(readFile(targetPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('native overwrite consumes the private stage name and replaces the target', async (t) => {
  const value = await fixture();
  t.after(async () => { value.grant.close(); await rm(value.base, { recursive: true, force: true }); });
  await writeFile(join(value.root, 'saved.txt'), 'OLD');
  await atomicWorkspaceWrite(await target(value.grant, value.root), Buffer.from('NEW'), { overwrite: true });
  assert.equal(await readFile(join(value.root, 'saved.txt'), 'utf8'), 'NEW');
  assert.deepEqual(await readdir(value.stage), []);
});
