/**
 * 다른 곳에서 도는 턴의 **진행분** 복귀 — CLI.
 *
 * 서버 실행은 연결이 아니라 대화에 매여 있다. CLI 를 닫아도 턴은 계속 돌고,
 * 다시 켜면 서버가 구독 확립과 하트비트마다 "지금 도는 턴이 있는가" 와 그
 * 턴의 **여기까지**를 함께 준다.
 *
 * 이 테스트가 지키는 것은 두 가지다:
 *   · 진행분이 실제로 화면에 선다 (예전에는 "진행 중" 안내와 빈 자리뿐이었다)
 *   · 스냅샷이 **매번 처음부터** 오므로, 재연결이 잦아도 글이 쌓이지 않는다
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatReducer, initialChatState, type ChatState } from '../src/tui/chat-state';

const CONV = 'conv-1';

function opened(): ChatState {
  return chatReducer(initialChatState, {
    type: 'history_loaded', interactionId: CONV, turns: [], running: false,
  });
}

test('진행분을 받으면 그 글이 화면에 선다', () => {
  const s = chatReducer(opened(), {
    type: 'remote_running', interactionId: CONV, running: true, text: '분석을 시작합니다',
  });
  assert.equal(s.running, true);
  assert.equal(s.remote, true);
  assert.equal(s.messages.at(-1)?.text, '분석을 시작합니다');
});

test('스냅샷이 여러 번 와도 줄이 쌓이지 않고 덮어써진다', () => {
  // 재연결·하트비트마다 처음부터 다시 온다. 이어붙이면 재연결 횟수만큼 쌓인다.
  let s = opened();
  for (const text of ['분', '분석', '분석을 시작합니다', '분석을 시작합니다. 다음은']) {
    s = chatReducer(s, { type: 'remote_running', interactionId: CONV, running: true, text });
  }
  const partials = s.messages.filter((m) => m.role === 'assistant');
  assert.equal(partials.length, 1, `말풍선이 ${partials.length}개로 쌓였다`);
  assert.equal(partials[0].text, '분석을 시작합니다. 다음은');
});

test('돌고 있지만 아직 한 글자도 안 나온 턴은 빈 말풍선을 만들지 않는다', () => {
  const s = chatReducer(opened(), {
    type: 'remote_running', interactionId: CONV, running: true, text: '',
  });
  assert.equal(s.running, true);
  assert.equal(s.messages.length, 0);
});

test('턴이 끝나면 진행분을 놓는다 — 완결 턴이 그 자리를 대신한다', () => {
  let s = chatReducer(opened(), {
    type: 'remote_running', interactionId: CONV, running: true, text: '거의 다 됐습니다',
  });
  assert.equal(s.messages.length, 1);
  s = chatReducer(s, { type: 'remote_running', interactionId: CONV, running: false });
  assert.equal(s.messages.length, 0);
  assert.equal(s.running, false);
  assert.equal(s.remote, false);
});

test('내가 돌리는 턴은 스냅샷으로 덮지 않는다', () => {
  // 내 스트림이 토큰을 그리고 있는데 서버 스냅샷으로 덮으면 글이 되감긴다.
  let s = chatReducer(opened(), { type: 'turn_started', interactionId: CONV, input: '안녕' });
  const before = s.messages.length;
  s = chatReducer(s, {
    type: 'remote_running', interactionId: CONV, running: true, text: '서버가 본 진행분',
  });
  assert.equal(s.messages.length, before);
  assert.ok(!s.messages.some((m) => m.text === '서버가 본 진행분'));
});

test('다른 대화의 진행분은 무시한다', () => {
  const s = chatReducer(opened(), {
    type: 'remote_running', interactionId: 'conv-other', running: true, text: '남의 턴',
  });
  assert.equal(s.messages.length, 0);
  assert.equal(s.running, false);
});
