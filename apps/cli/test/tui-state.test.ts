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
