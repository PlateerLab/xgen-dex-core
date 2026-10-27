import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { configureNativeFsStage, nativeFsStagePath } from '@dex/engine/rooted-fs';
import { BrowserRuntime } from '../src/main/browser-runtime';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { BrowserFileScopes, BrowserScratch } from '../src/main/browser-file-transfer';
import { BROWSER_ADVANCED_TOOL, BROWSER_CAPTURE_TOOL, BrowserToolProvider } from '../src/main/browser-tools';

let parent: string;
before(async () => {
  parent = await mkdtemp(join(tmpdir(), 'xgen-browser-boundary-'));
  const stage = join(parent, 'private-stage');
  await mkdir(stage, { mode: 0o700 });
  await chmod(stage, 0o700);
  configureNativeFsStage(stage);
});

test('browser upload reads a pinned source and preserves its filename in private scratch', async () => {
  const root = join(parent, 'upload-root');
  await mkdir(root);
  await writeFile(join(root, 'report.txt'), 'private-source');
  const scopes = new BrowserFileScopes();
  const source = await scopes.resolve('report.txt', 'chat-upload', [root], false);
  const scratch = await BrowserScratch.create();
  try {
    const staged = await scratch.uploadFrom(source, 0);
    assert.equal(staged.split('/').at(-1), 'report.txt');
    assert.equal(await readFile(staged, 'utf8'), 'private-source');
    await assert.rejects(() => scopes.resolve('../outside.txt', 'chat-upload', [root], false), /PATH_DOMAIN_MISMATCH/);
  } finally {
    await scratch.cleanup();
    scopes.clear();
  }
});

test('browser upload keeps its private copy readable after the command returns', async () => {
  const root = join(parent, 'retained-upload-root');
  await mkdir(root);
  await writeFile(join(root, 'cover.png'), 'private-image');
  let staged = '';
  let retained: BrowserScratch | undefined;
  const runtime = {
    resolvePage: async () => ({ info: { pageId: 'page-upload' } }),
    uploadDocument: () => 0,
    runAgentCommand: async (_workflow: string, _page: string, command: string[]) => {
      staged = command[2];
      assert.equal(await readFile(staged, 'utf8'), 'private-image');
      return { page: null, result: {} };
    },
    retainUpload: async (_page: string, _document: number, scratch: BrowserScratch) => {
      retained = scratch;
      return true;
    },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true, () => [root]);
  try {
    await provider.callTool(BROWSER_ADVANCED_TOOL, { action: 'upload', page_id: 'page-upload', ref: '@e1', path: 'cover.png' },
      { workflowId: 'wf', interactionId: 'retained-upload' });
    assert.ok(retained);
    assert.equal(await readFile(staged, 'utf8'), 'private-image');
  } finally {
    await retained?.cleanup();
    provider.clearBrowserFileGrants();
  }
  await assert.rejects(readFile(staged));
});

test('failed browser upload removes its private copy', async () => {
  const root = join(parent, 'failed-upload-root');
  await mkdir(root);
  await writeFile(join(root, 'cover.png'), 'private-image');
  let staged = '';
  const runtime = {
    resolvePage: async () => ({ info: { pageId: 'page-upload' } }),
    uploadDocument: () => 0,
    runAgentCommand: async (_workflow: string, _page: string, command: string[]) => {
      staged = command[2];
      throw new Error('upload failed');
    },
    retainUpload: () => { throw new Error('failed upload must not be retained'); },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true, () => [root]);
  try {
    await assert.rejects(provider.callTool(BROWSER_ADVANCED_TOOL,
      { action: 'upload', page_id: 'page-upload', ref: '@e1', path: 'cover.png' },
      { workflowId: 'wf', interactionId: 'failed-upload' }));
    await assert.rejects(readFile(staged));
  } finally {
    provider.clearBrowserFileGrants();
  }
});

test('browser stage startup cleanup removes orphan uploads but keeps other stage data', async () => {
  const orphan = await BrowserScratch.create();
  const upload = orphan.path('upload-0');
  await mkdir(upload);
  await writeFile(join(upload, 'cover.png'), 'orphan');
  const other = join(nativeFsStagePath(), 'other-stage');
  await mkdir(other);
  await BrowserScratch.cleanupOrphans();
  await assert.rejects(readFile(join(upload, 'cover.png')));
  assert.ok((await stat(other)).isDirectory());
});

test('browser output commits through the pinned root after its pathname is replaced', async () => {
  const root = join(parent, 'output-root');
  const moved = join(parent, 'output-root-moved');
  await mkdir(root);
  const scopes = new BrowserFileScopes();
  const target = await scopes.resolve('shot.png', 'chat-output', [root], true);
  const scratch = await BrowserScratch.create();
  try {
    await writeFile(scratch.path('shot.png'), 'safe-output');
    await rename(root, moved);
    await mkdir(root);
    await scratch.commit('shot.png', target);
    assert.equal(await readFile(join(moved, 'shot.png'), 'utf8'), 'safe-output');
    await assert.rejects(readFile(join(root, 'shot.png')));
  } finally {
    await scratch.cleanup();
    scopes.clear();
  }
});

test('browser output rejects symlinks and oversized files before commit', async () => {
  const root = join(parent, 'rejected-root');
  await mkdir(root);
  const scopes = new BrowserFileScopes();
  const target = await scopes.resolve('out.bin', 'chat-rejected', [root], true);
  const scratch = await BrowserScratch.create();
  try {
    const outside = join(parent, 'outside-secret');
    await writeFile(outside, 'secret');
    await symlink(outside, scratch.path('linked'));
    await assert.rejects(() => scratch.commit('linked', target));
    await writeFile(scratch.path('too-large'), '');
    await truncate(scratch.path('too-large'), 100 * 1024 * 1024 + 1);
    await assert.rejects(() => scratch.commit('too-large', target), /100MiB/);
    await assert.rejects(readFile(join(root, 'out.bin')));
  } finally {
    await scratch.cleanup();
    scopes.clear();
  }
});

test('browser overwrite preserves existing inode and permissions', async () => {
  const root = join(parent, 'metadata-root');
  await mkdir(root);
  await writeFile(join(root, 'existing'), 'old', { mode: 0o750 });
  const before = await stat(join(root, 'existing'));
  const scopes = new BrowserFileScopes();
  const scratch = await BrowserScratch.create();
  try {
    const target = await scopes.resolve('existing', 'metadata', [root], true);
    await writeFile(scratch.path('output'), 'new');
    await scratch.commit('output', target);
    const after = await stat(join(root, 'existing'));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.equal(await readFile(join(root, 'existing'), 'utf8'), 'new');
  } finally {
    await scratch.cleanup();
    scopes.clear();
  }
});

test('capture and HAR stop pass only private paths to the helper and commit to connected folder', async () => {
  const root = join(parent, 'tool-root');
  await mkdir(root);
  const helperPaths: string[] = [];
  const runtime = {
    resolvePage: async () => ({ info: { pageId: 'page' } }),
    runAgentCommand: async (_workflow: string, _page: string | undefined, command: string[]) => {
      const path = command[0] === 'network' ? command[3] : command[1];
      if (path) {
        helperPaths.push(path);
        await writeFile(path, command[0] === 'network' ? 'HAR' : 'PNG');
      }
      return { page: null, result: { path } };
    },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true, () => [root]);
  const context = { workflowId: 'wf', interactionId: 'chat' };
  try {
    const shot = await provider.callTool(BROWSER_CAPTURE_TOOL, { action: 'screenshot', path: 'shot.png' }, context);
    const har = await provider.callTool(BROWSER_ADVANCED_TOOL, { action: 'har', operation: 'stop' }, context);
    await provider.callTool(BROWSER_ADVANCED_TOOL, { action: 'network', operation: 'har', value: 'stop', path: 'alias.har' }, context);
    assert.equal(await readFile(join(root, 'shot.png'), 'utf8'), 'PNG');
    assert.equal(await readFile(join(root, 'browser.har'), 'utf8'), 'HAR');
    assert.equal(await readFile(join(root, 'alias.har'), 'utf8'), 'HAR');
    assert.ok(helperPaths.every((path) => path.startsWith(join(nativeFsStagePath(), 'browser-'))));
    assert.ok(!JSON.stringify([shot, har]).includes('private-stage'));
  } finally {
    provider.clearBrowserFileGrants();
  }
});

test('upload asks nothing but only takes files from the conversation folders', async () => {
  const root = join(parent, 'upload-scope-root');
  await mkdir(root);
  await writeFile(join(parent, 'outside.png'), 'PNG');
  let calls = 0;
  const runtime = {
    resolvePage: async () => ({ info: { pageId: 'page' } }),
    runAgentCommand: async () => { calls++; return { page: null, result: {} }; },
  } as unknown as BrowserRuntime;
  const context = { workflowId: 'wf', interactionId: 'upload-scope' };
  const args = { action: 'upload', page_id: 'page', ref: '@e1', path: join(parent, 'outside.png') };
  const unlinked = new BrowserToolProvider(runtime);
  unlinked.configure(true, () => []);
  await assert.rejects(unlinked.callTool(BROWSER_ADVANCED_TOOL, args, context), /연결된 폴더가 없어/);
  const linked = new BrowserToolProvider(runtime);
  linked.configure(true, () => [root]);
  try {
    await assert.rejects(linked.callTool(BROWSER_ADVANCED_TOOL, args, context), /browser_denied|PATH_DOMAIN_MISMATCH|폴더/);
    await assert.rejects(linked.callTool(BROWSER_ADVANCED_TOOL, { ...args, path: '../outside.png' }, context));
    assert.equal(calls, 0);
  } finally {
    linked.clearBrowserFileGrants();
  }
});

test('advanced rejects unadvertised file commands and network routes before invoking helper', async () => {
  let calls = 0;
  const provider = new BrowserToolProvider({ runAgentCommand: async () => { calls++; } } as unknown as BrowserRuntime);
  provider.configure(true, () => []);
  for (const args of [
    { action: 'screenshot', operation: '/outside/file' },
    { action: 'state', operation: 'save', value: '/outside/file' },
    { action: 'network', operation: 'route', value: '/outside/file' },
  ]) {
    await assert.rejects(provider.callTool(BROWSER_ADVANCED_TOOL, args, { workflowId: 'wf', interactionId: 'bad-action' }), /지원하지 않는/);
  }
  assert.equal(calls, 0);
});

test('revoking one conversation aborts its active browser file command before commit', async () => {
  const root = join(parent, 'revoked-root');
  await mkdir(root);
  let started!: () => void;
  const commandStarted = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = 0;
  const runtime = {
    resolvePage: async () => ({ info: { pageId: 'page-revoked' } }),
    runAgentCommand: async () => {
      started();
      return new Promise<never>(() => undefined);
    },
    cancelAgentCommand: async () => { cancelled++; },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true, () => [root]);
  const pending = provider.callTool(BROWSER_CAPTURE_TOOL, { action: 'screenshot', path: 'shot.png' },
    { workflowId: 'wf', interactionId: 'chat-revoke' });
  await commandStarted;
  provider.clearBrowserFileGrants('chat-revoke');
  await assert.rejects(pending, /권한이 해제되었습니다/);
  assert.equal(cancelled, 1);
  await assert.rejects(readFile(join(root, 'shot.png')));
});

test('download receipt waits for Electron completion and serializes same-page permits', async () => {
  const runtime = new BrowserRuntime();
  let calls = 0;
  let releaseFirst!: () => void;
  const firstCommand = new Promise<void>((resolve) => { releaseFirst = resolve; });
  runtime.runAgentCommand = async () => {
    calls++;
    if (calls === 1) await firstCommand;
    return { page: { pageId: 'page' } as BrowserPageInfo, result: { success: true } };
  };
  const internals = runtime as unknown as {
    downloadPermits: Map<string, { started: boolean; resolve: () => void }>;
  };
  const first = runtime.runDownloadCommand('wf', 'page', ['download', '@e1', '/private/a'], '/private/electron-a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstPermit = internals.downloadPermits.get('page');
  assert.ok(firstPermit);
  firstPermit.started = true;
  const second = runtime.runDownloadCommand('wf', 'page', ['download', '@e2', '/private/b'], '/private/electron-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(internals.downloadPermits.get('page'), firstPermit);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  firstPermit.resolve();
  assert.equal((await first).electronSaved, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.notEqual(internals.downloadPermits.get('page'), firstPermit);
  assert.equal((await second).electronSaved, false);
});
