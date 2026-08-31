/**
 * 자격증명 저장소 사다리 — OS 키체인이 없어도 로그인이 되어야 한다.
 *
 * 예전에는 keytar 를 못 불러오면 그냥 던졌다. 그래서 세 가지 흔한 환경에서
 * **로그인 자체가 불가능**했다: 새 npm 이 설치 스크립트를 막아 네이티브 바인딩이
 * 안 깔린 경우, 키링이 없는 헤드리스 서버, D-Bus 가 없는 컨테이너.
 *
 * 여기서는 keytar 가 없는 상태(이 테스트 환경이 그렇다)를 그대로 쓴다 — 파일
 * 사다리로 내려가고, 저장한 것이 다시 읽히고, 파일은 소유자만 읽을 수 있어야 한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// dataDirectory() 가 이 값을 본다 — 진짜 홈을 건드리지 않는다.
const home = mkdtempSync(join(tmpdir(), 'dex-cred-'));
process.env.DEX_CLI_HOME = home;

// 이 테스트는 **키체인이 없는 환경**을 검증한다. 개발자 노트북에는 키링이 있고
// CI 러너에는 없으므로, 둘 다에서 같은 것을 보려면 명시적으로 꺼야 한다.
// (그 스위치 자체도 사용자 기능이다 — 키링이 매번 암호를 묻는 환경에서 쓴다.)
process.env.DEX_NO_KEYCHAIN = '1';

const { SystemCredentialStore, credentialBackend } = await import('../src/credential-store');

const session = { serverUrl: 'https://xgen.example.com', accessToken: 'a', refreshToken: 'r' };

test('키체인이 없으면 파일로 내려가고, 저장한 것이 다시 읽힌다', async () => {
  const store = new SystemCredentialStore();
  await store.set('corp', session);

  assert.equal(credentialBackend(), 'file', 'keytar 가 없는 환경이므로 파일이어야 한다');
  assert.deepEqual(await store.get('corp'), session);
});

test('자격증명 파일은 소유자만 읽을 수 있다', async () => {
  const store = new SystemCredentialStore();
  await store.set('corp', session);

  const path = join(home, 'credentials.json');
  assert.ok(existsSync(path), '파일이 만들어져야 한다');
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `0600 이어야 한다 (실제 ${mode.toString(8)})`);
});

test('없는 프로필은 null — 던지지 않는다', async () => {
  assert.equal(await new SystemCredentialStore().get('nope'), null);
});

test('지우면 사라진다', async () => {
  const store = new SystemCredentialStore();
  await store.set('tmp', session);
  await store.delete('tmp');
  assert.equal(await store.get('tmp'), null);
});

test('SecretPort(getRaw/setRaw)도 같은 사다리를 탄다 — MCP 시크릿이 같이 산다', async () => {
  const store = new SystemCredentialStore();
  await store.setRaw('xgen_mcp_secret_atlassian', '{"env":{"TOKEN":"t"}}');
  assert.equal(await store.getRaw('xgen_mcp_secret_atlassian'), '{"env":{"TOKEN":"t"}}');
  await store.setRaw('xgen_mcp_secret_atlassian', null);
  assert.equal(await store.getRaw('xgen_mcp_secret_atlassian'), null);
});

test('마지막 항목을 지우면 파일도 남기지 않는다', async () => {
  const store = new SystemCredentialStore();
  // 앞 테스트들이 남긴 것을 먼저 비운다 — '마지막 하나' 를 검증하려면 정말로
  // 마지막이어야 한다. 테스트가 서로의 상태에 기대면 순서만 바뀌어도 깨진다.
  for (const name of Object.keys(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')))) {
    await store.setRaw(name, null);
  }
  await store.set('only', session);
  await store.delete('only');
  assert.equal(existsSync(join(home, 'credentials.json')), false);
});
