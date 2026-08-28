import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalToolProvider, isDangerousCommand, localToolSchemas } from '../src/local-tools';

function textOf(result: Awaited<ReturnType<LocalToolProvider['call']>>): string {
  return result.content.map((item) => item.text).join('\n');
}

test('local structured tools stay inside allowed roots and support project files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-local-tools-'));
  const provider = new LocalToolProvider({
    enabled: true,
    cwd: directory,
    timeoutMs: 10_000,
    allowedRoots: [directory],
    blockedCommands: [],
    allowDangerous: false,
  });
  try {
    const file = join(directory, 'nested', 'hello.txt');
    assert.match(textOf(await provider.call('WriteFile', { path: file, content: 'hello XGEN\n' })), /저장했습니다/);
    assert.equal(textOf(await provider.call('ReadFile', { path: file })), 'hello XGEN\n');
    assert.match(textOf(await provider.call('ListDir', { path: join(directory, 'nested') })), /hello\.txt/);
    assert.match(textOf(await provider.call('Search', { path: directory, query: 'XGEN' })), /hello\.txt:1/);
    await assert.rejects(() => provider.call('ReadFile', { path: join(directory, '..', 'outside.txt') }), /허용된 로컬 경로/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Shell runs non-interactively and rejects blocked or destructive commands by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-local-shell-'));
  const provider = new LocalToolProvider({
    enabled: true,
    cwd: directory,
    timeoutMs: 10_000,
    allowedRoots: [directory],
    blockedCommands: ['sudo'],
    allowDangerous: false,
  });
  try {
    assert.match(textOf(await provider.call('Shell', { command: "printf 'hello-local'" })), /hello-local/);
    await assert.rejects(() => provider.call('Shell', { command: 'sudo echo no' }), /차단된 명령/);
    await assert.rejects(() => provider.call('Shell', { command: 'rm -rf ./data' }), /되돌리기 어려운/);
    assert.equal(isDangerousCommand('npm test'), false);
    assert.equal(isDangerousCommand('git push --force origin main'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local tool catalog exposes stable XGEN bridge tool names', () => {
  assert.deepEqual(
    localToolSchemas().map((tool) => tool.name),
    ['Shell', 'ReadFile', 'WriteFile', 'ListDir', 'Search', 'Open'],
  );
});
