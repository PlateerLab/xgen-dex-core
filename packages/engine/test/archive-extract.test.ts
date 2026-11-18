/** 런타임 압축 풀기 — 안전 검사(경로 · 링크 · CRC · 크기)와 맨 위 폴더 벗기기. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeExtract,
  stripPath,
  validateArchiveEntry,
  UnsafeArchiveError,
} from '../src/archive-extract';
import { writeTarGz, writeZip } from './_archives';

const limits = { maxEntries: 1000, maxExpandedBytes: 10 * 1024 * 1024 };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dex-archive-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('stripPath 는 맨 위 폴더를 벗기고, 벗길 것이 없으면 빈 문자열', () => {
  assert.equal(stripPath('node-v1/bin/node', 1), 'bin/node');
  assert.equal(stripPath('./node-v1/', 1), '');
  assert.equal(stripPath('uv.exe', 0), 'uv.exe');
});

test('항목 검사: 절대 경로 · .. · 역슬래시 · 드라이브 · 장치 파일 · 밖을 가리키는 링크를 거부한다', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'C:/x']) {
    assert.throws(() => validateArchiveEntry(bad, 'File'), UnsafeArchiveError, bad);
  }
  assert.throws(() => validateArchiveEntry('a/dev', 'CharacterDevice'), UnsafeArchiveError);
  assert.throws(
    () => validateArchiveEntry('top/bin/x', 'SymbolicLink', '../../../etc/passwd', 1),
    UnsafeArchiveError,
  );
  assert.throws(
    () => validateArchiveEntry('top/bin/x', 'SymbolicLink', '/etc/passwd', 1),
    UnsafeArchiveError,
  );
  // Node 배포물의 실제 모양: bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js
  validateArchiveEntry(
    'node-v1/bin/npm',
    'SymbolicLink',
    '../lib/node_modules/npm/bin/npm-cli.js',
    1,
  );
  validateArchiveEntry('node-v1/bin/node', 'File', '', 1);
});

test('zip: 저장 · deflate 항목을 맨 위 폴더를 벗겨 푼다', async () => {
  const dir = scratch();
  const zip = join(dir, 'rt.zip');
  writeZip(zip, [
    { name: 'node-v1-win-x64/' },
    { name: 'node-v1-win-x64/node.exe', data: 'binary-ish', deflate: true },
    { name: 'node-v1-win-x64/npx.cmd', data: '@echo off' },
    {
      name: 'node-v1-win-x64/node_modules/npm/bin/npx-cli.js',
      data: 'x'.repeat(5000),
      deflate: true,
    },
  ]);
  const out = join(dir, 'out');
  await safeExtract(zip, out, { ...limits, format: 'zip', strip: 1 });
  assert.equal(readFileSync(join(out, 'node.exe'), 'utf8'), 'binary-ish');
  assert.equal(readFileSync(join(out, 'npx.cmd'), 'utf8'), '@echo off');
  assert.equal(readFileSync(join(out, 'node_modules/npm/bin/npx-cli.js'), 'utf8').length, 5000);
});

test('zip: 밖으로 나가는 경로가 하나라도 있으면 아무것도 풀지 않는다', async () => {
  const dir = scratch();
  const zip = join(dir, 'evil.zip');
  writeZip(zip, [
    { name: 'top/ok.txt', data: 'ok' },
    { name: 'top/../../evil.txt', data: 'pwned' },
  ]);
  const out = join(dir, 'out');
  await assert.rejects(
    () => safeExtract(zip, out, { ...limits, format: 'zip', strip: 1 }),
    UnsafeArchiveError,
  );
  assert.equal(existsSync(join(out, 'ok.txt')), false);
  assert.equal(existsSync(join(dir, 'evil.txt')), false);
});

test('zip: CRC 가 틀리면 거부하고, 심볼릭 링크 항목도 거부한다', async () => {
  const dir = scratch();
  const bad = join(dir, 'bad.zip');
  writeZip(bad, [{ name: 'a.txt', data: 'hello world', deflate: true, badCrc: true }]);
  await assert.rejects(
    () => safeExtract(bad, join(dir, 'o1'), { ...limits, format: 'zip', strip: 0 }),
    /CRC/,
  );
  const link = join(dir, 'link.zip');
  writeZip(link, [{ name: 'l', data: '/etc/passwd', mode: 0o120777 }]);
  await assert.rejects(
    () => safeExtract(link, join(dir, 'o2'), { ...limits, format: 'zip', strip: 0 }),
    UnsafeArchiveError,
  );
});

test('zip: 풀린 크기 상한을 넘으면 거부한다', async () => {
  const dir = scratch();
  const zip = join(dir, 'big.zip');
  writeZip(zip, [{ name: 'a', data: Buffer.alloc(4096), deflate: true }]);
  await assert.rejects(
    () =>
      safeExtract(zip, join(dir, 'o'), {
        maxEntries: 10,
        maxExpandedBytes: 1024,
        format: 'zip',
        strip: 0,
      }),
    /너무 큽니다/,
  );
});

test(
  'tar.gz: 안쪽 링크는 풀고, 밖을 가리키는 링크가 있으면 거부한다',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = scratch();
    const src = join(dir, 'src');
    mkdirSync(join(src, 'node-v1/bin'), { recursive: true });
    mkdirSync(join(src, 'node-v1/lib'), { recursive: true });
    writeFileSync(join(src, 'node-v1/lib/cli.js'), 'cli');
    symlinkSync('../lib/cli.js', join(src, 'node-v1/bin/npm'));
    const good = join(dir, 'good.tgz');
    await writeTarGz(good, src, ['node-v1']);
    const out = join(dir, 'out');
    await safeExtract(good, out, { ...limits, format: 'tar.gz', strip: 1 });
    assert.equal(readFileSync(join(out, 'bin/npm'), 'utf8'), 'cli');

    symlinkSync('../../../../etc/passwd', join(src, 'node-v1/bin/evil'));
    const evil = join(dir, 'evil.tgz');
    await writeTarGz(evil, src, ['node-v1']);
    const out2 = join(dir, 'out2');
    await assert.rejects(
      () => safeExtract(evil, out2, { ...limits, format: 'tar.gz', strip: 1 }),
      UnsafeArchiveError,
    );
    assert.equal(existsSync(out2), false);
  },
);
