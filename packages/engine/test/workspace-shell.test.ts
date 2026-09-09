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
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { LocalToolProvider, shellConfig } from '../src/local-tools';
import { prepareWorkspaceShell } from '../src/workspace-shell';
import { bindTestHost } from './_host';

bindTestHost();
const supported =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0);
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
  provider.configure({
    enabled: true,
    cwd: workspace,
    allowedRoots: [workspace],
    timeoutMs: 2_000,
  });
  return { provider, workspace, outside };
}

test('설정은 셸 사용 여부와 범위를 구분하고, 기본 작업 폴더에 홈을 추가하지 않는다', () => {
  assert.deepEqual(shellConfig({ cwd: '/project' }).allowedRoots, ['/project']);
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const workspace = p.advertise().find((tool) => tool.name === 'Shell');
  assert.match(workspace?.description || '', /ACCESS MODE: workspace shell/);
  assert.doesNotMatch(workspace?.description || '', /PREFER working there/);
  p.configure({ enabled: true, shellEnabled: true });
  assert.match(
    p.advertise().find((tool) => tool.name === 'Shell')?.description || '',
    /ACCESS MODE: full PC shell access/,
  );
  p.configure({ enabled: false, shellEnabled: true });
  assert.deepEqual(p.advertise(), []);
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

test('전체 셸 접근은 작업 공간 밖의 cwd와 파일을 허용한다', { skip: !supported }, async (t) => {
  const { provider, workspace, outside } = await fixture(t);
  provider.configure({
    enabled: true,
    shellEnabled: true,
    cwd: workspace,
    allowedRoots: [workspace],
    timeoutMs: 2_000,
  });
  const result = await provider.callTool('Shell', {
    command: 'cat private.txt; printf full > full.txt',
    cwd: outside,
  });
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.content[0].text, /outside marker/);
  assert.equal(await readFile(join(outside, 'full.txt'), 'utf8'), 'full');
  await assert.rejects(
    provider.callTool('ReadFile', { path: join(outside, 'private.txt') }),
    /PATH_DOMAIN_MISMATCH/,
  );
  await provider.callTool('WriteFile', {
    path: 'relative.txt',
    content: 'workspace file',
  });
  assert.equal(await readFile(join(workspace, 'relative.txt'), 'utf8'), 'workspace file');
});

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
    provider.configure({ enabled: true, cwd: workspace, timeoutMs: 2000 });
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
