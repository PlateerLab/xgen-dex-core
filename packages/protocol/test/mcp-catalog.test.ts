/**
 * MCP 카탈로그 — 서버와 말이 맞는가(게시 목록 304 · 이벤트 배치), 그리고 변수 규칙.
 * 변수 규칙은 화면 입력 폼과 메인의 설치가 같이 쓰므로 여기서 못박는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from '../src/client';
import {
  CATALOG_EVENT_NAMES,
  McpCatalogApi,
  catalogLaunchFor,
  catalogSupportsDexon,
  catalogTemplateRefs,
  catalogUpdateAvailable,
  compareLooseVersions,
  fetchPublishedCatalog,
  sendCatalogEvents,
  substituteCatalogTemplate,
  validateCatalogValues,
  type CatalogItem,
  type CatalogSpec,
} from '../src/mcp-catalog';

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

function client(reply: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const http = new HttpClient({
    baseUrl: 'https://xgen.test/',
    fetch: async (url, init) => {
      const s: Seen = {
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string,
      };
      seen.push(s);
      return reply(s);
    },
  });
  http.setToken('tok');
  return { http, seen };
}

const item: CatalogItem = {
  catalog_id: 'filesystem',
  name: '파일 시스템',
  revision: 2,
  spec: {
    spec_version: 1,
    transport: 'stdio',
    runtime: { kind: 'node' },
    launch: { command: 'npx', args: ['-y', 'x@1.0.0'] },
  },
};

test('게시 목록: 처음에는 ETag 없이, 다음에는 If-None-Match 로 묻고 304 면 목록 없이 돌려준다', async () => {
  const { http, seen } = client((s) =>
    s.headers['If-None-Match'] === '"v1"'
      ? new Response(null, { status: 304, headers: { ETag: '"v1"' } })
      : new Response(JSON.stringify({ items: [item, { bogus: true }], etag: '"v1"' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
  );
  const first = await fetchPublishedCatalog(http);
  assert.equal(first.notModified, false);
  assert.equal(seen[0].url, 'https://xgen.test/api/dashboard/mcp/catalog/published');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');
  assert.equal(seen[0].headers['If-None-Match'], undefined);
  if (first.notModified) return;
  assert.equal(first.etag, '"v1"');
  assert.deepEqual(
    first.items.map((i) => i.catalog_id),
    ['filesystem'],
    '모양이 틀린 항목은 버린다',
  );
  const second = await new McpCatalogApi(http).published(first.etag);
  assert.deepEqual(second, { notModified: true, etag: '"v1"' });
});

test('게시 목록: 헤더 ETag 만 있어도 쓰고, 오류는 ApiError', async () => {
  const { http } = client(
    () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { ETag: 'W/"abc"', 'content-type': 'application/json' },
      }),
  );
  const r = await fetchPublishedCatalog(http);
  assert.equal(r.etag, 'W/"abc"');
  const failing = client(
    () =>
      new Response(JSON.stringify({ detail: 'no' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await assert.rejects(
    () => fetchPublishedCatalog(failing.http),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('이벤트: device + events 로 보내고, 100개를 넘으면 보내지 않는다', async () => {
  const { http, seen } = client(
    () =>
      new Response(JSON.stringify({ accepted: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const device = {
    device_id: 'd1',
    device_name: 'pc · 데스크톱',
    platform: 'darwin',
    arch: 'arm64',
    dexon_version: '1.110.0',
  };
  const n = await sendCatalogEvents(http, device, [
    { ts: '2026-11-18T00:00:00.000Z', catalog_id: 'filesystem', event: 'install_started' },
  ]);
  assert.equal(n, 1);
  assert.equal(seen[0].url, 'https://xgen.test/api/dashboard/mcp/catalog/events');
  assert.deepEqual(JSON.parse(seen[0].body!), {
    device,
    events: [
      { ts: '2026-11-18T00:00:00.000Z', catalog_id: 'filesystem', event: 'install_started' },
    ],
  });
  const many = Array.from({ length: 101 }, () => ({
    ts: 'x',
    catalog_id: 'a',
    event: 'catalog_viewed' as const,
  }));
  await assert.rejects(() => sendCatalogEvents(http, device, many), /100개/);
  assert.equal(seen.length, 1);
});

test('이벤트 이름은 계약의 고정 목록 그대로다', () => {
  assert.equal(CATALOG_EVENT_NAMES.length, 17);
  assert.ok(CATALOG_EVENT_NAMES.includes('runtime_install_failed'));
  assert.ok(!(CATALOG_EVENT_NAMES as readonly string[]).includes('install_failed'));
});

const spec: CatalogSpec = {
  spec_version: 1,
  transport: 'stdio',
  runtime: { kind: 'node' },
  launch: { command: 'npx', args: ['{{ROOT}}'], platforms: { win32: { command: 'npx.cmd' } } },
  variables: [
    { name: 'ROOT', type: 'path', required: true },
    { name: 'TOKEN', type: 'secret', required: true },
    { name: 'PORT', type: 'number', default: 8080, required: false },
    {
      name: 'MODE',
      type: 'enum',
      options: ['ro', { value: 'rw', label: '읽기/쓰기' }],
      default: 'ro',
      required: false,
    },
    { name: 'DEBUG', type: 'boolean', required: false },
    { name: 'BASE', type: 'url', required: false },
    { name: 'SLUG', type: 'string', pattern: '[a-z]+', required: false },
  ],
};

test('값 검사: 필수 · 경로 · 숫자 · enum · 불리언 · URL · 전체 일치 pattern · 제어 문자', () => {
  const bad = validateCatalogValues(spec, {
    ROOT: 'docs',
    PORT: '80a',
    MODE: 'xx',
    BASE: 'ftp://a',
    SLUG: 'abc1',
    DEBUG: 'maybe',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), [
    'BASE',
    'DEBUG',
    'MODE',
    'PORT',
    'ROOT',
    'SLUG',
    'TOKEN',
  ]);
  const good = validateCatalogValues(spec, {
    ROOT: 'C:\\Users\\me',
    TOKEN: ' s3cret ',
    DEBUG: true,
    BASE: 'https://a.example',
    SLUG: 'abc',
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.values, {
    ROOT: 'C:\\Users\\me',
    TOKEN: 's3cret',
    PORT: '8080',
    MODE: 'ro',
    DEBUG: 'true',
    BASE: 'https://a.example',
    SLUG: 'abc',
  });
  assert.equal(
    validateCatalogValues(spec, { ROOT: '/a', TOKEN: 'x\ny' }).errors.TOKEN,
    '줄바꿈이나 제어 문자는 넣을 수 없습니다.',
  );
  assert.equal(
    validateCatalogValues(spec, { ROOT: '/a' }, { keepSecrets: ['TOKEN'] }).ok,
    true,
    '업데이트: 저장된 비밀 유지',
  );
  assert.equal(validateCatalogValues(spec, { ROOT: '~/Documents', TOKEN: 'x' }).ok, true);
});

test('치환 · 참조 · 플랫폼 실행 명령', () => {
  assert.deepEqual(catalogTemplateRefs('Bearer {{ TOKEN }} {{A}}{{TOKEN}}'), ['TOKEN', 'A']);
  assert.equal(
    substituteCatalogTemplate('Bearer {{TOKEN}}/{{MISSING}}', { TOKEN: 't' }),
    'Bearer t/',
  );
  assert.deepEqual(catalogLaunchFor(spec, 'win32'), { command: 'npx.cmd', args: ['{{ROOT}}'] });
  assert.deepEqual(catalogLaunchFor(spec, 'darwin'), { command: 'npx', args: ['{{ROOT}}'] });
});

test('판 비교 · 업데이트 표시 · Dexon 최소 판', () => {
  assert.ok(compareLooseVersions('v24.22.3', '20.0.0') > 0);
  assert.ok(compareLooseVersions('uv 0.13.9 (x86_64)', '0.13.10') < 0);
  assert.equal(compareLooseVersions('3.12', '3.12.0'), 0);
  assert.equal(catalogUpdateAvailable({ revision: 3 }, { revision: 2 }), true);
  assert.equal(catalogUpdateAvailable({ revision: 2 }, { revision: 2 }), false);
  assert.equal(catalogUpdateAvailable({ revision: 2 }, null), false);
  assert.equal(catalogSupportsDexon({ ...spec, min_dexon_version: '1.110.0' }, '1.109.1'), false);
  assert.equal(catalogSupportsDexon({ ...spec, min_dexon_version: '1.110.0' }, '1.110.0'), true);
});

test('서버 기본값: required 가 없으면 필수, target 이 없으면 env, 빈 pattern/default 는 없음', async () => {
  const { isRequiredVariable, variableTarget } = await import('../src/mcp-catalog');
  const s: CatalogSpec = {
    spec_version: 1,
    transport: 'stdio',
    runtime: { kind: 'uv', min_version: '' },
    launch: { command: 'uvx', args: ['x@1'] },
    variables: [
      { name: 'A', type: 'string' },
      { name: 'B', type: 'string', required: false, pattern: '', default: '' },
    ],
  };
  assert.equal(isRequiredVariable(s.variables![0]), true);
  assert.equal(variableTarget(s.variables![0]), 'env');
  const r = validateCatalogValues(s, {});
  assert.deepEqual(Object.keys(r.errors), ['A']);
  assert.deepEqual(r.values, {}, '비운 선택 변수는 값에 넣지 않는다');
});
