import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatReducer, initialChatState } from '../src/tui/chat-state';

test('chat reducer accumulates streamed text and updates tool activity in place', () => {
  let state = chatReducer(initialChatState, {
    type: 'turn_started',
    interactionId: 'interaction-1',
    input: 'hello',
  });
  state = chatReducer(state, { type: 'event_received', event: { kind: 'text', content: '안녕' } });
  state = chatReducer(state, { type: 'event_received', event: { kind: 'text', content: '하세요' } });
  state = chatReducer(state, {
    type: 'event_received',
    event: { kind: 'tool', event: { eventType: 'tool_call', toolName: 'search', runId: 'run-1' } },
  });
  state = chatReducer(state, {
    type: 'event_received',
    event: { kind: 'tool', event: { eventType: 'tool_result', toolName: 'search', runId: 'run-1' } },
  });
  assert.equal(state.messages.find((message) => message.role === 'assistant')?.text, '안녕하세요');
  assert.deepEqual(
    state.messages.filter((message) => message.role === 'activity').map((message) => message.text),
    ['search · 완료'],
  );
});

test('history is converted into reusable chat state', () => {
  const state = chatReducer(initialChatState, {
    type: 'history_loaded',
    interactionId: 'history-1',
    turns: [
      {
        logId: 1,
        ioId: 2,
        interactionId: 'history-1',
        workflowId: 'wf',
        workflowName: 'Agent',
        input: 'question',
        output: 'answer',
        attachments: [],
        updatedAt: '',
      },
    ],
  });
  assert.equal(state.interactionId, 'history-1');
  assert.deepEqual(state.messages.map((message) => message.text), ['question', 'answer']);
});

// 다른 기기(휴대폰·웹)가 도구를 쓰며 돌린 턴이 끝나면 이 화면은 이력으로 다시 그린다. 이력에는 서버가 실행
// 기록에서 되살린 작업 과정(process)이 있다 — 스트림으로 받은 턴과 같은 도구 줄로 그린다(2026-10-01 사용자 보고).
test('다른 곳에서 돈 도구 턴이 끝나면 도구 줄까지 그린다', () => {
  let state = chatReducer(initialChatState, { type: 'history_loaded', interactionId: 'c', turns: [], running: true });
  state = chatReducer(state, {
    type: 'remote_finished',
    interactionId: 'c',
    turns: [
      {
        logId: 1,
        ioId: 9,
        interactionId: 'c',
        workflowId: 'wf',
        workflowName: 'gitlab',
        input: '내 앱 괜찮아?',
        output: '두 앱 모두 정상입니다.',
        attachments: [],
        updatedAt: '',
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'AppList', toolUseId: 'a' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'AppList', toolUseId: 'a' } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_error', toolName: 'AppStatus', toolUseId: 'b', error: '중지됨' } },
          { kind: 'text', at: 4, text: '두 앱 모두 정상입니다.' },
        ],
      },
    ],
  });
  assert.deepEqual(
    state.messages.map((m) => [m.role, m.text]),
    [
      ['user', '내 앱 괜찮아?'],
      ['assistant', '두 앱 모두 정상입니다.'],
      ['activity', 'AppList · 완료'],
      ['activity', 'AppStatus · 실패: 중지됨'],
    ],
  );
});

test('호출 id 가 없는 도구도 호출 하나에 한 줄 — 같은 이름의 두 호출이 합쳐지지 않는다', () => {
  const state = chatReducer(initialChatState, {
    type: 'history_loaded',
    interactionId: 'c',
    turns: [
      {
        logId: 1, ioId: 1, interactionId: 'c', workflowId: 'wf', workflowName: 'gitlab',
        input: 'q', output: 'a', attachments: [], updatedAt: '',
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'Read' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'Read' } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_call', toolName: 'Read' } },
        ],
      },
    ],
  });
  assert.deepEqual(state.messages.filter((m) => m.role === 'activity').map((m) => m.text), ['Read · 완료', 'Read · 실행 중']);
});
