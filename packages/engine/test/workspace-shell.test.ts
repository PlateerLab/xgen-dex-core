import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { LocalToolProvider, shellToolSchema } from '../src/local-tools';
import { normalizeLocalFolders } from '../src/local-folders';
import {
  prepareWorkspaceShell,
  userToolchains,
  workspaceShellSupported,
} from '../src/workspace-shell';
import { bindTestHost } from './_host';

bindTestHost();
// 가두기를 실제로 쓸 수 있는 OS 에서만 가두기 테스트를 돈다. bubblewrap 이 있어도
// 네임스페이스를 못 만드는 Linux(Ubuntu 24.04 기본 AppArmor)는 여기서 걸러진다.
const supported = await workspaceShellSupported();
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dex-shell-scope-')));
  const workspace = join(base, '허용 workspace');
  const outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'outside marker');
  t.after(() => rm(base, { recursive: true, force: true }));
  const provider = new LocalToolProvider();
  // 이 테스트들의 호출은 모두 같은 대화 — 연결 폴더는 workspace 하나.
  provider.configureFolders(() => normalizeLocalFolders([workspace]));
  return { provider, workspace, outside };
}

test('Shell 설명은 범위가 이 대화의 연결 폴더라고 말한다', () => {
  const description = shellToolSchema().description || '';
  assert.match(description, /folders the user connected to THIS conversation/);
  assert.match(description, /NOT your server sandbox/);
  assert.doesNotMatch(description, /full PC shell access/);
});

test('가두기 지원 여부는 OS 가 정한다 — Windows 는 지원하지 않는다', async () => {
  const value = await workspaceShellSupported();
  assert.equal(typeof value, 'boolean');
  if (process.platform === 'win32') assert.equal(value, false);
});

test('홈의 개발 도구(nvm·pyenv·cargo)는 읽기 전용으로 보이고 PATH 에 오른다', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dex-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const dir of [
    '.nvm/versions/node/v18.20.0/bin',
    '.nvm/versions/node/v20.11.1/bin',
    '.nvm/versions/node/v9.0.0/bin',
    '.pyenv/shims',
    '.cargo/bin',
  ]) {
    await mkdir(join(home, dir), { recursive: true });
  }
  const saved = process.env.NVM_BIN;
  delete process.env.NVM_BIN;
  t.after(() => {
    if (saved !== undefined) process.env.NVM_BIN = saved;
  });
  const found = await userToolchains(home);
  // 가장 새 node 가 맨 앞 — 숫자 비교(v9 < v18 < v20), 글자 비교가 아니다.
  assert.equal(found.bins[0], join(home, '.nvm/versions/node/v20.11.1/bin'));
  assert.ok(found.bins.includes(join(home, '.pyenv/shims')));
  assert.ok(found.bins.includes(join(home, '.cargo/bin')));
  assert.ok(found.mounts.includes(join(home, '.nvm/versions')));
  assert.ok(found.mounts.includes(join(home, '.pyenv')));
  assert.equal(found.env.PYENV_ROOT, join(home, '.pyenv'));
  // 없는 도구는 싣지 않는다.
  assert.ok(!found.mounts.some((dir) => dir.includes('.rbenv')));
  assert.equal(found.env.RBENV_ROOT, undefined);
});

test(
  '기본 셸은 허용 작업 공간에서 실행하고 홈과 임시 파일을 정리한다',
  { skip: !supported },
  async (t) => {
    const { provider, workspace } = await fixture(t);
    const result = await provider.callTool('Shell', {
      command: 'printf workspace-ok > result.txt; cat result.txt; printf "\\n%s" "$HOME"',
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /workspace-ok/);
    assert.ok(result.content[0].text.includes(workspace));
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'workspace-ok');
    assert.ok(!(await readdir(workspace)).some((p) => p.startsWith('.xgen-shell-')));
  },
);

test(
  '기본 셸은 cwd·절대 경로·상대 경로·심볼릭 링크·자식 프로세스의 범위 이탈을 차단한다',
  { skip: !supported },
  async (t) => {
    const { provider, workspace, outside } = await fixture(t);
    await symlink(outside, join(workspace, 'escape'), 'dir');
    await assert.rejects(
      provider.callTool('Shell', {
        command: 'echo should-not-run',
        cwd: outside,
      }),
      /PATH_DOMAIN_MISMATCH/,
    );
    await assert.rejects(
      provider.callTool('Shell', {
        command: 'echo should-not-run',
        cwd: join(workspace, 'escape'),
      }),
      /PATH_DOMAIN_MISMATCH/,
    );
    for (const command of [
      `cat ${quote(join(outside, 'private.txt'))}`,
      'cat ../outside/private.txt',
      'cat escape/private.txt',
      `${quote(process.execPath)} -e ${quote(`require('fs').readFileSync(${JSON.stringify(join(outside, 'private.txt'))})`)}`,
      `printf forbidden > ${quote(join(outside, 'forbidden.txt'))}`,
      `sh -c ${quote(`printf forbidden > ${quote(join(outside, 'child.txt'))}`)}`,
    ]) {
      const result = await provider.callTool('Shell', { command });
      assert.equal(result.isError, true, `${command}: ${result.content[0].text}`);
      assert.ok(!result.content[0].text.includes('outside marker'));
    }
    assert.deepEqual(await readdir(outside), ['private.txt']);
  },
);

test(
  '기본 셸에서 시스템 도구와 프로젝트 Git 작업을 사용할 수 있다',
  { skip: !supported },
  async (t) => {
    const { provider, workspace } = await fixture(t);
    const result = await provider.callTool('Shell', {
      command: `${quote(process.execPath)} -e ${quote("require('fs').writeFileSync('script.txt', 'node-ok')")}; git init -q; git status --porcelain`,
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(await readFile(join(workspace, 'script.txt'), 'utf8'), 'node-ok');
    assert.match(result.content[0].text, /script.txt/);
  },
);

test(
  '가둔 셸에서도 Git 커밋은 사용자 이름으로 된다',
  { skip: !supported || !spawnSync('git', ['config', '--global', '--get', 'user.name']).stdout?.toString().trim() },
  async (t) => {
    const { provider } = await fixture(t);
    const name = spawnSync('git', ['config', '--global', '--get', 'user.name']).stdout.toString().trim();
    const result = await provider.callTool('Shell', {
      command: 'git init -q && printf x > a.txt && git add a.txt && git commit -qm first && git log -1 --format=%an',
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(result.content[0].text.trim(), name);
  },
);

test(
  '백그라운드와 자동 전환 작업도 같은 작업 공간 제한을 유지한다',
  { skip: !supported },
  async (t) => {
    const { provider, workspace, outside } = await fixture(t);
    for (const background of [true, false]) {
      const result = await provider.callTool('Shell', {
        command: `sleep 0.5; printf inside > job.txt; printf forbidden > ${quote(join(outside, 'job.txt'))}`,
        background,
        background_after_ms: 30,
      });
      const id = result.content[0].text.match(/job_id:\s*(\S+)/)?.[1];
      assert.ok(id, result.content[0].text);
      let poll;
      for (let i = 0; i < 50; i++) {
        poll = await provider.callTool('ShellJob', {
          action: 'poll',
          job_id: id,
        });
        if (poll.structuredContent?.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(poll!.content[0].text, /exited/);
      assert.equal(await readFile(join(workspace, 'job.txt'), 'utf8'), 'inside');
      assert.deepEqual(await readdir(outside), ['private.txt']);
    }
  },
);

test(
  '작업 공간 셸의 localhost 서버를 사용자 PC와 후속 셸에서 열 수 있다',
  { skip: !supported },
  async (t) => {
    const { provider } = await fixture(t);
    await provider.callTool('WriteFile', {
      path: 'server.cjs',
      content: `const server = require('http').createServer((req, res) => res.end('local-app-ok'));
server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port));
setTimeout(() => server.close(), 10000).unref();`,
    });
    const result = await provider.callTool('Shell', {
      command: `${quote(process.execPath)} server.cjs`,
      background: true,
    });
    const id = result.content[0].text.match(/job_id:\s*(\S+)/)?.[1];
    assert.ok(id, result.content[0].text);
    t.after(() => provider.callTool('ShellJob', { action: 'kill', job_id: id }));
    let port = '';
    for (let i = 0; i < 50; i++) {
      const poll = await provider.callTool('ShellJob', { action: 'poll', job_id: id });
      port = poll.content[0].text.match(/PORT=(\d+)/)?.[1] || '';
      if (port || poll.structuredContent?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(port, 'local dev server did not start');
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text(), 'local-app-ok');
    const check = await provider.callTool('Shell', {
      command: `${quote(process.execPath)} -e ${quote(`fetch(${JSON.stringify(url)}).then(r => r.text()).then(console.log)`)}`,
    });
    assert.equal(check.isError, false, check.content[0].text);
    assert.match(check.content[0].text, /local-app-ok/);
  },
);

test(
  'DNS 예외를 허용해도 다른 PC Unix 소켓에는 접속할 수 없다',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    // Darwin's sockaddr_un cannot hold the long default temp directory path.
    const workspace = await realpath(await mkdtemp('/tmp/dex-ipc-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const provider = new LocalToolProvider();
    provider.configureFolders(() => normalizeLocalFolders([workspace]));
    const socketPath = join(workspace, 'ipc.sock');
    let connected = false;
    const server = createServer((socket) => {
      connected = true;
      socket.end('host IPC');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const script = `require('net').connect(${JSON.stringify(socketPath)})
      .on('connect', () => { console.error('unexpected connection'); process.exit(1); })
      .on('error', () => console.log('IPC denied'));`;
    const result = await provider.callTool('Shell', {
      command: `${quote(process.execPath)} -e ${quote(script)}`,
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /IPC denied/);
    assert.equal(connected, false);
  },
);

test(
  '미지원 운영체제는 제한 없는 셸로 폴백하지 않는다',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      prepareWorkspaceShell('cmd.exe', [], {}, '.', ['.']),
      /WORKSPACE_SHELL_UNAVAILABLE/,
    );
  },
);
