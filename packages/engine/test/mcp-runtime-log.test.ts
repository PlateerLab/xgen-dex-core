// 로컬 MCP 실행 로그가 디스크 없이 제한된 메모리에만 유지되는지 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMcpRuntimeLog,
  clearMcpRuntimeLogs,
  mcpRuntimeLogs,
  onMcpRuntimeLog,
  setMcpRuntimeLogEnabled,
} from '@dex/engine/mcp-runtime-log';
import { bindTestHost, recordingInteraction } from './_host';

// 엔진은 호스트가 붙어야 돈다 — 안 붙이면 명확히 던진다(조용한 폴백 없음).
bindTestHost({ interaction: recordingInteraction('session').port });

test.beforeEach(() => {
  setMcpRuntimeLogEnabled(true);
  clearMcpRuntimeLogs();
});

test.afterEach(() => setMcpRuntimeLogEnabled(false));

test('로컬 도구 실행은 디버그 토글과 무관하게 항상 기록한다 (감사)', () => {
  const received: number[] = [];
  const off = onMcpRuntimeLog((entry) => received.push(entry.id));
  setMcpRuntimeLogEnabled(false); // 하위호환 no-op — 더 이상 기록을 막지 않는다
  const entry = appendMcpRuntimeLog({ kind: 'call', message: '호출' });
  off();

  assert.notEqual(entry, null);
  assert.deepEqual(received, [entry!.id]);
  assert.equal(mcpRuntimeLogs().length, 1);
});

test('추가된 로그를 구독자와 현재 실행 목록에 전달한다', () => {
  const received: number[] = [];
  const off = onMcpRuntimeLog((entry) => received.push(entry.id));
  const entry = appendMcpRuntimeLog({
    kind: 'call',
    message: '호출',
    server: 'uuid',
    tool: 'random_uuid',
  });
  off();

  assert.ok(entry);
  assert.deepEqual(received, [entry.id]);
  assert.deepEqual(mcpRuntimeLogs(), [entry]);
});

test('최근 200개만 보관하고 초기화한다', () => {
  for (let i = 0; i < 205; i += 1) {
    appendMcpRuntimeLog({ kind: 'catalog', message: `catalog ${i}` });
  }
  const logs = mcpRuntimeLogs();
  assert.equal(logs.length, 200);
  assert.equal(logs[0].message, 'catalog 5');

  clearMcpRuntimeLogs();
  assert.deepEqual(mcpRuntimeLogs(), []);
});
