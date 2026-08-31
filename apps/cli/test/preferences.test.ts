/**
 * 한/영 선택을 기억한다.
 *
 * 한국어 환경에서 쓰는 사람이 실행할 때마다 Ctrl+Space 를 눌러야 한다면, 그 자체가
 * 없애려던 불편이다. 그래서 고른 적이 없으면 로케일을 보고, 한 번 고르면 그 선택을
 * 지킨다.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  localeDefaultHangul,
  preferencesPath,
  readPreferences,
  writePreferences,
} from '../src/tui/preferences';

async function withHome(body: (env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'dex-prefs-'));
  try {
    await body({ DEX_CLI_HOME: home } as NodeJS.ProcessEnv);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('고른 적이 없으면 로케일을 따른다', () => {
  assert.equal(localeDefaultHangul({ LANG: 'ko_KR.UTF-8' } as NodeJS.ProcessEnv), true);
  assert.equal(localeDefaultHangul({ LC_ALL: 'ko_KR.UTF-8' } as NodeJS.ProcessEnv), true);
  assert.equal(localeDefaultHangul({ LC_CTYPE: 'ko-KR' } as NodeJS.ProcessEnv), true);
  assert.equal(localeDefaultHangul({ LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv), false);
  assert.equal(localeDefaultHangul({ LANG: 'C' } as NodeJS.ProcessEnv), false);
  assert.equal(localeDefaultHangul({} as NodeJS.ProcessEnv), false);
});

test('koi8 처럼 ko 로 시작하는 다른 이름에 속지 않는다', () => {
  assert.equal(localeDefaultHangul({ LANG: 'koi8-r' } as NodeJS.ProcessEnv), false);
});

test('고른 적이 없으면 로케일 기본값을 읽어 온다', async () => {
  await withHome(async (env) => {
    assert.deepEqual(await readPreferences({ ...env, LANG: 'ko_KR.UTF-8' }), { hangulMode: true });
    assert.deepEqual(await readPreferences({ ...env, LANG: 'en_US.UTF-8' }), { hangulMode: false });
  });
});

test('한 번 고르면 로케일보다 그 선택이 세다', async () => {
  await withHome(async (env) => {
    await writePreferences({ hangulMode: false }, { ...env, LANG: 'ko_KR.UTF-8' });
    assert.deepEqual(await readPreferences({ ...env, LANG: 'ko_KR.UTF-8' }), { hangulMode: false });

    await writePreferences({ hangulMode: true }, { ...env, LANG: 'en_US.UTF-8' });
    assert.deepEqual(await readPreferences({ ...env, LANG: 'en_US.UTF-8' }), { hangulMode: true });
  });
});

test('파일이 깨져 있어도 기본값으로 계속 간다', async () => {
  // 취향을 못 읽는 것과 대화를 못 하는 것은 다른 일이다.
  await withHome(async (env) => {
    await writePreferences({ hangulMode: true }, env);
    await writeFile(preferencesPath(env), '{ 이건 JSON 이 아니다', 'utf8');
    assert.deepEqual(await readPreferences({ ...env, LANG: 'ko_KR.UTF-8' }), { hangulMode: true });
    assert.deepEqual(await readPreferences({ ...env, LANG: 'en_US.UTF-8' }), { hangulMode: false });
  });
});

test('엉뚱한 타입이 들어 있어도 기본값으로 돌아간다', async () => {
  await withHome(async (env) => {
    await writeFile(preferencesPath(env), JSON.stringify({ hangulMode: 'yes' }), 'utf8');
    assert.deepEqual(await readPreferences({ ...env, LANG: 'en_US.UTF-8' }), { hangulMode: false });
  });
});

test('서버 설정과 다른 파일에 적는다', async () => {
  // config.json 은 앱·확장과 함께 쓰는 계약이다. 터미널에서만 뜻이 있는 값을 거기
  // 넣으면 그 계약을 읽는 모든 곳이 이 값을 알아야 하는 것처럼 보인다.
  await withHome(async (env) => {
    await writePreferences({ hangulMode: true }, env);
    assert.equal(path.basename(preferencesPath(env)), 'tui.json');
    const saved = JSON.parse(await readFile(preferencesPath(env), 'utf8')) as unknown;
    assert.deepEqual(saved, { hangulMode: true });
  });
});

test('쓸 수 없는 곳이어도 던지지 않는다', async () => {
  // 읽기 전용 홈이나 권한이 막힌 곳에서도 대화는 되어야 한다.
  await withHome(async (env) => {
    // 파일 아래를 폴더로 쓰려 하면 실패한다 — 권한이 막힌 홈과 같은 결과다.
    const blocker = path.join(env.DEX_CLI_HOME ?? '', 'blocked');
    await writeFile(blocker, 'not a directory', 'utf8');
    const blocked = { DEX_CLI_HOME: path.join(blocker, 'dex') } as NodeJS.ProcessEnv;
    await writePreferences({ hangulMode: true }, blocked);
    // 못 적었어도 읽기는 기본값으로 이어진다.
    assert.deepEqual(await readPreferences({ ...blocked, LANG: 'ko_KR.UTF-8' }), { hangulMode: true });
  });
});
