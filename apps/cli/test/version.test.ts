import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const versionFiles = [
  'scripts/version.mjs', 'package.json', 'package-lock.json',
  ...['engine', 'ide', 'native-fs', 'protocol', 'rpc'].map((name) => `packages/${name}/package.json`),
  ...['cli', 'vscode', 'desktop', 'mobile', 'xd'].map((name) => `apps/${name}/package.json`),
  ...['desktop', 'mobile', 'xd'].map((name) => `apps/${name}/package-lock.json`),
  'apps/mobile/app.json', 'apps/mobile/ios/XGENDex/Info.plist',
];

test('release set synchronizes the private native workspace and exact dependency without changing third-party packages', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dex-version-')));
  const readJson = async (rel: string) => JSON.parse(await readFile(join(temporary, rel), 'utf8'));
  const writeJson = (rel: string, value: unknown) => writeFile(join(temporary, rel), `${JSON.stringify(value, null, 2)}\n`);
  const run = (...args: string[]) => execFileSync(process.execPath, [join(temporary, 'scripts/version.mjs'), ...args], { encoding: 'utf8' }).trim();
  try {
    for (const rel of versionFiles) {
      await mkdir(dirname(join(temporary, rel)), { recursive: true });
      await copyFile(join(repo, rel), join(temporary, rel));
    }
    const current = (await readJson('package.json')).version;
    const [major, minor] = current.split('.').map(Number);
    const next = `${major}.${minor + 1}.0`;
    const originalLock = await readJson('package-lock.json');
    const external = (lock: typeof originalLock) => Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key.includes('node_modules/')));
    const native = await readJson('packages/native-fs/package.json');
    native.version = '0.0.1';
    await writeJson('packages/native-fs/package.json', native);
    assert.equal(spawnSync(process.execPath, [join(temporary, 'scripts/version.mjs'), 'check']).status, 1, 'a stale private native package fails preflight');
    assert.equal(run('set', 'minor'), next);
    assert.match(run('check'), new RegExp(next.replaceAll('.', '\\.')));
    assert.equal((await readJson('packages/native-fs/package.json')).version, next);
    const engine = await readJson('packages/engine/package.json');
    assert.equal(engine.dependencies['@dex/native-fs'], next);
    const lock = await readJson('package-lock.json');
    assert.equal(lock.packages['packages/native-fs'].version, next);
    assert.equal(lock.packages['packages/engine'].dependencies['@dex/native-fs'], next);
    assert.deepEqual(external(lock), external(originalLock));

    engine.dependencies['@dex/native-fs'] = current;
    await writeJson('packages/engine/package.json', engine);
    assert.equal(spawnSync(process.execPath, [join(temporary, 'scripts/version.mjs'), 'check']).status, 1, 'a stale exact workspace dependency fails preflight');
    run('set', next);
    lock.packages['packages/engine'].dependencies['@dex/native-fs'] = current;
    await writeJson('package-lock.json', lock);
    assert.equal(spawnSync(process.execPath, [join(temporary, 'scripts/version.mjs'), 'check']).status, 1, 'a stale locked dependency fails preflight');
    run('set', next);
    run('check');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
