/**
 * 카탈로그 설치를 실제 MCP 매니저로 끝까지 — 실행 파일 확정 · 실제 stdio 기동 · 도구 목록.
 * 런타임 설치 · 확인 창 · 저장만 가짜다. 비밀 변수(env)가 서버까지 가고 이벤트에는 없는지 본다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogEventIn, CatalogItem } from '@dex/protocol/mcp-catalog';
import { canonicalizeMcpServerConfig, getMcpManager } from '../src/mcp-manager';
import { runCatalogInstall } from '../src/mcp-catalog-install';
import { bindTestHost } from './_host';

bindTestHost();
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');

test('실제 기동: 변수 치환된 argv 와 비밀 env 가 서버에 닿고, 도구 수가 기록된다', async () => {
  const item: CatalogItem = {
    catalog_id: 'fake',
    name: '시험 서버',
    revision: 1,
    spec: {
      spec_version: 1,
      transport: 'stdio',
      runtime: { kind: 'binary' },
      launch: { command: process.execPath, args: [FIXTURE, '--root', '{{ROOT}}'] },
      variables: [
        { name: 'ROOT', type: 'path', target: 'arg' },
        { name: 'FAKE_TOKEN', type: 'secret', secret: true },
      ],
    },
  };
  const events: CatalogEventIn[] = [];
  let savedTools = -1;
  const res = await runCatalogInstall(
    {
      item,
      values: { ROOT: '/Users/me/My Docs', FAKE_TOKEN: 'tok-e2e-123' },
      serverName: 'fake',
      mode: 'install',
      platform: process.platform,
      dexonVersion: '1.110.0',
    },
    {
      planRuntime: async () => ({
        kind: 'binary',
        ready: true,
        found: [],
        downloads: [],
        summary: '추가 런타임 없음',
      }),
      confirmRuntime: async () => true,
      ensureRuntime: async () => ({ installed: [] }),
      canonicalize: canonicalizeMcpServerConfig,
      confirmInstall: async ({ config }) => config.command === process.execPath,
      runSetup: async () => ({
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
      }),
      test: async (config, onLines) => {
        const r = await getMcpManager().test(config, onLines);
        const desc = (r.tools ?? []).find((t) => t.name === 'echo_argv') as
          { description?: string } | undefined;
        assert.ok(desc?.description?.includes('"/Users/me/My Docs"'), desc?.description);
        assert.ok(desc?.description?.includes('tok-e2e-123'));
        return r;
      },
      save: async () => {
        savedTools = 1;
      },
      emit: (e) => events.push(e),
      progress: () => {},
    },
    new AbortController().signal,
  );
  await getMcpManager().closeAll();
  assert.equal(res.ok, true, `${res.code}: ${res.message}`);
  assert.equal(savedTools, 1);
  assert.ok((res.toolCount ?? 0) >= 1);
  assert.equal(events.at(-1)?.event, 'install_completed');
  assert.ok(!JSON.stringify(events).includes('tok-e2e-123'));
  assert.ok(!JSON.stringify(events).includes('My Docs'));
});
