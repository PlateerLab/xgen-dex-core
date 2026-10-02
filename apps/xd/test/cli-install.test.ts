import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xdCliPath } from '../src/main/cli/detect';
import {
  CLAUDE_RELEASES,
  CODEX_RELEASES_API,
  claudePlatform,
  codexTriple,
  installCli,
  planClaude,
  planCodex,
  type Fetcher,
} from '../src/main/cli/install';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fakeFetcher(routes: Record<string, unknown>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const get = (url: string) => {
    asked.push(url);
    if (!(url in routes)) throw new Error(`no route ${url}`);
    return routes[url];
  };
  return {
    asked,
    text: async (url) => String(get(url)),
    json: async (url) => get(url),
    bytes: async (url) => get(url) as Buffer,
  };
}

test('플랫폼 이름 — 설치 스크립트·릴리스 자산과 같은 이름', () => {
  assert.equal(claudePlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(claudePlatform('win32', 'x64'), 'win32-x64');
  assert.equal(claudePlatform('linux', 'x64'), 'linux-x64');
  assert.throws(() => claudePlatform('freebsd', 'x64'));
  assert.equal(codexTriple('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(codexTriple('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.equal(codexTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
});

test('Claude Code: 채널 → 판 → 매니페스트의 체크섬 → 실행 파일 주소', async () => {
  const sum = 'a'.repeat(64);
  const f = fakeFetcher({
    [`${CLAUDE_RELEASES}/stable`]: '2.1.285\n',
    [`${CLAUDE_RELEASES}/2.1.285/manifest.json`]: { platforms: { 'win32-x64': { checksum: sum }, 'linux-x64': { checksum: 'b'.repeat(64) } } },
  });
  const plan = await planClaude(f, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(plan, { name: 'claude', version: '2.1.285', url: `${CLAUDE_RELEASES}/2.1.285/win32-x64/claude.exe`, sha256: sum });
  // 오류 페이지가 판 대신 오면 멈춘다
  const bad = fakeFetcher({ [`${CLAUDE_RELEASES}/stable`]: '<html>unavailable</html>' });
  await assert.rejects(planClaude(bad, { platform: 'linux', arch: 'x64' }), /could not read the Claude Code version/);
  // 이 플랫폼 빌드가 없으면 멈춘다
  const missing = fakeFetcher({
    [`${CLAUDE_RELEASES}/stable`]: '2.1.285',
    [`${CLAUDE_RELEASES}/2.1.285/manifest.json`]: { platforms: {} },
  });
  await assert.rejects(planClaude(missing, { platform: 'darwin', arch: 'arm64' }), /no build for darwin-arm64/);
});

test('Codex: 최신 릴리스에서 이 플랫폼 자산과 sha256(digest)', async () => {
  const release = {
    tag_name: 'rust-v0.160.0',
    assets: [
      { name: 'codex-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://x/linux.tgz', digest: `sha256:${'c'.repeat(64)}` },
      { name: 'codex-x86_64-pc-windows-msvc.exe', browser_download_url: 'https://x/win.exe', digest: `sha256:${'d'.repeat(64)}` },
      { name: 'codex-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://x/mac.tgz', digest: null },
    ],
  };
  const f = fakeFetcher({ [`${CODEX_RELEASES_API}/latest`]: release, [`${CODEX_RELEASES_API}/tags/rust-v0.159.2`]: { ...release, tag_name: 'rust-v0.159.2' } });
  assert.deepEqual(await planCodex(f, { platform: 'linux', arch: 'x64' }), {
    name: 'codex', version: '0.160.0', url: 'https://x/linux.tgz', sha256: 'c'.repeat(64), archiveMember: 'codex-x86_64-unknown-linux-musl',
  });
  const win = await planCodex(f, { platform: 'win32', arch: 'x64' });
  assert.equal(win.url, 'https://x/win.exe');
  assert.equal(win.archiveMember, undefined);
  assert.equal((await planCodex(f, { version: '0.159.2', platform: 'linux', arch: 'x64' })).version, '0.159.2');
  // 체크섬이 없는 자산은 받지 않는다
  await assert.rejects(planCodex(f, { platform: 'darwin', arch: 'arm64' }), /no verified build/);
});

test('설치: sha256 확인 → 실행 확인 → 바꿔 끼우기, 실패하면 쓰던 판이 남는다', async () => {
  const cliDir = join(mkdtempSync(join(tmpdir(), 'xd-cli-')), 'cli');
  const v1 = Buffer.from('#!/bin/sh\necho 1.0.0\n');
  const v2 = Buffer.from('#!/bin/sh\necho 2.0.0\n');
  const f = fakeFetcher({ 'https://x/v1': v1, 'https://x/v2': v2 });
  const runs = async (p: string) => readFileSync(p, 'utf8').match(/echo (\S+)/)?.[1] ?? null;

  const first = await installCli({ name: 'claude', version: '1.0.0', url: 'https://x/v1', sha256: sha(v1) }, { cliDir, fetcher: f, verify: runs, platform: 'linux' });
  assert.equal(first.path, xdCliPath(cliDir, 'claude', 'linux'));
  assert.equal(first.version, '1.0.0');

  await assert.rejects(
    installCli({ name: 'claude', version: '2.0.0', url: 'https://x/v2', sha256: 'f'.repeat(64) }, { cliDir, fetcher: f, verify: runs, platform: 'linux' }),
    /checksum mismatch/,
  );
  await assert.rejects(
    installCli({ name: 'claude', version: '2.0.0', url: 'https://x/v2', sha256: sha(v2) }, { cliDir, fetcher: f, verify: async () => null, platform: 'linux' }),
    /did not run/,
  );
  assert.match(readFileSync(first.path, 'utf8'), /echo 1\.0\.0/); // 쓰던 판 그대로

  const second = await installCli({ name: 'claude', version: '2.0.0', url: 'https://x/v2', sha256: sha(v2) }, { cliDir, fetcher: f, verify: runs, platform: 'linux' });
  assert.equal(second.version, '2.0.0');
  assert.equal(existsSync(`${first.path}.new`), false);
  assert.equal(existsSync(`${first.path}.old`), false);
});

test('설치: Codex 압축본에서 실행 파일 하나를 꺼낸다', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xd-cli-'));
  const stage = join(root, 'stage');
  mkdirSync(stage);
  writeFileSync(join(stage, 'codex-x86_64-unknown-linux-musl'), '#!/bin/sh\necho codex-cli 0.160.0\n');
  const tgz = join(root, 'codex.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'codex-x86_64-unknown-linux-musl']);
  const body = readFileSync(tgz);
  const f = fakeFetcher({ 'https://x/codex.tgz': body });
  const cliDir = join(root, 'cli');
  const done = await installCli(
    { name: 'codex', version: '0.160.0', url: 'https://x/codex.tgz', sha256: sha(body), archiveMember: 'codex-x86_64-unknown-linux-musl' },
    { cliDir, fetcher: f, verify: async (p) => (readFileSync(p, 'utf8').includes('0.160.0') ? '0.160.0' : null), platform: 'linux' },
  );
  assert.equal(done.path, xdCliPath(cliDir, 'codex', 'linux'));
  assert.match(readFileSync(done.path, 'utf8'), /codex-cli 0\.160\.0/);
});
