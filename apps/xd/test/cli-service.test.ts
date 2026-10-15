import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { xdCliPath } from '../src/main/cli/detect';
import { CLAUDE_RELEASES, claudePlatform, type Fetcher } from '../src/main/cli/install';
import { CliService, type CliEvent } from '../src/main/cli/service';

const FAKE_CLAUDE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function service(fetcher?: Fetcher) {
  const cliDir = join(mkdtempSync(join(tmpdir(), 'xd-cli-svc-')), 'cli');
  const events: CliEvent[] = [];
  const svc = new CliService({
    cliDir,
    pathStr: async () => '',
    emit: (e) => events.push(e),
    fetcher,
    version: async () => '2.1.999',
    loginOptions: { enterDelayMs: 10 },
  });
  return { svc, events, cliDir };
}

test('설치: 받는 중에 다시 눌러도 하나만 받고, 상태에 진행이 보이며, 끝은 install_done 으로 알린다', { skip: !posix }, async () => {
  const body = Buffer.from('#!/bin/sh\necho 2.1.300\n');
  const sum = createHash('sha256').update(body).digest('hex');
  const platform = claudePlatform(process.platform, process.arch);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let downloads = 0;
  const fetcher: Fetcher = {
    text: async () => '2.1.300',
    json: async () => ({ platforms: { [platform]: { checksum: sum } } }),
    bytes: async (url, onProgress) => {
      assert.equal(url, `${CLAUDE_RELEASES}/2.1.300/${platform}/claude`);
      downloads += 1;
      onProgress?.(10, 100);
      await gate;
      return body;
    },
  };
  const { svc, events } = service(fetcher);
  const a = svc.install('claude');
  const b = svc.install('claude');
  assert.equal(a, b);
  await until(() => events.some((e) => e.type === 'install_progress'));
  // 화면을 떠났다 돌아오면 상태에서 진행을 다시 받는다
  assert.deepEqual((await svc.state('claude')).installing, { received: 10, total: 100 });
  release();
  const found = await a;
  assert.equal(found.source, 'xd');
  assert.equal(downloads, 1);
  assert.deepEqual(events.at(-1), { cli: 'claude', type: 'install_done', ok: true, version: '2.1.999' });
  assert.equal((await svc.state('claude')).installing, null);
});

test('설치 실패도 install_done 으로 알리고, 다음 설치는 새로 받는다', async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    text: async () => {
      calls += 1;
      throw new Error('getaddrinfo ENOTFOUND downloads.claude.ai');
    },
    json: async () => ({}),
    bytes: async () => Buffer.alloc(0),
  };
  const { svc, events } = service(fetcher);
  await assert.rejects(svc.install('claude'), /ENOTFOUND/);
  assert.deepEqual(events.at(-1), { cli: 'claude', type: 'install_done', ok: false, error: 'getaddrinfo ENOTFOUND downloads.claude.ai' });
  await assert.rejects(svc.install('claude'));
  assert.equal(calls, 2);
});

test('로그인: 도는 동안 상태에 주소·코드 칸이 남고, 끝나면 사라진다', { skip: !posix }, async () => {
  const { svc, events, cliDir } = service();
  const bin = xdCliPath(cliDir, 'claude');
  mkdirSync(dirname(bin), { recursive: true });
  copyFileSync(FAKE_CLAUDE, bin);
  chmodSync(bin, 0o755);

  await svc.login('claude');
  await until(() => events.some((e) => e.type === 'login' && e.event.type === 'needs_code'));
  const during = await svc.state('claude');
  assert.equal(during.loggingIn, true);
  assert.deepEqual(during.loginFlow, { url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc', needsCode: true });

  svc.submitLoginCode('claude', 'GOOD#state');
  await until(() => events.some((e) => e.type === 'login' && e.event.type === 'done'));
  const after = await svc.state('claude');
  assert.deepEqual([after.loggingIn, after.loginFlow, after.login?.loggedIn], [false, null, true]);

  // 그만두면 cancelled 로 끝나고 상태도 비워진다
  await svc.login('claude');
  await until(() => events.filter((e) => e.type === 'login' && e.event.type === 'url').length === 2);
  svc.cancelLogin('claude');
  assert.deepEqual(events.at(-1), { cli: 'claude', type: 'login', event: { type: 'done', ok: false, error: 'cancelled' } });
  assert.equal((await svc.state('claude')).loginFlow, null);
});
