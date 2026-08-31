import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FileConfigStore,
  defaultConfig,
  validateProfileName,
  validateServerUrl,
} from '@dex/engine';

test('FileConfigStore atomically persists a versioned config with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-cli-config-'));
  try {
    const path = join(directory, 'config.json');
    const store = new FileConfigStore(path);
    assert.deepEqual(await store.read(), defaultConfig());
    const config = {
      version: 1 as const,
      currentProfile: 'corp',
      profiles: { corp: { serverUrl: 'https://xgen.example.com' } },
      localTools: {
        enabled: true,
        cwd: directory,
        timeoutMs: 30_000,
        allowedRoots: [directory],
        blockedCommands: ['sudo'],
        allowDangerous: false,
      },
    };
    await store.write(config);
    assert.deepEqual(await store.read(), config);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile names and server URLs are constrained at the config boundary', () => {
  assert.equal(validateProfileName('corp-dev_1'), 'corp-dev_1');
  assert.throws(() => validateProfileName('../corp'), /프로필 이름/);
  assert.equal(validateServerUrl('https://xgen.example.com/'), 'https://xgen.example.com');
  assert.throws(() => validateServerUrl('file:///tmp/xgen'), /http:\/\//);
  assert.throws(() => validateServerUrl('https://user:pw@xgen.example.com'), /자격 증명/);
});

test('existing version 1 config files receive safe local tool defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-cli-config-migrate-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        currentProfile: 'corp',
        profiles: { corp: { serverUrl: 'https://xgen.example.com' } },
      }),
      'utf8',
    );
    const config = await new FileConfigStore(path).read();
    assert.equal(config.localTools.enabled, false);
    assert.equal(config.localTools.allowDangerous, false);
    assert.deepEqual(config.localTools.allowedRoots, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
