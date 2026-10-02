import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secrets, type SecretCrypto } from '../src/main/secrets';

// 시험용 "암호화" — 뒤집기. 진짜 safeStorage 는 Electron 안에서만 돈다.
const reversing = (available = true, backend = ''): SecretCrypto => ({
  available: () => available,
  backend: () => backend,
  encrypt: (s) => Buffer.from([...Buffer.from(s, 'utf8')].reverse()),
  decrypt: (b) => Buffer.from([...b].reverse()).toString('utf8'),
});

const dir = () => join(mkdtempSync(join(tmpdir(), 'xd-secrets-')), 'secrets');

test('암호화해 두고 다시 읽는다', () => {
  const d = dir();
  const s = new Secrets(d, reversing());
  s.set('acc-1', 'sk-ant-비밀');
  assert.equal(s.get('acc-1'), 'sk-ant-비밀');
  const raw = readFileSync(join(d, 'acc-1.bin'));
  assert.equal(raw.subarray(0, 5).toString(), 'enc1\n');
  assert.ok(!raw.toString('utf8').includes('sk-ant'));
  if (process.platform !== 'win32') assert.equal(statSync(join(d, 'acc-1.bin')).mode & 0o777, 0o600);
});

test('암호화를 못 쓰면 평문으로 두되 상태가 그렇다고 말한다', () => {
  const s = new Secrets(dir(), reversing(false));
  s.set('a', 'k');
  assert.equal(s.get('a'), 'k');
  assert.deepEqual(s.status(), { encrypted: false, backend: '' });
  // 리눅스 basic_text 는 암호화가 아니다
  assert.equal(new Secrets(dir(), reversing(true, 'basic_text')).status().encrypted, false);
});

test('지우기·없음·풀 수 없는 파일', () => {
  const d = dir();
  const s = new Secrets(d, reversing());
  assert.equal(s.get('none'), null);
  s.set('a', 'k');
  s.set('a', null);
  assert.equal(s.has('a'), false);
  s.set('b', 'k');
  const broken = new Secrets(d, { ...reversing(), decrypt: () => { throw new Error('other machine'); } });
  assert.equal(broken.get('b'), null);
});

test('id 로 경로를 바꿀 수 없다', () => {
  const s = new Secrets(dir(), reversing());
  assert.throws(() => s.set('../x', 'k'));
  assert.throws(() => s.get('a/b'));
});
