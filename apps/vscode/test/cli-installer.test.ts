/**
 * 확장이 `dex` 를 찾고, 없으면 깔아 주는 일.
 *
 * 확장은 대화를 직접 하지 않는다 — CLI 엔진을 자식 프로세스로 띄워 쓴다. 그래서
 * CLI 가 없으면 아무것도 안 되는데, 예전에는 `spawn dex ENOENT` 라는 말만 나왔다.
 *
 * 찾는 일도 PATH 만 보면 안 된다. VS Code 의 PATH 는 사용자의 셸 PATH 와 다르다 —
 * GUI 로 띄운 VS Code 에는 `.zshrc` 가 붙인 npm 전역 bin 이 없어서, 멀쩡히 깔린
 * `dex` 를 못 찾는 일이 실제로 흔하다.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  explainNpmFailure,
  globalBinCandidates,
  installCli,
  locateCli,
  type CommandResult,
  type RunCommand,
} from '../src/cli-installer';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = ''): CommandResult => ({ code: 1, stdout: '', stderr });

/** 부른 명령을 적어 두는 가짜 실행기. */
function runner(replies: Record<string, CommandResult>): RunCommand & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (file: string, args: string[]) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    return replies[key] ?? fail(`unexpected: ${key}`);
  }) as RunCommand & { calls: string[] };
  run.calls = calls;
  return run;
}

test('설정에 적힌 경로가 가장 세다', async () => {
  const run = runner({});
  const found = await locateCli('/opt/custom/dex', { run });
  assert.deepEqual(found, { command: '/opt/custom/dex', source: 'setting' });
  assert.deepEqual(run.calls, [], '지정해 줬으면 찾아다닐 이유가 없다');
});

test('PATH 에 있으면 그것을 쓴다', async () => {
  const run = runner({ 'which dex': ok('/usr/local/bin/dex\n') });
  const found = await locateCli('', { run, platform: 'linux' });
  assert.deepEqual(found, { command: '/usr/local/bin/dex', source: 'path' });
});

test('PATH 에 없어도 npm 전역 폴더에 있으면 찾아낸다', async () => {
  // VS Code 의 PATH 에 npm 전역 bin 이 없는, 아주 흔한 경우.
  const run = runner({
    'which dex': fail(),
    'npm prefix -g': ok('/home/me/.npm-global\n'),
  });
  const found = await locateCli('', {
    run,
    platform: 'linux',
    exists: (candidate) => candidate === '/home/me/.npm-global/bin/dex',
  });
  assert.deepEqual(found, { command: '/home/me/.npm-global/bin/dex', source: 'npm-global' });
});

test('정말 없으면 없다고 한다', async () => {
  const run = runner({ 'which dex': fail(), 'npm prefix -g': ok('/usr/local\n') });
  const found = await locateCli('', { run, platform: 'linux', exists: () => false });
  assert.equal(found, undefined);
});

test('윈도우에서는 where 로 찾고 .cmd 를 본다', async () => {
  const run = runner({ 'where dex': fail(), 'npm prefix -g': ok('C:\\\\npm\n') });
  await locateCli('', { run, platform: 'win32', exists: () => false });
  assert.ok(run.calls.includes('where dex'), 'which 가 아니라 where 다');
  assert.deepEqual(globalBinCandidates('C:\\npm', 'win32')[0], path.join('C:\\npm', 'dex.cmd'));
});

test('확장과 같은 버전을 콕 집어 깐다', async () => {
  // 한 태그가 검증된 조합 하나다. 아무 최신이나 끌어오면 확장이 모르는 엔진과 말한다.
  const run = runner({
    'npm i -g xgen-dex-cli@1.4.1': ok('added 1 package'),
    'which dex': ok('/usr/local/bin/dex\n'),
  });
  const outcome = await installCli('1.4.1', { run, platform: 'linux' });
  assert.ok(outcome.ok);
  assert.ok(run.calls.includes('npm i -g xgen-dex-cli@1.4.1'));
});

test('깐 뒤에 다시 찾는다 — PATH 에 없을 수 있다', async () => {
  const run = runner({
    'npm i -g xgen-dex-cli@1.4.1': ok('added 1 package'),
    'which dex': fail(),
    'npm prefix -g': ok('/home/me/.npm-global\n'),
  });
  const outcome = await installCli('1.4.1', {
    run,
    platform: 'linux',
    exists: (candidate) => candidate === '/home/me/.npm-global/bin/dex',
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.location.command, '/home/me/.npm-global/bin/dex');
});

test('설치가 실패하면 성공이라고 하지 않는다', async () => {
  const run = runner({
    'npm i -g xgen-dex-cli@1.4.1': { code: 1, stdout: '', stderr: 'npm error code EACCES' },
  });
  const outcome = await installCli('1.4.1', { run, platform: 'linux' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? '' : outcome.reason, /권한/);
});

test('설치는 됐는데 못 찾으면 그렇다고 말한다', async () => {
  const run = runner({
    'npm i -g xgen-dex-cli@1.4.1': ok('added 1 package'),
    'which dex': fail(),
    'npm prefix -g': fail(),
  });
  const outcome = await installCli('1.4.1', { run, platform: 'linux', exists: () => false });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? '' : outcome.reason, /찾지 못했습니다/);
});

test('실패의 진짜 이유를 짚는다', () => {
  assert.match(explainNpmFailure('npm error code EACCES'), /npm config set prefix/);
  assert.match(explainNpmFailure('npm error code ENOTFOUND'), /네트워크/);
  assert.match(explainNpmFailure('Error: spawn npm ENOENT'), /Node\.js/);
  assert.match(explainNpmFailure('npm error 404 Not Found'), /404/);
});
