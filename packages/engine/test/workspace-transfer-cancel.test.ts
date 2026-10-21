import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolProvider, COPY_FROM_WORKSPACE_TOOL, COPY_TO_WORKSPACE_TOOL } from '../src/local-tools';
import { normalizeLocalFolders } from '../src/local-folders';
import { clientWorkspaceTransfer } from '../src/workspace-transfer';
import { fileSource } from '../src/file-source';
import type { XgenClient } from '@dex/protocol';
import { bindTestHost } from './_host';

bindTestHost();

const context = {
  workflowId: 'owned', interactionId: 'owned', deviceId: 'device-1', requestId: 'request-1',
  requestNonce: 'nonce-1', connectionGeneration: 7, protocol: 2 as const,
};
const capability = (direction: 'to_workspace' | 'from_workspace') => ({
  token: 'synthetic', direction, workflow_id: 'owned', interaction_id: 'owned',
  device_id: 'device-1', request_id: 'request-1', request_nonce: 'nonce-1',
  connection_generation: 7, protocol: 2 as const,
});

test('aborted download never commits target bytes even when the adapter returns late', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2-copy-cancel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'result.txt'); await writeFile(target, 'original target');
  const provider = new LocalToolProvider(); provider.configureFolders(() => normalizeLocalFolders([root]));
  const abort = new AbortController();
  let resolveDownload: (bytes: Uint8Array) => void = () => {};
  let started: () => void = () => {}; const ready = new Promise<void>((resolve) => { started = resolve; });
  provider.configureWorkspaceTransfer({ upload: async () => ({ path: '', size: 0 }), download: (input) => {
    assert.equal(input.signal, abort.signal); started(); return new Promise((resolve) => { resolveDownload = resolve; });
  } });
  const pending = provider.callTool(COPY_FROM_WORKSPACE_TOOL, {
    path: target,
    overwrite: true,
    download: {
      url: '/api/agentflow/files/artifacts/owned/download', token: 'synthetic', name: 'result.txt',
    },
    _workspace_transfer: capability('from_workspace'),
  }, { ...context, signal: abort.signal });
  await ready; abort.abort(); resolveDownload(new TextEncoder().encode('new bytes'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await readFile(target, 'utf8'), 'original target');
  assert.deepEqual(await readdir(root), ['result.txt']);
});

test('upload cancellation stops subsequent files and range reads', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2-copy-upload-cancel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'A'); await writeFile(join(root, 'b.txt'), 'B');
  const provider = new LocalToolProvider(); provider.configureFolders(() => normalizeLocalFolders([root]));
  const abort = new AbortController(); let uploads = 0;
  provider.configureWorkspaceTransfer({ download: async () => new Uint8Array(), upload: async (input) => {
    uploads++; assert.equal(input.signal, abort.signal); abort.abort();
    await assert.rejects(input.file.read(0, 1), { name: 'AbortError' });
    return { path: 'already-accepted-first-file', size: 1 };
  } });
  await assert.rejects(provider.callTool(COPY_TO_WORKSPACE_TOOL, {
    paths: ['a.txt', 'b.txt'], _workspace_transfer: capability('to_workspace'),
  }, { ...context, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(uploads, 1); // Earlier accepted commits are not promised rolled back.
});

test('host transfer adapter forwards the same signal and bounded response size', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2-copy-adapter-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'a.txt'); await writeFile(path, 'A');
  const signal = new AbortController().signal;
  const client = {
    agentData: { workspaceUpload: async (...args: unknown[]) => {
      const options = args[6] as { signal?: AbortSignal; transfer?: { token?: string } };
      assert.equal(options.signal, signal); assert.equal(options.transfer?.token, 'synthetic');
      return { workspace_path: 'uploads/owned/a.txt', size: 1 };
    } },
    chatFiles: { artifactBytes: async (_url: string, _token: string, options: {
      signal: AbortSignal; maxBytes: number; workspaceTransferToken: string;
    }) => {
      assert.equal(options.signal, signal); assert.equal(options.maxBytes, 100 * 1024 * 1024);
      assert.equal(options.workspaceTransferToken, 'synthetic');
      return { bytes: new Uint8Array([1]) };
    } },
  } as unknown as XgenClient;
  const transfer = clientWorkspaceTransfer(() => client);
  await transfer.upload({
    transfer: capability('to_workspace'), file: await fileSource(path), name: 'a.txt',
    relDir: '', mimeType: 'text/plain', signal,
  });
  assert.equal((await transfer.download({
    url: '/api/agentflow/files/artifacts/owned/download', token: 'synthetic',
    transfer: capability('from_workspace'), signal,
  }))[0], 1);
});
