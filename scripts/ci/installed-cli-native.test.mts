import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('fresh npm-installed CLI loads its packaged native boundary and confines real file tools', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dex-installed-native-'));
  const prefix = join(temporary, 'prefix');
  const grant = join(temporary, 'grant');
  const outside = join(temporary, 'outside');
  const cliHome = join(temporary, 'private-cli');
  const env = { ...process.env, DEX_CLI_HOME: cliHome, DEX_NO_KEYCHAIN: '1', npm_config_cache: join(temporary, 'npm-cache') };
  try {
    await mkdir(grant); await mkdir(outside);
    await writeFile(join(outside, 'sentinel.txt'), 'outside sentinel');
    const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
      { cwd: join(repo, 'apps/cli'), env, encoding: 'utf8', shell: process.platform === 'win32' }));
    execFileSync(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', join(temporary, packed[0].filename)],
      { env, stdio: 'pipe', shell: process.platform === 'win32' });
    const installed = join(prefix, 'node_modules', 'xgen-dex-cli');
    const cli = join(installed, 'dist/cli.js');
    const triple = `${process.platform}-${process.arch}`;
    const manifest = JSON.parse(await readFile(join(installed, 'dist/native/manifest.json'), 'utf8'));
    const binary = await readFile(join(installed, 'dist/native', triple, 'native-fs.node'));
    assert.equal(createHash('sha256').update(binary).digest('hex'), manifest[triple]);
    const run = (tool: string, args: object, fail = false) => {
      try {
        const output = execFileSync(process.execPath, [cli, 'tools', 'run', tool, '--folder', grant, '--args', JSON.stringify(args), '--json'],
          { cwd: grant, env, encoding: 'utf8' });
        assert.equal(fail, false, `unexpected tool success: ${tool}`);
        const result = JSON.parse(output); assert.ok(!result.isError, output);
        return output;
      } catch (error) {
        if (!fail) throw error;
        assert.ok((error as { status?: number }).status, 'must be a real CLI failure');
        return '';
      }
    };
    run('WriteFile', { path: 'safe.txt', content: 'native intended bytes' });
    assert.equal(await readFile(join(grant, 'safe.txt'), 'utf8'), 'native intended bytes');
    assert.match(run('ReadFile', { path: 'safe.txt' }), /native intended bytes/);
    assert.match(run('ListDir', { path: '.' }), /safe.txt/);
    assert.match(run('Search', { path: '.', query: 'native intended' }), /safe.txt/);
    await symlink(outside, join(grant, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    run('ReadFile', { path: 'escape/sentinel.txt' }, true);
    run('WriteFile', { path: 'escape/sentinel.txt', content: 'changed' }, true);
    await writeFile(join(cliHome, 'native-stage', 'private.txt'), 'private stage sentinel');
    run('ReadFile', { path: '../private-cli/native-stage/private.txt' }, true);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
