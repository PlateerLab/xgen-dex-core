import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineService, enginePythonPath, type EngineEvent } from '../src/main/engine-service';

const FAKE = resolve(__dirname, 'fixtures', 'fake-engine.mjs');

function service(extra: Partial<ConstructorParameters<typeof EngineService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xd-engine-'));
  return {
    dir,
    svc: new EngineService({
      python: 'unused',
      root: dir,
      logDir: join(dir, 'logs'),
      command: [process.execPath, FAKE, dir],
      readyTimeoutMs: 10_000,
      ...extra,
    }),
  };
}

const turnCmd = (id: string, text: string, conversation = 'c1') => ({
  id,
  conversation,
  text,
  agent: { id: 'a1', name: 'A', workspace: 'A' },
  config: { provider: 'xd_fake', model: 'm' },
});

test('enginePythonPath: 설치본·개발·덮어쓰기', () => {
  assert.equal(
    enginePythonPath({ packaged: true, resourcesPath: '/r', appPath: '/a', platform: 'darwin', arch: 'arm64', env: {} }),
    join('/r', 'engine', 'python', 'bin', 'python3'),
  );
  assert.equal(
    enginePythonPath({ packaged: true, resourcesPath: 'C:\\r', appPath: '/a', platform: 'win32', arch: 'x64', env: {} }),
    join('C:\\r', 'engine', 'python', 'python.exe'),
  );
  assert.equal(
    enginePythonPath({ packaged: false, resourcesPath: '/r', appPath: '/repo/apps/xd', platform: 'linux', arch: 'x64', env: {} }),
    join('/repo/apps/xd', 'engine', 'dist', 'linux-x64', 'python', 'bin', 'python3'),
  );
  assert.equal(
    enginePythonPath({ packaged: true, resourcesPath: '/r', appPath: '/a', env: { XD_ENGINE_PYTHON: '/x/python' } }),
    '/x/python',
  );
});

test('턴의 사건이 그 턴에게 가고, 종결 사건 하나로 끝난다', async () => {
  const { svc } = service();
  const seen: EngineEvent[] = [];
  const end = await svc.turn(turnCmd('t1', 'hi'), (e) => seen.push(e));
  assert.equal(end.type, 'done');
  assert.deepEqual(
    seen.map((e) => e.type),
    ['started', 'chunk', 'usage', 'done'],
  );
  assert.equal(seen[1].text, 'echo: hi (history 0)');
  assert.equal(svc.info?.runtime, 'fake');
  await svc.stop();
  assert.equal(svc.running, false);
});

test('엔진이 턴 도중 죽으면 그 턴은 engine_exited 로 끝나고, 다음 턴에 다시 뜬다', async () => {
  const { svc, dir } = service();
  const end = await svc.turn(turnCmd('t1', 'crash'), () => {});
  assert.deepEqual([end.type, end.type === 'error' && end.code], ['error', 'engine_exited']);
  const again = await svc.turn(turnCmd('t2', 'after'), () => {});
  assert.equal(again.type, 'done');
  const log = readFileSync(join(dir, 'logs', 'engine.log'), 'utf8');
  assert.equal((log.match(/--- engine start/g) || []).length, 2);
  assert.match(log, /fake engine 시작/);
  await svc.stop();
});

test('취소하면 cancelled 로 끝난다', async () => {
  const { svc } = service();
  const done = svc.turn(turnCmd('t1', 'slow'), (e) => {
    if (e.type === 'started') svc.cancel('t1');
  });
  assert.equal((await done).type, 'cancelled');
  await svc.stop();
});

test('끄면 도는 턴은 엔진이 취소로 마무리한다', async () => {
  const { svc } = service();
  let started!: () => void;
  const isStarted = new Promise<void>((r) => (started = r));
  const done = svc.turn(turnCmd('t1', 'slow'), (e) => {
    if (e.type === 'started') started();
  });
  await isStarted;
  await svc.stop();
  assert.equal((await done).type, 'cancelled');
});

test('엔진을 찾지 못하면 턴은 engine_unavailable 로 끝난다(예외가 아니다)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xd-engine-'));
  const svc = new EngineService({ python: join(dir, 'missing', 'python3'), root: dir, logDir: join(dir, 'logs') });
  const end = await svc.turn(turnCmd('t1', 'hi'), () => {});
  assert.equal(end.type, 'error');
  assert.equal(end.type === 'error' && end.code, 'engine_unavailable');
});

test('프로토콜 판이 다르면 띄우지 않는다', async () => {
  const { svc } = service({ baseEnv: { ...process.env, FAKE_PROTOCOL: '2' } });
  const end = await svc.turn(turnCmd('t1', 'hi'), () => {});
  assert.equal(end.type === 'error' && end.code, 'engine_unavailable');
  assert.equal(svc.running, false);
});

test('모델 목록: 엔진에 묻고, 실패·시간 초과도 값으로 돌아온다', async () => {
  const { svc } = service();
  assert.deepEqual(await svc.models({ provider: 'ollama' }), { ok: true, models: [{ id: 'ollama-a' }, { id: 'ollama-b' }] });
  assert.deepEqual(await svc.models({ provider: 'down' }), { ok: false, models: [], error: 'unreachable' });
  assert.deepEqual(await svc.models({ provider: 'slow' }, 200), { ok: false, models: [], error: 'timeout' });
  await svc.stop();
});
