/**
 * `subscribed` 프레임 해석 — 진행 중인 턴의 복귀.
 *
 * 서버는 도는 턴이 있으면 진행분(`live`)을 함께 준다. 이 테스트가 있기 전까지
 * 세 소비자(엔진·모바일·웹)가 전부 `running` 만 꺼내고 `live` 는 버렸다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSubscribed } from '../src/chat';

test('도는 턴이 없으면 live 는 null 이다', () => {
  const s = parseSubscribed({ cursor: 12, running: false });
  assert.equal(s.running, false);
  assert.equal(s.live, null);
  assert.equal(s.cursor, 12);
});

test('돌고 있으면 진행분을 꺼낸다', () => {
  const s = parseSubscribed({
    cursor: 3, running: true,
    live: { text: '분석을 시작합니다', events: [{ event: 'tool', data: {} }], ts: 1 },
  });
  assert.equal(s.running, true);
  assert.equal(s.live?.text, '분석을 시작합니다');
  assert.equal(s.live?.events.length, 1);
});

test('돌고 있는데 아직 한 글자도 안 나온 턴은 null 이 아니라 빈 진행분이다', () => {
  // 이 구분이 화면을 가른다: null 이면 평소 화면, 빈 진행분이면
  // 빈 말풍선 + 진행 표시. 둘을 섞으면 "진행 중인데 아무것도 없음" 이 사라진다.
  const s = parseSubscribed({ cursor: 0, running: true, live: { text: '', events: [] } });
  assert.notEqual(s.live, null);
  assert.equal(s.live?.text, '');
});

test('live 를 안 보내는 구 서버에서도 예전대로 동작한다', () => {
  const s = parseSubscribed({ cursor: 5, running: true });
  assert.equal(s.running, true);
  assert.equal(s.live, null);
});

test('형태가 어긋난 live 는 버리지 않고 안전한 기본값으로 읽는다', () => {
  const s = parseSubscribed({ running: true, live: { text: 42, events: 'nope' } });
  assert.equal(s.live?.text, '');
  assert.deepEqual(s.live?.events, []);
});

test('data 가 없거나 이상해도 던지지 않는다', () => {
  assert.equal(parseSubscribed(undefined).running, false);
  assert.equal(parseSubscribed(null).live, null);
  assert.equal(parseSubscribed('nonsense').cursor, 0);
});
