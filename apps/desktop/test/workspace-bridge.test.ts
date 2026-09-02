// 워크스페이스 브리지 — 서버의 ConnectorLocalSandbox 가 이 PC 를 실행 환경으로
// 쓰는 내부 도구(_WorkspaceInfo/_Exec/_ReadBytes/_WriteBytes)를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXEC_TOOL,
  READ_BYTES_TOOL,
  WRITE_BYTES_TOOL,
  WORKSPACE_INFO_TOOL,
  WorkspaceBridge,
  splitVirtualPath,
} from '../src/main/workspace-bridge-tools';

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

function setup(cloud: string | null = null, opts: { synced?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xgen-bridge-'));
  const pokes: string[] = [];
  const flushed: string[] = [];
  const info = (id: string) => (id === 'wf-1' ? { dir, label: '마케팅 리서치' } : null);
  const bridge = new WorkspaceBridge({
    infoFor: info,
    ensureSynced: async (id) => ({ info: info(id), synced: opts.synced ?? true }),
    flushSync: async (id) => {
      flushed.push(id);
      return id === 'wf-1';
    },
    cloudDir: () => cloud,
    poke: (id) => pokes.push(id),
  });
  return { dir, bridge, pokes, flushed };
}

test('가상 경로 규약 — /ws·/cloud 만 통과, 탈출 경로는 거절', () => {
  assert.deepEqual(splitVirtualPath('/ws'), { root: 'ws', rel: '' });
  assert.deepEqual(splitVirtualPath('/ws/a/b.md'), { root: 'ws', rel: 'a/b.md' });
  assert.deepEqual(splitVirtualPath('/cloud/문서'), { root: 'cloud', rel: '문서' });
  assert.equal(splitVirtualPath('/etc/passwd'), null);
  assert.equal(splitVirtualPath('/ws/../etc'), null);
  assert.equal(splitVirtualPath('ws/a'), null);
  assert.equal(splitVirtualPath('/ws\\a'), null);
  assert.equal(splitVirtualPath(''), null);
});

test('_WorkspaceInfo — 물리 경로를 숨기고 가상 루트·클라우드·synced 를 알린다', async () => {
  const { dir, bridge } = setup('/mnt/xgen-drive');
  const on = parse(await bridge.callTool(WORKSPACE_INFO_TOOL, { workflowId: 'wf-1' }));
  assert.equal(on.enabled, true);
  assert.equal(on.synced, true); // ensureSynced 가 하이드레이트를 끝냈다
  assert.equal(on.virtualRoot, '/ws');
  assert.equal(on.dir, '/ws');
  assert.notEqual(on.dir, dir);
  assert.equal(on.pathDomain, 'connector_virtual');
  assert.equal(on.cloudMounted, true);
  assert.equal(on.cloudVirtualRoot, '/cloud');
  assert.equal(on.cloudDir, '/cloud');
  const off = parse(await bridge.callTool(WORKSPACE_INFO_TOOL, { workflowId: 'wf-없음' }));
  assert.equal(off.enabled, false);
});

test('_WorkspaceInfo — 하이드레이트가 늦어도 물리 경로 없이 synced:false를 준다', async () => {
  const { bridge } = setup(null, { synced: false });
  const on = parse(await bridge.callTool(WORKSPACE_INFO_TOOL, { workflowId: 'wf-1' }));
  assert.equal(on.enabled, true);
  assert.equal(on.synced, false); // 실행은 진행, 서버가 프롬프트로 안내
  assert.equal(on.dir, '/ws');
});

test('_FlushSync — 턴 종료에 로컬 변경을 인덱스로 밀고 결과를 준다', async () => {
  const { bridge, flushed } = setup();
  const r = parse(await bridge.callTool('_FlushSync', { workflowId: 'wf-1' }));
  assert.equal(r.flushed, true);
  assert.deepEqual(flushed, ['wf-1']);
});

test('_Exec — bash 명령이 워크스페이스 cwd 에서 돌고 출력이 돌아온다', async () => {
  const { dir, bridge, pokes } = setup();
  const r = parse(
    await bridge.callTool(EXEC_TOOL, {
      workflowId: 'wf-1',
      // cwd 검증은 pwd 문자열 비교가 아니라 **파일 마커**로 한다 — Windows
      // Git Bash 의 pwd 는 POSIX 표기(/tmp/…)를 내놓아 실경로와 문자열이
      // 다르다 (v1.52.0 CI 실증). 마커가 실폴더에 생기면 cwd 가 맞은 것이다.
      argv: ['bash', '-lc', 'touch cwd-마커 && echo 안녕 && echo err >&2'],
    }),
  );
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(dir, 'cwd-마커')), 'cwd 가 워크스페이스가 아니다');
  const out = Buffer.from(String(r.stdoutB64), 'base64').toString();
  assert.ok(out.includes('안녕'));
  assert.ok(Buffer.from(String(r.stderrB64), 'base64').toString().includes('err'));
  assert.deepEqual(pokes, ['wf-1']); // 실행 후 동기화 예약
  rmSync(dir, { recursive: true, force: true });
});

test('_Exec — 파일을 만들면 실제 로컬 폴더에 생긴다 (에이전트 Bash 의 실체)', async () => {
  const { dir, bridge } = setup();
  const r = parse(
    await bridge.callTool(EXEC_TOOL, {
      workflowId: 'wf-1',
      argv: ['bash', '-lc', 'mkdir -p 산출물 && echo 보고서 > 산출물/최종.md'],
      cwd: '/ws',
    }),
  );
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, '산출물', '최종.md'), 'utf8').trim(), '보고서');
  rmSync(dir, { recursive: true, force: true });
});

test('_Exec — cwd 가 규약 밖이면 실행하지 않는다', async () => {
  const { bridge } = setup();
  const r = await bridge.callTool(EXEC_TOOL, {
    workflowId: 'wf-1',
    argv: ['bash', '-lc', 'true'],
    cwd: '/etc',
  });
  assert.equal(r.isError, true);
});

test('_Exec — 없는 명령은 127 + 안내 (예외가 아니라 결과)', async () => {
  const { bridge } = setup();
  const r = parse(
    await bridge.callTool(EXEC_TOOL, {
      workflowId: 'wf-1',
      argv: ['이런명령은없다-xyz'],
    }),
  );
  assert.equal(r.code, 127);
  assert.ok(Buffer.from(String(r.stderrB64), 'base64').toString().includes('찾을 수 없습니다'));
});

test('_Exec — 시간 초과는 124 로 끝난다 (매달리지 않는다)', async () => {
  const { bridge } = setup();
  const t0 = Date.now();
  const r = parse(
    await bridge.callTool(EXEC_TOOL, {
      workflowId: 'wf-1',
      argv: ['bash', '-lc', 'sleep 30'],
      timeoutS: 1,
    }),
  );
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t0 < 5000, '타임아웃이 걸리지 않았다');
});

test('_WriteBytes → _ReadBytes 왕복 — 바이트가 그대로다', async () => {
  const { dir, bridge, pokes } = setup();
  const data = Buffer.from([0, 1, 2, 255, 254, 0x41]);
  const w = parse(
    await bridge.callTool(WRITE_BYTES_TOOL, {
      workflowId: 'wf-1',
      path: '/ws/깊은/폴더/이진.bin',
      dataB64: data.toString('base64'),
    }),
  );
  assert.equal(w.bytes, data.length);
  assert.ok(pokes.includes('wf-1'));
  const r = parse(
    await bridge.callTool(READ_BYTES_TOOL, { workflowId: 'wf-1', path: '/ws/깊은/폴더/이진.bin' }),
  );
  assert.deepEqual(Buffer.from(String(r.dataB64), 'base64'), data);
  rmSync(dir, { recursive: true, force: true });
});

test('_ReadBytes — 없는 파일은 notFound (오류 뭉개기 금지)', async () => {
  const { bridge } = setup();
  const r = parse(
    await bridge.callTool(READ_BYTES_TOOL, { workflowId: 'wf-1', path: '/ws/없다.md' }),
  );
  assert.equal(r.notFound, true);
});

test('_ReadBytes — /ws 내부 심볼릭 링크로 물리 루트를 탈출할 수 없다', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'xgen-bridge-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  const { dir, bridge } = setup();
  symlinkSync(outside, join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = await bridge.callTool(READ_BYTES_TOOL, {
    workflowId: 'wf-1',
    path: '/ws/escape/secret.txt',
  });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'PATH_DOMAIN_MISMATCH');
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('클라우드 루트 — 마운트돼 있으면 /cloud 가 드라이브 실경로로 매핑된다', async () => {
  const cloudDir = mkdtempSync(join(tmpdir(), 'xgen-cloud-'));
  writeFileSync(join(cloudDir, '메모.md'), '클라우드 파일');
  const { bridge } = setup(cloudDir);
  const r = parse(
    await bridge.callTool(READ_BYTES_TOOL, { workflowId: 'wf-1', path: '/cloud/메모.md' }),
  );
  assert.equal(Buffer.from(String(r.dataB64), 'base64').toString(), '클라우드 파일');
  rmSync(cloudDir, { recursive: true, force: true });
});

test('클라우드 미마운트 — /cloud 는 닫혀 있다', async () => {
  const { bridge } = setup(null);
  const r = await bridge.callTool(READ_BYTES_TOOL, { workflowId: 'wf-1', path: '/cloud/메모.md' });
  assert.equal(r.isError, true);
});

test('동기화 대상이 아닌 에이전트는 전부 거절된다', async () => {
  const { bridge } = setup();
  const r = await bridge.callTool(EXEC_TOOL, {
    workflowId: 'wf-없음',
    argv: ['bash', '-lc', 'true'],
  });
  assert.equal(r.isError, true);
});
