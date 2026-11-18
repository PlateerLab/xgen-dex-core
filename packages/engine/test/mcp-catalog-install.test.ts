/**
 * 카탈로그 설치 — 설정 만들기(치환 · env 대상 · 플랫폼 덮어쓰기 · 비밀 규칙)와
 * 설치 상태 기계(이벤트 순서 · 동의 거절 · 실패 · 취소 · 업데이트 · 비밀 가림).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogEventIn, CatalogItem } from '@dex/protocol/mcp-catalog';
import {
  CatalogInstallError,
  catalogServerName,
  renderCatalogServer,
  runCatalogInstall,
  type CatalogInstallDeps,
  type CatalogInstallProgress,
} from '../src/mcp-catalog-install';
import type { RuntimePlan } from '../src/mcp-runtime-manager';
import { RuntimeInstallError } from '../src/mcp-runtime-manager';

function item(
  over: Partial<CatalogItem['spec']> = {},
  top: Partial<CatalogItem> = {},
): CatalogItem {
  return {
    catalog_id: 'filesystem',
    name: '파일 시스템',
    revision: 3,
    spec: {
      spec_version: 1,
      transport: 'stdio',
      runtime: { kind: 'node', min_version: '20.0.0' },
      package: {
        registry: 'npm',
        name: '@modelcontextprotocol/server-filesystem',
        version: '2025.8.21',
      },
      launch: {
        command: 'npx',
        args: [
          '-y',
          '@modelcontextprotocol/server-filesystem@2025.8.21',
          '{{ROOT_DIR}}',
          '{{EXTRA}}',
        ],
        platforms: { win32: { command: 'npx.cmd' } },
      },
      env: { FIXED_FLAG: '1' },
      variables: [
        { name: 'ROOT_DIR', label: '허용할 폴더', type: 'path', required: true, target: 'arg' },
        { name: 'EXTRA', type: 'string', required: false, target: 'arg' },
        { name: 'API_TOKEN', type: 'secret', required: true, target: 'env' },
        { name: 'MODE', type: 'enum', options: ['ro', 'rw'], default: 'ro', target: 'env' },
      ],
      ...over,
    },
    ...top,
  };
}

const SECRET = 'sk-live-ABCDEF0123456789';

test('설정 만들기: {{VAR}} 치환 · 빈 선택 인자 제거 · env 대상 · 고정 env · 플랫폼 덮어쓰기', () => {
  const r = renderCatalogServer(
    item(),
    { ROOT_DIR: '/Users/me/My Docs', API_TOKEN: SECRET, MODE: 'rw' },
    { platform: 'darwin', serverName: 'filesystem' },
  );
  assert.equal(r.config.command, 'npx');
  assert.deepEqual(r.config.args, [
    '-y',
    '@modelcontextprotocol/server-filesystem@2025.8.21',
    '/Users/me/My Docs',
  ]);
  assert.deepEqual(r.config.env, { FIXED_FLAG: '1', API_TOKEN: SECRET, MODE: 'rw' });
  assert.deepEqual(r.secretValues, { API_TOKEN: SECRET });
  assert.deepEqual(r.plainValues, { ROOT_DIR: '/Users/me/My Docs', MODE: 'rw' });
  assert.deepEqual(r.config.catalog, {
    catalog_id: 'filesystem',
    revision: 3,
    values: { ROOT_DIR: '/Users/me/My Docs', MODE: 'rw' },
  });
  assert.ok(
    !JSON.stringify(r.config.catalog).includes(SECRET),
    '비밀 값은 catalog.values 에 남지 않는다',
  );
  const win = renderCatalogServer(
    item(),
    { ROOT_DIR: 'C:\\Users\\me', API_TOKEN: SECRET },
    { platform: 'win32', serverName: 'filesystem' },
  );
  assert.equal(win.config.command, 'npx.cmd');
});

test('설정 만들기(http): 주소 · 헤더 치환, 비어 있는 선택 헤더는 빠진다, oauth', () => {
  const it = item({
    transport: 'http',
    runtime: { kind: 'none' },
    launch: null,
    env: null,
    http: {
      url: 'https://{{HOST}}/mcp',
      headers: { Authorization: 'Bearer {{TOKEN}}', 'X-Team': '{{TEAM}}' },
      auth: 'none',
    },
    variables: [
      { name: 'HOST', type: 'string', required: true },
      { name: 'TOKEN', type: 'secret', required: true, target: 'header' },
      { name: 'TEAM', type: 'string' },
    ],
  });
  const r = renderCatalogServer(
    it,
    { HOST: 'mcp.example.com', TOKEN: 'tok-xyz-123' },
    { platform: 'linux', serverName: 'x' },
  );
  assert.equal(r.config.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(r.config.headers, { Authorization: 'Bearer tok-xyz-123' });
  assert.equal(r.config.transport, 'http');
});

test('설정 만들기: 선언 안 된 {{X}} · 실행 인자 안의 비밀 변수는 정의 오류', () => {
  assert.throws(
    () =>
      renderCatalogServer(
        item({ launch: { command: 'npx', args: ['{{NOPE}}'] } }),
        { ROOT_DIR: '/a', API_TOKEN: 'x' },
        { platform: 'linux', serverName: 's' },
      ),
    (e: CatalogInstallError) => e.code === 'spec_invalid' && /NOPE/.test(e.message),
  );
  assert.throws(
    () =>
      renderCatalogServer(
        item({ launch: { command: 'npx', args: ['--token', '{{API_TOKEN}}'] } }),
        { ROOT_DIR: '/a', API_TOKEN: 'x' },
        { platform: 'linux', serverName: 's' },
      ),
    (e: CatalogInstallError) => e.code === 'spec_invalid' && /비밀 변수 API_TOKEN/.test(e.message),
  );
});

test('서버 이름: 충돌하면 -2, -3 … 그리고 local 은 쓰지 않는다', () => {
  assert.equal(catalogServerName('filesystem', []), 'filesystem');
  assert.equal(catalogServerName('filesystem', ['filesystem', 'Filesystem-2']), 'filesystem-3');
  assert.equal(catalogServerName('local', []), 'local-2');
});

// ── 상태 기계 ─────────────────────────────────────────────────────────

function readyPlan(): RuntimePlan {
  return {
    kind: 'node',
    ready: true,
    found: [{ component: 'node', source: 'system', version: '22.0.0', path: '/usr/bin/node' }],
    downloads: [],
    summary: 'Node 22.0.0 사용',
  };
}
function missingPlan(): RuntimePlan {
  return {
    kind: 'node',
    minVersion: '20.0.0',
    ready: false,
    found: [],
    downloads: [
      {
        component: 'node',
        label: 'Node.js',
        version: '24.22.3',
        url: 'https://nodejs.org/dist/v24.22.3/x.tar.gz',
        size: 1,
      },
    ],
    summary: 'Node 20.0.0 이상 필요 — 자동 설치(24.22.3)',
  };
}

function harness(over: Partial<CatalogInstallDeps> = {}) {
  const events: CatalogEventIn[] = [];
  const progress: CatalogInstallProgress[] = [];
  const saved: Array<{ name: string; secrets: Record<string, string>; mode: string }> = [];
  const confirms: string[] = [];
  const deps: CatalogInstallDeps = {
    planRuntime: async () => readyPlan(),
    confirmRuntime: async () => {
      confirms.push('runtime');
      return true;
    },
    ensureRuntime: async () => ({
      installed: [{ component: 'node', version: '24.22.3', durationMs: 1200 }],
    }),
    canonicalize: async (c) => ({
      ...c,
      command: c.command?.startsWith('/') ? c.command : `/abs/${c.command}`,
    }),
    confirmInstall: async () => {
      confirms.push('install');
      return true;
    },
    runSetup: async () => ({
      code: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      aborted: false,
    }),
    test: async () => ({ ok: true, tools: [{ name: 'read_file' }, { name: 'write_file' }] }),
    save: async (config, secrets, mode) => {
      saved.push({ name: config.name, secrets, mode });
    },
    emit: (e) => events.push(e),
    progress: (p) => progress.push(p),
    ...over,
  };
  return { deps, events, progress, saved, confirms };
}

const values = { ROOT_DIR: '/Users/me/Docs', API_TOKEN: SECRET };
const base = {
  serverName: 'filesystem',
  mode: 'install' as const,
  platform: 'linux',
  dexonVersion: '1.110.0',
};

test('성공: install_started → server_test_ok → install_completed, 저장 · 도구 수', async () => {
  const h = harness();
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, true, res.message);
  assert.equal(res.toolCount, 2);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ['install_started', 'server_test_ok', 'install_completed'],
  );
  for (const e of h.events) {
    assert.equal(e.catalog_id, 'filesystem');
    assert.equal(e.revision, 3);
    assert.equal(e.server_name, 'filesystem');
    assert.ok(!Number.isNaN(Date.parse(e.ts)));
  }
  assert.equal(h.events[2].tool_count, 2);
  assert.deepEqual(h.saved, [
    { name: 'filesystem', secrets: { API_TOKEN: SECRET }, mode: 'install' },
  ]);
  assert.deepEqual(h.confirms, ['install'], '런타임이 있으면 설치 승인 한 번만');
  const stages = [...new Set(h.progress.map((p) => p.stage))];
  assert.deepEqual(stages, ['check', 'install', 'setup', 'test', 'done']);
  assert.ok(!JSON.stringify(h.events).includes(SECRET), '이벤트에 비밀 값이 없다');
  assert.ok(!JSON.stringify(h.events).includes('/Users/me/Docs'), '이벤트에 변수 값이 없다');
});

test('런타임 없음 → 동의 → 설치: runtime_missing · runtime_install_ok 가 남는다', async () => {
  const h = harness({ planRuntime: async () => missingPlan() });
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(
    h.events.map((e) => e.event),
    [
      'install_started',
      'runtime_missing',
      'runtime_install_ok',
      'server_test_ok',
      'install_completed',
    ],
  );
  const ok = h.events.find((e) => e.event === 'runtime_install_ok')!;
  assert.equal(ok.runtime, 'node');
  assert.equal(ok.runtime_version, '24.22.3');
  assert.equal(ok.duration_ms, 1200);
  assert.deepEqual(h.confirms, ['runtime', 'install']);
});

test('런타임 내려받기에 동의하지 않으면 install_cancelled(consent_denied) 로 끝나고 아무것도 받지 않는다', async () => {
  let ensured = false;
  const h = harness({
    planRuntime: async () => missingPlan(),
    confirmRuntime: async () => false,
    ensureRuntime: async () => {
      ensured = true;
      return { installed: [] };
    },
  });
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.cancelled, true);
  assert.equal(ensured, false);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ['install_started', 'runtime_missing', 'install_cancelled'],
  );
  assert.equal(h.events[2].error_code, 'consent_denied');
  assert.equal(h.saved.length, 0);
});

test('런타임 설치 실패: runtime_install_failed(코드 · 가린 문구) 후 멈춘다', async () => {
  const h = harness({
    planRuntime: async () => missingPlan(),
    ensureRuntime: async () => {
      throw new RuntimeInstallError(
        'checksum_mismatch',
        `node 파일 무결성(SHA-256) 검증에 실패했습니다 ${SECRET}`,
        'node',
      );
    },
  });
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'checksum_mismatch');
  assert.equal(res.stage, 'install');
  const failed = h.events.at(-1)!;
  assert.equal(failed.event, 'runtime_install_failed');
  assert.equal(failed.error_code, 'checksum_mismatch');
  assert.ok(
    failed.error_message && !failed.error_message.includes(SECRET),
    '오류 문구의 비밀 값은 가린다',
  );
  assert.ok(!res.log.join('\n').includes(SECRET), '로그에도 비밀 값이 없다');
});

test('Docker 처럼 직접 해야 하는 런타임: runtime_missing 후 안내를 돌려준다', async () => {
  const h = harness({
    planRuntime: async () => ({
      kind: 'docker',
      ready: false,
      found: [],
      downloads: [],
      manual: {
        title: 'Docker 를 직접 설치해야 합니다',
        summary: '자동 설치 불가',
        steps: ['설치', '실행'],
        url: 'https://docs.docker.com/get-started/get-docker/',
      },
      summary: 'Docker 필요 — 직접 설치',
    }),
  });
  const res = await runCatalogInstall(
    { ...base, item: item({ runtime: { kind: 'docker' } }), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'runtime_manual_required');
  assert.ok(res.manual);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ['install_started', 'runtime_missing'],
  );
  assert.equal(h.events[1].error_code, 'runtime_manual_required');
});

test('setup 실패: setup_failed(단계 번호) 후 연결 시험 없이 멈춘다', async () => {
  let tested = false;
  const h = harness({
    runSetup: async () => ({
      code: 1,
      signal: null,
      stdout: '',
      stderr: `boom token=${SECRET}`,
      timedOut: false,
      aborted: false,
    }),
    test: async () => {
      tested = true;
      return { ok: true };
    },
  });
  const it = item({
    setup: [
      {
        command: 'npx',
        args: ['-y', 'playwright@1.56.1', 'install', 'chromium'],
        description: '브라우저 받기',
      },
    ],
  });
  const res = await runCatalogInstall(
    { ...base, item: it, values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'setup_failed');
  assert.equal(tested, false);
  const ev = h.events.at(-1)!;
  assert.equal(ev.event, 'setup_failed');
  assert.deepEqual(ev.detail, { step: 1, steps: 1 });
  assert.ok(!JSON.stringify(h.events).includes(SECRET));
});

test('setup 성공은 setup_ok, setup 명령도 승인 화면에 확정 경로로 간다', async () => {
  let approvedSetup: string[] = [];
  const h = harness({
    confirmInstall: async (input) => {
      approvedSetup = input.setup.map((s) => s.command);
      return true;
    },
  });
  const it = item({
    setup: [{ command: 'npx', args: ['-y', 'playwright@1.56.1', 'install', 'chromium'] }],
  });
  const res = await runCatalogInstall(
    { ...base, item: it, values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(approvedSetup, ['/abs/npx']);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ['install_started', 'setup_ok', 'server_test_ok', 'install_completed'],
  );
});

test('연결 시험 실패: server_test_failed 이고 저장하지 않는다', async () => {
  const h = harness({
    test: async () => ({
      ok: false,
      error: `MCP error -32000: Connection closed (${SECRET})`,
      hints: ['npm ERR! 404'],
    }),
  });
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'test_failed');
  assert.deepEqual(res.hints, ['npm ERR! 404']);
  assert.equal(h.saved.length, 0);
  assert.equal(h.events.at(-1)!.event, 'server_test_failed');
  assert.ok(!h.events.at(-1)!.error_message!.includes(SECRET));
});

test('설치 승인을 거절하면 install_cancelled(consent_denied)', async () => {
  const h = harness({ confirmInstall: async () => false });
  const res = await runCatalogInstall(
    { ...base, item: item(), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.cancelled, true);
  assert.equal(h.events.at(-1)!.event, 'install_cancelled');
  assert.equal(h.events.at(-1)!.detail?.stage, 'confirm');
});

test('연결 시험 도중 취소: 기다리지 않고 install_cancelled(user_cancelled), 저장 없음', async () => {
  const ctrl = new AbortController();
  const h = harness({
    test: () =>
      new Promise((resolve) => {
        setTimeout(() => ctrl.abort(), 5);
        setTimeout(() => resolve({ ok: true, tools: [] }), 2000).unref();
      }),
  });
  const res = await runCatalogInstall({ ...base, item: item(), values }, h.deps, ctrl.signal);
  assert.equal(res.cancelled, true);
  assert.equal(res.stage, 'test');
  assert.equal(h.saved.length, 0);
  const last = h.events.at(-1)!;
  assert.equal(last.event, 'install_cancelled');
  assert.equal(last.error_code, 'user_cancelled');
  assert.equal(last.detail?.stage, 'test');
});

test('값 검사 실패는 아무 이벤트 없이 칸별 오류를 돌려준다', async () => {
  const h = harness();
  const res = await runCatalogInstall(
    { ...base, item: item(), values: { ROOT_DIR: 'relative/path' } },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'validation');
  assert.ok(res.fieldErrors?.ROOT_DIR);
  assert.ok(res.fieldErrors?.API_TOKEN);
  assert.equal(h.events.length, 0);
});

test('Dexon 이 낮으면 설치하지 않는다', async () => {
  const h = harness();
  const res = await runCatalogInstall(
    { ...base, dexonVersion: '1.100.0', item: item({ min_dexon_version: '1.110.0' }), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'dexon_too_old');
  assert.equal(h.events.length, 0);
});

test('업데이트: 비워 둔 비밀은 키체인 값으로 채우고 server_updated 로 끝난다', async () => {
  const h = harness();
  const res = await runCatalogInstall(
    {
      ...base,
      mode: 'update',
      item: item({}, { revision: 4 }),
      values: { ROOT_DIR: '/Users/me/Docs', API_TOKEN: '' },
      storedSecrets: { API_TOKEN: SECRET },
    },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(h.saved[0].secrets, { API_TOKEN: SECRET });
  assert.equal(h.events.at(-1)!.event, 'server_updated');
  assert.equal(h.events.at(-1)!.revision, 4);
  assert.equal(h.events[0].detail?.mode, 'update');
});

test('실행 파일을 못 찾으면 runtime_missing(exec_not_found) 와 설치 안내', async () => {
  const h = harness({
    canonicalize: async () => {
      const e = new Error('"my-mcp" — 실행 파일을 찾을 수 없습니다') as Error & { hints: string[] };
      e.name = 'ExecNotFoundError';
      e.hints = ['설치: brew install my-mcp'];
      throw e;
    },
  });
  const res = await runCatalogInstall(
    { ...base, item: item({ runtime: { kind: 'binary' } }), values },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.code, 'exec_not_found');
  assert.deepEqual(res.hints, ['설치: brew install my-mcp']);
  assert.equal(h.events.at(-1)!.event, 'runtime_missing');
  assert.equal(h.events.at(-1)!.error_code, 'exec_not_found');
});

test('저장 비교: 켜기 · 끄기 · 직접 편집 · 삭제 · 출처 사라짐, 카탈로그 아닌 서버는 무시', async () => {
  const { catalogSaveEvents } = await import('../src/mcp-catalog-install');
  const cat = (name: string, over: object = {}) => ({
    name,
    transport: 'stdio' as const,
    command: '/abs/npx',
    args: ['-y', 'x@1'],
    catalog: { catalog_id: 'fs', revision: 2 },
    ...over,
  });
  const plain = { name: 'mine', transport: 'stdio' as const, command: 'x' };
  const prev = [cat('a'), cat('b', { enabled: false }), cat('c'), cat('d'), cat('e'), plain];
  const next = [
    cat('a', { enabled: false }),
    cat('b'),
    cat('c', { args: ['-y', 'x@2'] }),
    { ...cat('e'), catalog: undefined },
    { ...plain, enabled: false },
  ];
  const evs = catalogSaveEvents(prev, next, () => 0);
  assert.deepEqual(
    evs.map((e) => `${e.server_name}:${e.event}${e.detail ? ':' + JSON.stringify(e.detail) : ''}`),
    [
      'a:server_disabled',
      'b:server_enabled',
      'c:server_updated:{"source":"manual"}',
      'd:server_removed:{"reason":"removed"}',
      'e:server_removed:{"reason":"detached"}',
    ],
  );
  assert.ok(evs.every((e) => e.catalog_id === 'fs' && e.revision === 2));
});

test('xgen-core 기본 항목 모양: target 없는 변수는 env, 비운 선택 변수는 env 에 없음, GitHub 헤더 비밀', () => {
  const atl = item({
    runtime: { kind: 'uv', min_version: null },
    launch: { command: 'uvx', args: ['mcp-atlassian@0.24.6'] },
    env: {},
    variables: [
      { name: 'JIRA_URL', type: 'url' },
      { name: 'JIRA_API_TOKEN', type: 'secret', secret: true },
      { name: 'CONFLUENCE_URL', type: 'url', required: false },
    ],
  });
  const r = renderCatalogServer(
    atl,
    { JIRA_URL: 'https://c.atlassian.net', JIRA_API_TOKEN: 'tok' },
    { platform: 'linux', serverName: 'atlassian' },
  );
  assert.deepEqual(r.config.env, { JIRA_URL: 'https://c.atlassian.net', JIRA_API_TOKEN: 'tok' });
  const gh = item({
    transport: 'http',
    runtime: { kind: 'none', min_version: null },
    launch: null,
    env: {},
    http: {
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer {{GITHUB_TOKEN}}' },
      auth: 'none',
    },
    variables: [
      { name: 'GITHUB_TOKEN', type: 'secret', required: true, secret: true, target: 'header' },
    ],
  });
  const g = renderCatalogServer(
    gh,
    { GITHUB_TOKEN: 'github_pat_x' },
    { platform: 'linux', serverName: 'github' },
  );
  assert.deepEqual(g.config.headers, { Authorization: 'Bearer github_pat_x' });
  assert.equal(g.config.env, undefined);
  assert.deepEqual(g.secretValues, { GITHUB_TOKEN: 'github_pat_x' });
});

test('OAuth 원격 서버: 연결 시험을 건너뛰고 저장, 인가가 필요하다고 알린다', async () => {
  let tested = false;
  const h = harness({
    test: async () => {
      tested = true;
      return { ok: false };
    },
  });
  const it = item({
    transport: 'http',
    runtime: { kind: 'none' },
    launch: null,
    env: null,
    http: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
    variables: [],
  });
  const res = await runCatalogInstall(
    { ...base, item: it, values: {} },
    h.deps,
    new AbortController().signal,
  );
  assert.equal(res.ok, true, res.message);
  assert.equal(res.needsAuthorization, true);
  assert.equal(tested, false);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ['install_started', 'install_completed'],
  );
  assert.equal(h.events[1].detail?.needs_authorization, true);
});
