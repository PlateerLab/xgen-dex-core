import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolProvider, SHELL_TOOL } from '../src/local-tools';
import { normalizeLocalFolders } from '../src/local-folders';
import { setWorkspaceShellSupportForTest } from '../src/workspace-shell';
import { runUserPcCommand, USER_PC_RUN_TOOL, type UserPcShell } from '../src/user-pc';
import { bindTestHost, recordingInteraction } from './_host';

test('unsupported confinement denies Shell and UserPc aliases before process or approval', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'p2-confinement-owned-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => setWorkspaceShellSupportForTest(null));
  const connected = join(base, 'connected');
  await mkdir(connected);
  const outside = join(base, 'outside-synthetic.txt');
  await writeFile(outside, 'unchanged');
  const interaction = recordingInteraction('once');
  bindTestHost({ interaction: interaction.port });
  setWorkspaceShellSupportForTest(false);
  const provider = new LocalToolProvider();
  provider.configureFolders(() => normalizeLocalFolders([connected]));
  // The original raw-shell fallback wrote this owned outside sentinel.
  const command = `echo changed > "${outside}"`;
  for (const tool of [SHELL_TOOL, USER_PC_RUN_TOOL]) {
    await assert.rejects(provider.callTool(tool, { command }, { interactionId: 'owned' }), /WORKSPACE_SHELL_UNAVAILABLE/);
    await assert.rejects(provider.callTool(tool, { command: 'rm -rf ./not-there' }, { interactionId: 'owned' }), /WORKSPACE_SHELL_UNAVAILABLE/);
  }
  for (const kind of ['posix', 'git-bash', 'builtin'] as const) {
    const shell: UserPcShell = { kind, label: kind, note: 'synthetic test' };
    await assert.rejects(runUserPcCommand({ command, cwd: connected, roots: [connected], names: ['connected'], key: 'owned' }, shell), /WORKSPACE_SHELL_UNAVAILABLE/);
  }
  setWorkspaceShellSupportForTest(true);
  for (const kind of ['git-bash', 'builtin'] as const) {
    await assert.rejects(runUserPcCommand({ command, cwd: connected, roots: [connected], names: ['connected'], key: 'owned' }, { kind, label: kind, note: 'synthetic' }), /WORKSPACE_SHELL_UNAVAILABLE/);
  }
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  assert.deepEqual(interaction.asked, []);
  const written = await provider.callTool('WriteFile', { path: 'normal-control.txt', content: 'normal control' }, { interactionId: 'owned' });
  assert.equal(written.isError, undefined);
  const read = await provider.callTool('ReadFile', { path: 'normal-control.txt' }, { interactionId: 'owned' });
  assert.equal(read.content[0].text, 'normal control');
});
