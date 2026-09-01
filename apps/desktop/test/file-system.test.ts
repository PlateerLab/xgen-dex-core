// 파일 시스템 컨트롤러 — 두 토글(기본 OFF)·대상 산출·브리지 온디맨드 페어.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_WORKSPACE_FOLDER,
  CLOUD_FOLDER,
  FileSystemController,
  accountKey,
  agentTargets,
  cloudTargets,
  type FileSystemPersistConfig,
} from '../src/main/file-system';
import type { SyncRemote } from '../src/main/local-sync';

/** 아무 일도 하지 않는 원격 — 페어 수명만 검증한다. */
function nullRemote(): SyncRemote {
  return {
    changes: async () => ({ latest_seq: 0, changes: [] }),
    download: async () => undefined,
    put: async () => ({ sha256: '' }),
    del: async () => undefined,
    mkdir: async () => undefined,
  } as unknown as SyncRemote;
}

test('cloudTargets — 토글 OFF/로그아웃이면 비고, ON 이면 user:<id> 하나', () => {
  assert.deepEqual(cloudTargets(null, true), []);
  assert.deepEqual(cloudTargets('7', false), []);
  const t = cloudTargets('7', true);
  assert.equal(t.length, 1);
  assert.equal(t[0].workflowId, 'user:7');
  assert.equal(t[0].folder, CLOUD_FOLDER);
});

test('agentTargets — 토글 ON 이면 **전부**, 폴더명은 라벨 기반 중복 제거', () => {
  const agents = [
    { workflowId: 'wf-1', label: '보고서봇' },
    { workflowId: 'wf-2', label: '보고서봇' }, // 같은 라벨 — 폴더가 겹치면 안 된다
    { workflowId: 'wf-3', label: '' },
  ];
  assert.deepEqual(agentTargets(agents, false), []);
  const t = agentTargets(agents, true);
  assert.equal(t.length, 3);
  const folders = t.map((x) => x.folder);
  assert.equal(new Set(folders).size, 3, `폴더 중복: ${folders}`);
  assert.equal(t[2].label, 'wf-3'); // 빈 라벨은 workflowId 로
});

function makeController(root: string, cfg: FileSystemPersistConfig, persisted: FileSystemPersistConfig[]) {
  let current = { ...cfg };
  const ctrl = new FileSystemController({
    dataRoot: () => root,
    loggedIn: () => true,
    userId: () => '7',
    config: () => current,
    persist: (next) => {
      current = next;
      persisted.push(next);
    },
    listAgents: async () => [
      { workflowId: 'wf-1', label: 'A' },
      { workflowId: 'wf-2', label: 'B' },
    ],
    remoteFor: () => nullRemote(),
    stateDir: () => join(root, '.state'),
    deviceName: 'test-pc',
    intervalMs: 0,
  });
  return { ctrl, current: () => current };
}

test('기본은 둘 다 OFF — 페어가 서지 않고, 상태에는 에이전트 목록이 그래도 보인다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-'));
  const persisted: FileSystemPersistConfig[] = [];
  const { ctrl } = makeController(root, {}, persisted);
  try {
    await ctrl.refreshAgents();
    const st = ctrl.status();
    assert.equal(st.cloud.enabled, false);
    assert.equal(st.cloud.synced, false);
    assert.equal(st.agents.enabled, false);
    // 전부 보이되 synced=false — 탐색기의 "서버 보기" 근거.
    assert.equal(st.agents.list.length, 2);
    assert.ok(st.agents.list.every((a) => !a.synced));
    assert.equal(st.cloud.dir, join(root, CLOUD_FOLDER));
    assert.equal(st.agents.root, join(root, AGENT_WORKSPACE_FOLDER));
  } finally {
    ctrl.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('토글 ON → 대상이 서고, 다시 OFF → 걷힌다 (설정 영속 포함)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-'));
  const persisted: FileSystemPersistConfig[] = [];
  const { ctrl } = makeController(root, {}, persisted);
  try {
    await ctrl.setCloudSync(true);
    assert.equal(persisted.at(-1)?.cloudSync, true);
    assert.equal(ctrl.status().cloud.synced, true);
    assert.equal(ctrl.cloudDir(), join(root, CLOUD_FOLDER));

    await ctrl.setAgentSync(true);
    assert.equal(persisted.at(-1)?.agentSync, true);
    const st = ctrl.status();
    assert.ok(st.agents.list.every((a) => a.synced));
    assert.equal(st.agents.list[0].dir, join(root, AGENT_WORKSPACE_FOLDER, 'A'));

    await ctrl.setAgentSync(false);
    await ctrl.setCloudSync(false);
    const off = ctrl.status();
    assert.ok(off.agents.list.every((a) => !a.synced));
    assert.equal(off.cloud.synced, false);
    assert.equal(ctrl.cloudDir(), null); // 브리지 /cloud 는 토글 OFF 면 닫힌다
  } finally {
    ctrl.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('브리지 온디맨드 페어는 토글 OFF 에서도 동작한다 (커넥터 세션 실행 전제)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-'));
  const { ctrl } = makeController(root, {}, []);
  try {
    const dir = ctrl.ensurePair('wf-외부', '외부 에이전트');
    assert.ok(dir && dir.startsWith(join(root, AGENT_WORKSPACE_FOLDER)), String(dir));
    // 목록 밖 에이전트여도 상태에 노출된다 (탐색기에서 보인다).
    await ctrl.refreshAgents();
    const st = ctrl.status();
    assert.ok(st.agents.list.some((a) => a.workflowId === 'wf-외부' && a.synced));
  } finally {
    ctrl.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('accountKey — 서버|사용자 조합', () => {
  assert.equal(accountKey('https://x', 7), 'https://x|7');
});
