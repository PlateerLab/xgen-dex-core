import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanCode, cliLogout, cliStatus, findDeviceCode, findUrl, startLogin, type LoginEvent } from '../src/main/cli/login';

const FAKE_CLAUDE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_CODEX = resolve(__dirname, 'fixtures', 'fake-codex.mjs');
const posix = process.platform !== 'win32';
const home = () => mkdtempSync(join(tmpdir(), 'xd-cli-home-'));

test('주소·코드 찾기 — ANSI·상자 글자·같은 줄의 프롬프트', () => {
  const claude = 'Opening…\n\x1b[1m│ visit: https://claude.com/cai/oauth/authorize?code=true&state=Ab_c-1 │\x1b[0m\nPaste code here if prompted > ';
  assert.equal(findUrl(claude), 'https://claude.com/cai/oauth/authorize?code=true&state=Ab_c-1');
  assert.equal(findUrl('Paste code here https://x.y/z?state=1 > '), 'https://x.y/z?state=1');
  assert.equal(findDeviceCode('   \x1b[94mAB12-CD3EF\x1b[0m\n'), 'AB12-CD3EF');
  assert.equal(findDeviceCode('no code'), null);
  assert.equal(cleanCode('  abc#def \n'), 'abc#def');
  assert.equal(cleanCode('abc#defPaste code here if prompted >'), 'abc#def');
});

function collect(name: 'claude' | 'codex', binary: string, h: string, extra: Record<string, unknown> = {}) {
  const events: LoginEvent[] = [];
  const session = startLogin(name, { binary, home: h, ...extra } as never, (e) => events.push(e));
  return { events, session };
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('Claude: 주소 → 코드 넣기 → 로그인, 그 홈에서 상태를 다시 확인한다', { skip: !posix }, async () => {
  const h = home();
  const { events, session } = collect('claude', FAKE_CLAUDE, h, {
    baseEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-leak', CLAUDE_CODE_SIMPLE: '1' },
    enterDelayMs: 50,
  });
  await until(() => events.some((e) => e.type === 'needs_code'));
  assert.deepEqual(events[0], { type: 'url', url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc' });
  session.submit('  GOOD#state ');
  assert.deepEqual(await session.finished, { type: 'done', ok: true });
  // 구독 로그인에 키·단순 모드를 섞지 않았다
  assert.deepEqual(JSON.parse(readFileSync(join(h, 'fake-env.json'), 'utf8')), { key: false, simple: false, quiet: '1' });
  assert.deepEqual(await cliStatus('claude', { binary: FAKE_CLAUDE, home: h }), { loggedIn: true, method: 'claude.ai', email: 'me@example.com' });
  await cliLogout('claude', { binary: FAKE_CLAUDE, home: h });
  assert.equal((await cliStatus('claude', { binary: FAKE_CLAUDE, home: h })).loggedIn, false);
});

test('Claude: 잘못된 코드는 기다리지 않고 실패로 끝난다', { skip: !posix }, async () => {
  const { events, session } = collect('claude', FAKE_CLAUDE, home(), { enterDelayMs: 10 });
  await until(() => events.some((e) => e.type === 'needs_code'));
  session.submit('WRONG');
  assert.deepEqual(await session.finished, { type: 'done', ok: false, error: 'invalid_code' });
});

test('Codex: 장치 주소·일회용 코드 → 스스로 끝나면 상태로 확인', { skip: !posix }, async () => {
  const h = home();
  const { events, session } = collect('codex', FAKE_CODEX, h);
  assert.deepEqual(await session.finished, { type: 'done', ok: true });
  assert.deepEqual(events.slice(0, 2), [
    { type: 'url', url: 'https://auth.openai.com/codex/device' },
    { type: 'code', code: 'AB12-CD3EF' },
  ]);
  assert.ok(existsSync(join(h, 'auth.json')));
  assert.deepEqual(await cliStatus('codex', { binary: FAKE_CODEX, home: h }), { loggedIn: true, method: 'chatgpt', email: null });
});

test('Codex: CLI 가 실패로 끝나면 실패, 취소는 취소', { skip: !posix }, async () => {
  const failing = collect('codex', FAKE_CODEX, home(), { baseEnv: { ...process.env, FAKE_FAIL: '1' } });
  assert.deepEqual(await failing.session.finished, { type: 'done', ok: false, error: 'exit 1' });
  const cancelled = collect('codex', FAKE_CODEX, home());
  cancelled.session.cancel();
  assert.deepEqual(await cancelled.session.finished, { type: 'done', ok: false, error: 'cancelled' });
});

// 이 PC 에 실제 CLI 가 있으면 — 빈 홈에서 로그인을 시작만 해 보고 취소한다(계정에 아무 영향 없음).
const REAL_CLAUDE = [join(homedir(), '.local', 'bin', 'claude')].find(existsSync);
const REAL_CODEX = [join(homedir(), '.local', 'codex-cli', 'bin', 'codex')].find(existsSync);

test('실제 claude: 빈 홈은 로그인 안 됨, 로그인을 시작하면 주소를 읽는다', { skip: !REAL_CLAUDE }, async () => {
  const h = join(homedir(), '.local', `xd-login-test-${process.pid}`);
  assert.equal((await cliStatus('claude', { binary: REAL_CLAUDE!, home: h })).loggedIn, false);
  const { events, session } = collect('claude', REAL_CLAUDE!, h);
  await until(() => events.some((e) => e.type === 'url'), 30_000);
  assert.match((events[0] as { url: string }).url, /^https:\/\/claude\.(com|ai)\/.*oauth/);
  session.cancel();
  await session.finished;
});

test('실제 codex: 빈 홈은 로그인 안 됨, 로그인을 시작하면 주소와 코드를 읽는다', { skip: !REAL_CODEX }, async () => {
  const h = join(homedir(), '.local', `xd-login-test-codex-${process.pid}`);
  assert.equal((await cliStatus('codex', { binary: REAL_CODEX!, home: h })).loggedIn, false);
  const { events, session } = collect('codex', REAL_CODEX!, h);
  await until(() => events.some((e) => e.type === 'code'), 30_000);
  assert.equal((events.find((e) => e.type === 'url') as { url: string }).url, 'https://auth.openai.com/codex/device');
  session.cancel();
  await session.finished;
});
