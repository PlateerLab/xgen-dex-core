/**
 * 턴 이벤트 정본 — **서버가 내는 것을 클라이언트가 전부 안다.**
 *
 * 무엇이 있었나 (2026-09-09 실측)
 * ────────────────────────────────
 * 해석기가 **세 벌**이었다. 서버가 내보내는 것은 18종인데:
 *
 *     @dex/protocol      15종   ← canvas_command · llm_* 3종 모름
 *     apps/mobile        16종   ← llm_* 3종 모름
 *     웹 geny-chat-ws    10종
 *
 * 모르는 이벤트는 **조용히 버려졌다.** 오류도 로그도 없다. 그래서 새 이벤트를
 * 만들면 세 곳을 고쳐야 했고, 안 고친 곳은 아무 신호 없이 다르게 동작했다.
 *
 * `canvas_command` 는 에이전트가 자기 그래프를 고쳤다는 신호다 — 앱·CLI·VSCode 가
 * 그것을 버리고 있었으니, 자기진화가 화면에 그려지지 않았다. `llm_*` 셋은 서버의
 * WS 직렬화도 함께 버리고 있어서, 만들어진 뒤 **아무 데도 닿지 못한** 채였다.
 *
 * 여기서 고정하는 것: 정본이 서버의 18종을 빠짐없이 안다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TURN_EVENT_NAMES, TURN_MESSAGE_TYPES, turnEventToChatEvent } from '../src/chat';

/**
 * 서버 `controller/workflow/utils/turn_events.py` 의 TURN_EVENTS 표.
 *
 * 손으로 옮긴 목록이라 서버가 늘리면 여기도 늘려야 한다 — 레포가 달라 자동
 * 대조가 안 된다. 그래서 **서버 쪽 테스트가 자기 표와 코어 방출을 기계적으로
 * 대조**하고(test_turn_events.py), 여기는 그 표를 받아 적는다. 두 검사가 만나는
 * 지점이 이 목록이다.
 */
const SERVER_TURN_EVENTS = TURN_EVENT_NAMES;

/** 기본 채널로 오는 것 — payload 의 `type` 으로 갈린다. */
const MESSAGE_TYPES = TURN_MESSAGE_TYPES;

function payloadFor(name: string): Record<string, unknown> {
  if (name === 'execution_io') return { execution_io_id: 7 };
  if (name === 'node_status') return { node_id: 'n1', status: 'running' };
  if (name === 'tool') return { event_type: 'tool_call', tool_name: 'Bash' };
  return { k: 'v' };
}

test('서버가 내는 이름 이벤트를 하나도 버리지 않는다', () => {
  const dropped: string[] = [];
  for (const name of SERVER_TURN_EVENTS) {
    if (turnEventToChatEvent(name, payloadFor(name)) === null) dropped.push(name);
  }
  assert.deepEqual(dropped, [], `해석기가 조용히 버리는 이벤트: ${dropped.join(', ')}`);
});

test('기본 채널의 네 가지도 전부 해석된다', () => {
  const dropped: string[] = [];
  for (const type of MESSAGE_TYPES) {
    const payload =
      type === 'data' ? { type, content: '안녕' }
      : type === 'summary' ? { type, data: { outputs: ['요약'] } }
      : type === 'error' ? { type, detail: '실패' }
      : { type };
    if (turnEventToChatEvent('message', payload) === null) dropped.push(type);
  }
  assert.deepEqual(dropped, []);
});

test('사고의 주인공 넷이 실제로 해석된다', () => {
  // canvas_command — 앱·CLI·VSCode 가 버리고 있었다(자기진화가 안 그려졌다).
  const canvas = turnEventToChatEvent('canvas_command', { action: 'addNode' });
  assert.equal(canvas?.kind, 'canvas_command');

  // llm_* 셋 — 세 표면 모두, 그리고 서버 WS 까지 버리고 있었다.
  for (const [name, phase] of [
    ['llm_progress', 'progress'],
    ['llm_end', 'end'],
    ['llm_contract_error', 'error'],
  ] as const) {
    const ev = turnEventToChatEvent(name, { verified: true });
    assert.equal(ev?.kind, 'llm_contract', name);
    assert.equal((ev as { phase: string }).phase, phase, name);
  }
});

test('전송로를 모른다 — 같은 이름·payload 면 같은 결과', () => {
  // SSE 는 원문 문자열을, WS 는 파싱된 객체를 준다. 봉투만 다르고 속은 같다.
  const payload = { execution_io_id: 42 };
  const fromWs = turnEventToChatEvent('execution_io', payload);
  const fromSse = turnEventToChatEvent('execution_io', JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(fromWs, fromSse);
  assert.equal((fromWs as { executionIoId: number }).executionIoId, 42);
});

test('모르는 이름은 null — 버리는 것과 모르는 것은 다르다', () => {
  assert.equal(turnEventToChatEvent('made_up_event', { k: 1 }), null);
});

test('payload 가 없으면 터지지 않는다', () => {
  for (const name of SERVER_TURN_EVENTS) {
    // 던지지 않으면 통과 — execution_suspended 처럼 payload 없이도 뜻이 있는 것도 있다.
    turnEventToChatEvent(name, null);
  }
});
