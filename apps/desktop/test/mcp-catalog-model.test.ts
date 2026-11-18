/** MCP 카탈로그 화면 규칙 — 분류 · 검색 · 설치/업데이트 상태 · 런타임 배지 · 폼 초기값. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogItem } from '@dex/protocol/mcp-catalog';
import {
  catalogCategories,
  catalogErrorTitle,
  catalogInstallState,
  filterCatalog,
  formatBytes,
  initialCatalogValues,
  runtimeBadge,
} from '../src/renderer/src/views/mcp-catalog-model';

const mk = (id: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  catalog_id: id,
  name: id,
  revision: 1,
  spec: {
    spec_version: 1,
    transport: 'stdio',
    runtime: { kind: 'node', min_version: '24.0.0' },
    launch: { command: 'npx' },
  },
  ...over,
});

test('분류: 계약 순서 먼저, 모르는 분류는 뒤에, 없으면 기타', () => {
  const items = [
    mk('a', { category: '협업' }),
    mk('b', { category: '개발' }),
    mk('c', { category: 'ZZ' }),
    mk('d'),
  ];
  assert.deepEqual(catalogCategories(items), ['개발', '협업', '기타', 'ZZ']);
});

test('검색: 이름 · 설명 · 태그 · id · 게시자(대소문자 무시) + 분류', () => {
  const items = [
    mk('github', { name: 'GitHub', tags: ['PR'], category: '개발' }),
    mk('notion', { name: 'Notion', description: '문서 검색', category: '문서' }),
  ];
  assert.deepEqual(
    filterCatalog(items, 'pr', null).map((i) => i.catalog_id),
    ['github'],
  );
  assert.deepEqual(
    filterCatalog(items, '문서', null).map((i) => i.catalog_id),
    ['notion'],
  );
  assert.deepEqual(
    filterCatalog(items, '', '개발').map((i) => i.catalog_id),
    ['github'],
  );
  assert.equal(filterCatalog(items, 'github', '문서').length, 0);
});

test('설치 상태: 없음 → available, 같은 판 → installed, 낮은 판 → update(가장 낮은 서버)', () => {
  const item = mk('fs', { revision: 3 });
  assert.equal(catalogInstallState(item, [{ name: 'x', transport: 'stdio' }]).state, 'available');
  assert.equal(
    catalogInstallState(item, [
      { name: 'fs', transport: 'stdio', catalog: { catalog_id: 'fs', revision: 3 } },
    ]).state,
    'installed',
  );
  const st = catalogInstallState(item, [
    { name: 'fs', transport: 'stdio', catalog: { catalog_id: 'fs', revision: 3 } },
    { name: 'fs-2', transport: 'stdio', catalog: { catalog_id: 'fs', revision: 1 } },
  ]);
  assert.equal(st.state, 'update');
  assert.equal(st.outdated?.name, 'fs-2');
});

test('런타임 배지', () => {
  assert.equal(runtimeBadge(mk('a').spec), 'Node 24+');
  assert.equal(runtimeBadge({ ...mk('a').spec, runtime: { kind: 'uv' } }), 'uv (Python)');
  assert.equal(
    runtimeBadge({ ...mk('a').spec, runtime: { kind: 'python', min_version: '3.10.0' } }),
    'Python 3.10+',
  );
  assert.equal(
    runtimeBadge({ ...mk('a').spec, transport: 'http', runtime: { kind: 'none' } }),
    '원격 연결',
  );
});

test('폼 초기값: 기본값 · 저장된 값 · 불리언, 비밀은 늘 비운다', () => {
  const spec = {
    ...mk('a').spec,
    variables: [
      { name: 'TZ', type: 'string' as const, default: 'Asia/Seoul' },
      { name: 'ROOT', type: 'path' as const },
      { name: 'TOKEN', type: 'secret' as const },
      { name: 'DEBUG', type: 'boolean' as const, default: true },
      { name: 'EMPTY', type: 'string' as const, default: '' },
    ],
  };
  assert.deepEqual(initialCatalogValues(spec), {
    TZ: 'Asia/Seoul',
    ROOT: '',
    TOKEN: '',
    DEBUG: true,
    EMPTY: '',
  });
  assert.deepEqual(initialCatalogValues(spec, { ROOT: '/a', TOKEN: 'leak', DEBUG: 'false' }), {
    TZ: 'Asia/Seoul',
    ROOT: '/a',
    TOKEN: '',
    DEBUG: false,
    EMPTY: '',
  });
});

test('바이트 · 오류 제목', () => {
  assert.equal(formatBytes(58_330_843), '55.6MB');
  assert.equal(formatBytes(2048), '2KB');
  assert.match(catalogErrorTitle('checksum_mismatch'), /검증/);
  assert.match(catalogErrorTitle('nope'), /설치하지 못했습니다/);
});
