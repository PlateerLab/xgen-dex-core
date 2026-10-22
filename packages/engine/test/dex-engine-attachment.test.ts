import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResumableSource } from '@dex/protocol';
import { DexEngine } from '../src/dex-engine';
import { DexError } from '../src/errors';
import { FileSourceChangedError } from '../src/file-source';

type UploadClient = {
  agentData: {
    workspaceUpload: (
      workflowId: string,
      source: ResumableSource,
      filename: string,
      mimeType: string,
      interactionId: string,
    ) => Promise<{ workspace_path: string; size: number }>;
  };
};

function attachmentEngine(client: UploadClient): DexEngine {
  const engine = Object.create(DexEngine.prototype) as DexEngine;
  Object.defineProperty(engine, 'withAuthRetry', {
    value: async (_profile: string | undefined, operation: (value: UploadClient) => Promise<unknown>) =>
      operation(client),
  });
  return engine;
}

test('chat attachment sniffs and uploads bytes from one file identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-attachment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.bin');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await writeFile(path, png);
  let uploaded: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const engine = attachmentEngine({
    agentData: {
      async workspaceUpload(_workflowId, source, _filename, mimeType) {
        assert.equal(mimeType, 'image/png');
        assert.equal(source.type, 'image/png');
        uploaded = await source.read(0, source.size);
        return { workspace_path: 'uploads/owned/image.bin', size: source.size };
      },
    },
  });
  const result = await engine.uploadChatAttachment({ workflowId: 'wf', interactionId: 'chat', path });
  assert.deepEqual(uploaded, png);
  assert.equal(result.kind, 'image');
  assert.equal(result.mime_type, 'image/png');
});

test('chat attachment rejects a body path swapped after MIME sniffing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-attachment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.bin');
  const replacement = join(dir, 'replacement.bin');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(path, png);
  const before = await stat(path);
  await writeFile(replacement, new Uint8Array(png.length).fill(7));
  await utimes(replacement, before.atime, before.mtime);
  const engine = attachmentEngine({
    agentData: {
      async workspaceUpload(_workflowId, source) {
        await rename(replacement, path);
        await source.read(0, source.size);
        return { workspace_path: 'unreachable', size: source.size };
      },
    },
  });
  await assert.rejects(
    () => engine.uploadChatAttachment({ workflowId: 'wf', interactionId: 'chat', path }),
    FileSourceChangedError,
  );
});

test('chat attachment reports a directory as a usage error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dex-attachment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'folder');
  await mkdir(path);
  const engine = attachmentEngine({
    agentData: {
      async workspaceUpload() {
        throw new Error('upload must not start');
      },
    },
  });
  await assert.rejects(
    () => engine.uploadChatAttachment({ workflowId: 'wf', interactionId: 'chat', path }),
    (error: unknown) => error instanceof DexError && error.code === 'usage_error',
  );
});
