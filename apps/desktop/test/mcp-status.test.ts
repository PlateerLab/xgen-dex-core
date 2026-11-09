// 채팅창(디버그) "이 PC 연결" 인디케이터의 상태별 문구를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpBridgeStatusLike } from '../src/preload/index';
import { mcpChatStatus, mcpServerMismatchNotice } from '../src/renderer/src/views/mcp-status-model';

const base: McpBridgeStatusLike = {
  enabled: true,
  connected: true,
  catalogSynced: true,
  serverToolCount: 1,
  servers: [],
};

test('브리지가 꺼져 있으면(로그인 전) 연결 안 됨을 표시한다 — 켜라고 안내하지 않는다', () => {
  const status = mcpChatStatus({ ...base, enabled: false, connected: false });
  assert.equal(status.tone, 'off');
  assert.equal(status.label, '이 PC 연결 안 됨');
  assert.doesNotMatch(status.title, /로컬 컨트롤|환경설정/);
});

test('소켓 연결과 카탈로그 ACK 대기를 구분한다', () => {
  assert.equal(mcpChatStatus({ ...base, connected: false }).label, '이 PC 연결 중');
  assert.equal(mcpChatStatus({ ...base, catalogSynced: false }).label, '도구 전달 확인 중');
});

test('workflow가 ACK한 도구 개수를 표시한다', () => {
  const status = mcpChatStatus({ ...base, serverToolCount: 3 });
  assert.equal(status.tone, 'ok');
  assert.equal(status.label, '이 PC 연결됨 · 도구 3개 전달');
});

test('ACK 도구가 0개면 연결 성공과 도구 없음을 함께 알린다', () => {
  const status = mcpChatStatus({ ...base, serverToolCount: 0 });
  assert.equal(status.tone, 'pending');
  assert.equal(status.label, '이 PC 연결됨 · 도구 없음');
});

test('서버가 v2 를 모르면 디버그 단추는 서버 업데이트 필요, 채팅창 안내는 누구에게나 뜬다', () => {
  // 2026-11-06 체험존: 도구 전달 확인 중(디버그만 보임)으로 남아 처음 쓰는 사람은 이유를 몰랐다.
  const mismatch = { ...base, catalogSynced: false, serverToolCount: 0, error: 'unsupported_mcp_protocol' };
  const status = mcpChatStatus(mismatch);
  assert.equal(status.tone, 'off');
  assert.equal(status.label, '서버 업데이트 필요');
  assert.match(mcpServerMismatchNotice(mismatch) ?? '', /XGEN 서버 업데이트/);
  // 다른 상태에서는 안내하지 않는다 — 연결 중·정상·다른 오류.
  assert.equal(mcpServerMismatchNotice(base), null);
  assert.equal(mcpServerMismatchNotice({ ...mismatch, connected: false }), null);
  assert.equal(mcpServerMismatchNotice({ ...base, error: 'handshake HTTP 502' }), null);
  assert.equal(mcpServerMismatchNotice(null), null);
});
