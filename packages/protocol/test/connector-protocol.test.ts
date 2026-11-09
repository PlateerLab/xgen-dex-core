import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  legacyCallRejection,
  UNSUPPORTED_CONNECTOR_PROTOCOL_ERROR,
  unsupportedConnectorProtocolNotice,
} from '../src/connector-protocol';

test('v1 mcp_call 에만 v1 형식 실패 프레임을 만든다', () => {
  assert.deepEqual(legacyCallRejection({ type: 'mcp_call', request_id: 'r1' }), {
    type: 'mcp_result',
    request_id: 'r1',
    ok: false,
    error: UNSUPPORTED_CONNECTOR_PROTOCOL_ERROR,
  });
  // 다른 버전 번호(미래 서버 포함)도 이 기기가 실행할 수 없는 호출이다.
  assert.equal(legacyCallRejection({ type: 'mcp_call', request_id: 'r3', protocol_version: 3 })?.ok, false);
});

test('v2 프레임·request_id 없는 프레임·다른 종류에는 답하지 않는다', () => {
  assert.equal(legacyCallRejection({ type: 'mcp_call', request_id: 'r2', protocol_version: 2 }), null);
  assert.equal(legacyCallRejection({ type: 'mcp_call' }), null);
  assert.equal(legacyCallRejection({ type: 'mcp_call', request_id: '  ' }), null);
  assert.equal(legacyCallRejection({ type: 'mcp_call', request_id: 42 }), null);
  assert.equal(legacyCallRejection({ type: 'mcp_cancel', request_id: 'r1' }), null);
});

test('안내 문구는 쓸 수 없게 된 도구를 이름으로 말한다', () => {
  assert.match(unsupportedConnectorProtocolNotice(), /이 PC 의 도구\(브라우저·파일·명령\)를 쓸 수 없습니다/);
  assert.match(unsupportedConnectorProtocolNotice('이 휴대폰의 도구'), /이 휴대폰의 도구를 쓸 수 없습니다/);
});
