import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DexRpcClient, DexRpcError } from '../src/client';

const fixture = fileURLToPath(new URL('./fixtures/native-picker-engine.mjs', import.meta.url));

test('spawned RPC client negotiates the constructor chooser and keeps selected paths out of native results/logs', async () => {
  const logs: string[] = []; let choices = 0;
  const client = new DexRpcClient({ process: { command: process.execPath, args: [fixture] }, clientVersion: 'test',
    log: (value) => logs.push(value), nativeAttachmentPicker: async (_signal, limits) => {
      assert.deepEqual(limits, { max_files: 2, max_bytes: 8 }); choices++; return ['/private/chosen.bin'];
    } });
  try {
    assert.equal((await client.start()).capabilities.nativePlatformSession?.canonicalAttachments, true);
    const reply = await client.request('native/pick-attachments');
    assert.deepEqual(reply, { filenames: ['chosen.bin'] }); assert.equal(choices, 1);
    assert.equal(JSON.stringify([logs, reply]).includes('/private/chosen.bin'), false);
  } finally { await client.stop(); }
});

test('spawned RPC cancellation suppresses late dialog success and prevents overlapping native dialogs', async () => {
  let entered!: () => void; let finish!: (paths: readonly string[]) => void; let signal!: AbortSignal; let choices = 0;
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<readonly string[]>((resolve) => { finish = resolve; });
  const client = new DexRpcClient({ process: { command: process.execPath, args: [fixture] }, clientVersion: 'test',
    nativeAttachmentPicker: async (value) => { choices++; signal = value; entered(); return waiting; } });
  try {
    await client.start();
    const pending = client.request('native/pick-attachments');
    const failed = assert.rejects(pending, DexRpcError);
    await called; await client.request('native/cancel'); await failed;
    assert.equal(signal.aborted, true);
    await assert.rejects(client.request('native/pick-attachments'), DexRpcError); assert.equal(choices, 1);
    finish(['/private/late.bin']); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await client.request('health'), { ok: true });
  } finally { await client.stop(); }
});

test('RPC process restart retires an old chooser response before a new process may accept paths', async () => {
  let entered!: () => void; let fail!: (error: Error) => void; let signal!: AbortSignal; let choices = 0;
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<readonly string[]>((_resolve, reject) => { fail = reject; });
  const logs: string[] = [];
  const client = new DexRpcClient({ process: { command: process.execPath, args: [fixture] }, clientVersion: 'test',
    log: (value) => logs.push(value), nativeAttachmentPicker: async (value) => {
      choices++; if (choices > 1) return [];
      signal = value; entered(); return waiting;
    } });
  try {
    await client.start();
    const pending = client.request('native/pick-attachments'); const failed = assert.rejects(pending, DexRpcError);
    await called; await client.restart(); await failed; assert.equal(signal.aborted, true);
    await assert.rejects(client.request('native/pick-attachments'), DexRpcError); assert.equal(choices, 1);
    fail(new Error('/private/old-process-secret')); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await client.request('native/pick-attachments'), { filenames: [] }); assert.equal(choices, 2);
    assert.equal(JSON.stringify(logs).includes('old-process-secret'), false);
  } finally { await client.stop(); }
});
