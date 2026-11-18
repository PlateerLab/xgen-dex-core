/**
 * 런타임 관리자 — 찾기(시스템 · 앱 설치) · 계획 · 설치(가짜 다운로드).
 *
 * 실제 nodejs.org 대신 시험이 만든 tar.gz 를 가짜 fetch 로 준다. 그 안의 `bin/node` 는
 * 고정 판을 말하는 셸 스크립트다 — 설치기의 "시험 실행" 단계까지 실제로 돈다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  McpRuntimeManager,
  RuntimeInstallError,
  effectiveRuntimeKind,
} from '../src/mcp-runtime-manager';
import { NODE_PIN, UV_PIN, type RuntimePin, runtimeTarget } from '../src/mcp-runtime-pins';
import { augmentedPath, managedBinDirList, setManagedBinDirs } from '../src/exec-resolve';
import { writeTarGz } from './_archives';

const posixOnly = { skip: process.platform === 'win32' || !runtimeTarget() };
const target = runtimeTarget()!;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dex-runtime-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** 가짜 Node 배포물(tar.gz) + 그 해시 · 크기를 담은 판. */
async function fakeNode(
  dir: string,
  version = '24.22.3',
  reported = `v${version}`,
): Promise<{ pin: RuntimePin; archive: Buffer }> {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  const top = `node-v${version}-${target}`;
  mkdirSync(join(src, top, 'bin'), { recursive: true });
  script(join(src, top, 'bin', 'node'), `echo ${reported}`);
  script(join(src, top, 'bin', 'npx'), 'echo npx');
  const file = join(dir, `${top}.tar.gz`);
  await writeTarGz(file, src, [top]);
  const archive = readFileSync(file);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const asset = { file: `${top}.tar.gz`, sha256, size: archive.length, format: 'tar.gz' as const };
  const pin: RuntimePin = {
    ...NODE_PIN,
    version,
    baseUrl: 'https://dist.test/node',
    checksumUrl: () => 'https://dist.test/node/SHASUMS256.txt',
    assets: Object.fromEntries(
      Object.keys(NODE_PIN.assets).map((k) => [k, asset]),
    ) as RuntimePin['assets'],
    matches: (stdout) => stdout.trim() === `v${version}`,
  };
  return { pin, archive };
}

function fakeFetch(files: Record<string, Buffer | string>, calls: string[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const body = files[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
  };
}

/** 빈 PATH(시스템에 아무것도 없음) 또는 가짜 도구가 든 PATH. */
function emptyPath(dir: string): () => Promise<string> {
  const p = join(dir, 'empty-bin');
  mkdirSync(p, { recursive: true });
  return async () => p;
}

test('effectiveRuntimeKind: none 이어도 실행 명령이 npx/uvx 면 그 런타임이 필요하다', () => {
  assert.equal(effectiveRuntimeKind('none', 'npx'), 'node');
  assert.equal(effectiveRuntimeKind('binary', 'uvx.exe'), 'uv');
  assert.equal(effectiveRuntimeKind('none', '/opt/tool/my-mcp'), 'none');
  assert.equal(effectiveRuntimeKind('python', 'uvx'), 'python');
});

test('고정 판은 6개 플랫폼 전부에 해시 · 크기가 있다', () => {
  for (const pin of [NODE_PIN, UV_PIN]) {
    for (const t of [
      'win32-x64',
      'win32-arm64',
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
    ] as const) {
      const a = pin.assets[t];
      assert.match(a.sha256, /^[a-f0-9]{64}$/, `${pin.kind} ${t}`);
      assert.ok(a.size > 1_000_000, `${pin.kind} ${t} size`);
      assert.equal(a.format, t.startsWith('win32') ? 'zip' : 'tar.gz');
    }
  }
  assert.ok(NODE_PIN.assets['linux-x64'].file.includes(NODE_PIN.version));
});

test('시스템 Node 가 최소 판을 만족하면 받지 않는다', posixOnly, async () => {
  const dir = scratch();
  const bin = join(dir, 'sysbin');
  mkdirSync(bin);
  script(join(bin, 'node'), 'echo v22.11.0');
  script(join(bin, 'npx'), 'echo npx');
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch: fakeFetch({}),
    systemPath: async () => bin,
  });
  const ok = await mgr.plan('node', '20.0.0', 'npx');
  assert.equal(ok.ready, true);
  assert.equal(ok.found[0].source, 'system');
  assert.equal(ok.found[0].version, '22.11.0');
  const old = await mgr.plan('node', '24.0.0', 'npx');
  assert.equal(old.ready, false);
  assert.equal(old.downloads[0].component, 'node');
  assert.match(old.downloads[0].url, /^https:\/\/nodejs\.org\/dist\/v24\.22\.3\/node-v24\.22\.3-/);
  assert.match(old.summary, /Node 24\.0\.0 이상 필요 — 자동 설치/);
});

test('npx 가 없는 node 는 쓸 수 없는 것으로 본다', posixOnly, async () => {
  const dir = scratch();
  const bin = join(dir, 'sysbin');
  mkdirSync(bin);
  script(join(bin, 'node'), 'echo v22.11.0');
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch: fakeFetch({}),
    systemPath: async () => bin,
  });
  assert.equal((await mgr.plan('node', null, 'npx')).ready, false);
});

test('고정 판보다 높은 Node 를 요구하면 자동 설치 대신 이유를 말한다', posixOnly, async () => {
  const dir = scratch();
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch: fakeFetch({}),
    systemPath: emptyPath(dir),
  });
  const plan = await mgr.plan('node', '99.0.0', 'npx');
  assert.equal(plan.ready, false);
  assert.match(plan.unsupported ?? '', /99\.0\.0/);
  await assert.rejects(
    () => mgr.ensure(plan),
    (e: RuntimeInstallError) => e.code === 'runtime_unsupported',
  );
});

test('Docker 는 자동 설치하지 않고 단계별 안내를 돌려준다', posixOnly, async () => {
  const dir = scratch();
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch: fakeFetch({}),
    systemPath: emptyPath(dir),
  });
  const plan = await mgr.plan('docker', null, 'docker');
  assert.equal(plan.ready, false);
  assert.ok(plan.manual);
  assert.match(plan.manual!.url, /docs\.docker\.com/);
  assert.ok(plan.manual!.steps.length >= 2);
  await assert.rejects(
    () => mgr.ensure(plan),
    (e: RuntimeInstallError) => e.code === 'runtime_manual_required',
  );
});

test('python 항목: uv 와 Python 을 함께 계획한다(시스템에 둘 다 없을 때)', posixOnly, async () => {
  const dir = scratch();
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch: fakeFetch({}),
    systemPath: emptyPath(dir),
  });
  const plan = await mgr.plan('python', '3.10', 'python');
  assert.deepEqual(
    plan.downloads.map((d) => d.component),
    ['uv', 'python'],
  );
  assert.match(plan.downloads[0].url, /github\.com\/astral-sh\/uv\/releases\/download\/0\.13\.9\//);
});

test(
  '설치: 체크섬 확인 → 내려받기 → 풀기 → 시험 실행 → current.json → PATH 맨 앞',
  posixOnly,
  async () => {
    const dir = scratch();
    const { pin, archive } = await fakeNode(dir);
    const asset = pin.assets[target];
    const calls: string[] = [];
    const fetch = fakeFetch(
      {
        'https://dist.test/node/SHASUMS256.txt': `${'0'.repeat(64)}  other.tar.gz\n${asset.sha256}  ${asset.file}\n`,
        [`https://dist.test/node/${asset.file}`]: archive,
      },
      calls,
    );
    const base = join(dir, 'rt');
    const mgr = new McpRuntimeManager({
      baseDir: base,
      fetch,
      pins: { node: pin },
      systemPath: emptyPath(dir),
    });
    const before = await mgr.plan('node', '20', 'npx');
    assert.equal(before.ready, false);
    const phases: string[] = [];
    const res = await mgr.ensure(before, (p) => phases.push(p.phase));
    assert.equal(res.installed[0].version, '24.22.3');
    assert.deepEqual(calls, [
      'https://dist.test/node/SHASUMS256.txt',
      `https://dist.test/node/${asset.file}`,
    ]);
    for (const phase of ['checksum', 'download', 'verify', 'extract', 'test', 'activate'])
      assert.ok(phases.includes(phase), phase);
    const pointer = JSON.parse(readFileSync(join(base, 'node', 'current.json'), 'utf8'));
    assert.equal(pointer.version, '24.22.3');
    assert.equal(pointer.sha256, asset.sha256);
    const binDir = join(base, 'node', pointer.directory, 'bin');
    assert.ok(existsSync(join(binDir, 'node')));
    assert.equal(managedBinDirList()[0], binDir);
    assert.equal((await augmentedPath()).split(delimiter)[0], binDir);
    assert.equal(
      existsSync(join(base, '.tmp')) ? readdirSync(join(base, '.tmp')).length : 0,
      0,
      '임시 폴더가 남지 않는다',
    );
    const after = await mgr.plan('node', '20', 'npx');
    assert.equal(after.ready, true);
    assert.equal(after.found[0].source, 'managed');
    // 새 관리자(앱 재시작)도 같은 판을 찾아 PATH 에 건다.
    setManagedBinDirs([]);
    const restarted = new McpRuntimeManager({
      baseDir: base,
      fetch,
      pins: { node: pin },
      systemPath: emptyPath(dir),
    });
    assert.deepEqual(restarted.activate(), [binDir]);
    setManagedBinDirs([]);
  },
);

test('받은 파일 해시가 고정 값과 다르면 설치하지 않고 이전 판을 지킨다', posixOnly, async () => {
  const dir = scratch();
  const { pin, archive } = await fakeNode(dir);
  const asset = pin.assets[target];
  const base = join(dir, 'rt');
  // 먼저 정상 설치
  const goodFetch = fakeFetch({
    'https://dist.test/node/SHASUMS256.txt': `${asset.sha256}  ${asset.file}\n`,
    [`https://dist.test/node/${asset.file}`]: archive,
  });
  await new McpRuntimeManager({
    baseDir: base,
    fetch: goodFetch,
    pins: { node: pin },
    systemPath: emptyPath(dir),
  }).installManaged('node');
  const pointerBefore = readFileSync(join(base, 'node', 'current.json'), 'utf8');
  // 새 판: 고정 해시는 원래 것인데 서버가 다른 파일(같은 크기)을 준다
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 10] ^= 0xff;
  const pin2: RuntimePin = { ...pin, version: '24.22.4', matches: () => true };
  const asset2 = pin2.assets[target];
  const badFetch = fakeFetch({
    'https://dist.test/node/SHASUMS256.txt': `${asset2.sha256}  ${asset2.file}\n`,
    [`https://dist.test/node/${asset2.file}`]: tampered,
  });
  const mgr = new McpRuntimeManager({
    baseDir: base,
    fetch: badFetch,
    pins: { node: pin2 },
    systemPath: emptyPath(dir),
  });
  await assert.rejects(
    () => mgr.installManaged('node'),
    (e: RuntimeInstallError) => e.code === 'checksum_mismatch' && /SHA-256/.test(e.message),
  );
  assert.equal(readFileSync(join(base, 'node', 'current.json'), 'utf8'), pointerBefore);
  setManagedBinDirs([]);
});

test('공식 체크섬 파일의 해시가 고정 값과 다르면 내려받기 전에 멈춘다', posixOnly, async () => {
  const dir = scratch();
  const { pin, archive } = await fakeNode(dir);
  const asset = pin.assets[target];
  const calls: string[] = [];
  const fetch = fakeFetch(
    {
      'https://dist.test/node/SHASUMS256.txt': `${'a'.repeat(64)}  ${asset.file}\n`,
      [`https://dist.test/node/${asset.file}`]: archive,
    },
    calls,
  );
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch,
    pins: { node: pin },
    systemPath: emptyPath(dir),
  });
  await assert.rejects(
    () => mgr.installManaged('node'),
    (e: RuntimeInstallError) => e.code === 'checksum_mismatch',
  );
  assert.deepEqual(calls, ['https://dist.test/node/SHASUMS256.txt']);
});

test('시험 실행이 다른 판을 말하면 활성화하지 않는다', posixOnly, async () => {
  const dir = scratch();
  const { pin, archive } = await fakeNode(dir, '24.22.3', 'v1.0.0');
  const asset = pin.assets[target];
  const fetch = fakeFetch({
    'https://dist.test/node/SHASUMS256.txt': `${asset.sha256}  ${asset.file}\n`,
    [`https://dist.test/node/${asset.file}`]: archive,
  });
  const base = join(dir, 'rt');
  const mgr = new McpRuntimeManager({
    baseDir: base,
    fetch,
    pins: { node: pin },
    systemPath: emptyPath(dir),
  });
  await assert.rejects(
    () => mgr.installManaged('node'),
    (e: RuntimeInstallError) => e.code === 'runtime_test_failed',
  );
  assert.equal(existsSync(join(base, 'node', 'current.json')), false);
});

test('내려받는 중 취소하면 cancelled 로 끝나고 임시 파일을 지운다', posixOnly, async () => {
  const dir = scratch();
  const { pin } = await fakeNode(dir);
  const asset = pin.assets[target];
  const ctrl = new AbortController();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('SHASUMS256.txt')) return new Response(`${asset.sha256}  ${asset.file}\n`);
    // 첫 조각을 주고 멈춘다 — 그 사이 사용자가 취소한다.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        init?.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('Aborted', 'AbortError')),
        );
      },
    });
    return new Response(stream, { status: 200 });
  };
  const base = join(dir, 'rt');
  const mgr = new McpRuntimeManager({
    baseDir: base,
    fetch,
    pins: { node: pin },
    systemPath: emptyPath(dir),
  });
  const p = mgr.installManaged(
    'node',
    (prog) => {
      if (prog.phase === 'download') ctrl.abort();
    },
    ctrl.signal,
  );
  await assert.rejects(
    () => p,
    (e: RuntimeInstallError) => e.code === 'cancelled',
  );
  assert.equal(existsSync(join(base, 'node', 'current.json')), false);
  assert.equal(existsSync(join(base, '.tmp')) ? readdirSync(join(base, '.tmp')).length : 0, 0);
});

test('HTTP 오류는 download_failed 로 알린다', posixOnly, async () => {
  const dir = scratch();
  const { pin } = await fakeNode(dir);
  const asset = pin.assets[target];
  const fetch = fakeFetch({
    'https://dist.test/node/SHASUMS256.txt': `${asset.sha256}  ${asset.file}\n`,
  });
  const mgr = new McpRuntimeManager({
    baseDir: join(dir, 'rt'),
    fetch,
    pins: { node: pin },
    systemPath: emptyPath(dir),
  });
  await assert.rejects(
    () => mgr.installManaged('node'),
    (e: RuntimeInstallError) => e.code === 'download_failed' && /404/.test(e.message),
  );
});
