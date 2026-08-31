// 채팅창 로컬 MCP 인디케이터의 상태별 문구를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpBridgeStatusLike } from '../src/preload/index';
import { mcpChatStatus } from '../src/renderer/src/views/mcp-status-model';

const base: McpBridgeStatusLike = {
  enabled: true,
  connected: true,
  catalogSynced: true,
  serverToolCount: 1,
  servers: [],
};

test('전역 MCP가 꺼지면 비활성 상태를 표시한다', () => {
  const status = mcpChatStatus({ ...base, enabled: false, connected: false });
  assert.equal(status.tone, 'off');
  assert.equal(status.label, '로컬 MCP 꺼짐');
});

test('소켓 연결과 카탈로그 ACK 대기를 구분한다', () => {
  assert.equal(mcpChatStatus({ ...base, connected: false }).label, '로컬 MCP 연결 중');
  assert.equal(mcpChatStatus({ ...base, catalogSynced: false }).label, '도구 전달 확인 중');
});

test('workflow가 ACK한 도구 개수를 표시한다', () => {
  const status = mcpChatStatus({ ...base, serverToolCount: 3 });
  assert.equal(status.tone, 'ok');
  assert.equal(status.label, '로컬 MCP · 도구 3개 전달');
});

test('ACK 도구가 0개면 연결 성공과 도구 없음을 함께 알린다', () => {
  const status = mcpChatStatus({ ...base, serverToolCount: 0 });
  assert.equal(status.tone, 'pending');
  assert.equal(status.label, '로컬 MCP · 도구 없음');
});
