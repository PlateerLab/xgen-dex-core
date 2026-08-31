import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DexRpcClient, DexRpcError } from '../src/rpc-client';
import type { RpcNotification } from '../src/protocol';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDirectory, 'fixtures', 'rpc-engine.mjs');

test('RPC client initializes, handles notifications and exposes engine errors', async () => {
  const client = new DexRpcClient({
    process: { command: process.execPath, args: [fixture] },
    clientVersion: 'test',
  });
  try {
    const initialized = await client.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.server.name, 'fixture-dex-cli');

    const notification = new Promise<RpcNotification>((resolve) => {
      const remove = client.onNotification((value) => {
        remove();
        resolve(value);
      });
    });
    const result = await client.request<{ value: string }>('echo', { value: 'hello' });
    assert.deepEqual(result, { value: 'hello' });
    assert.equal((await notification).method, 'fixture/event');

    await assert.rejects(
      () => client.request('fail'),
      (error: unknown) => error instanceof DexRpcError && error.engineCode === 'network_error',
    );
  } finally {
    await client.stop();
  }
  assert.equal(client.state, 'stopped');
});

const realCli = path.resolve(testDirectory, '..', '..', 'dist', 'cli.js');

test('RPC client connects to the built dex-cli engine', { skip: !existsSync(realCli) }, async () => {
  const isolatedHome = await mkdtemp(path.join(tmpdir(), 'xgen-dex-vscode-'));
  const client = new DexRpcClient({
    process: {
      command: process.execPath,
      args: [realCli, 'serve', '--stdio'],
      env: { ...process.env, DEX_CLI_HOME: isolatedHome },
    },
    clientVersion: 'test',
  });
  try {
    const initialized = await client.start();
    assert.equal(initialized.server.name, 'dex-cli');
    assert.deepEqual(await client.request('health'), { ok: true, activeChats: 0 });
  } finally {
    await client.stop();
    await rm(isolatedHome, { recursive: true, force: true });
  }
});
