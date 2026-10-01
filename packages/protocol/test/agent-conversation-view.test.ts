import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseAgentConversationView } from '../src/agent-session-conversation-recovery';
import { AgentSessionProtocolError } from '../src/agent-session';

const snapshot = { id: randomUUID(), workflow_id: 'wf', title: 'Shared', state_version: 1, current_sequence: 200, message_history_complete: false };
const message = (sequence: number) => ({ turn_id: randomUUID(), sequence, status: 'completed', source: 'user', input_text: 'Question', output_text: 'Answer', content_complete: true });
test('conversation display strips credentials/cursors/tool envelopes and copies nested data', () => {
  const input = { snapshot: { ...snapshot, private: 'secret' }, messages: [{ ...message(2), tool_result: 'secret' }], omittedMessages: 3,
    authScope: 'secret', eventCursor: { sequence: 200 } };
  const view = parseAgentConversationView(input); assert.deepEqual(Object.keys(view).sort(), ['messages', 'omittedMessages', 'snapshot']);
  assert.equal(JSON.stringify(view).includes('secret'), false); view.messages[0]!.input_text = 'mutated'; view.snapshot!.title = 'mutated';
  assert.equal(input.messages[0]!.input_text, 'Question'); assert.equal(input.snapshot.title, 'Shared');
});
test('message batches enforce global turn uniqueness, sorted sparse sequences, snapshot and retention bounds', () => {
  const messages = Array.from({ length: 21 }, (_, i) => message(i * 2 + 1)); const input = { snapshot, messages, omittedMessages: 0 };
  assert.equal(parseAgentConversationView(input).messages.length, 21);
  for (const invalid of [{ ...input, messages: [...messages.slice(0, 20), { ...messages[20], turn_id: messages[0]!.turn_id }] },
    { ...input, messages: [message(9), message(8)] }, { ...input, messages: [message(201)] },
    { ...input, messages: Array.from({ length: 101 }, (_, i) => message(i + 1)) },
    { ...input, omittedMessages: -1 }, { ...input, omittedMessages: 1.5 }, { snapshot: null, messages: [message(1)], omittedMessages: 0 },
    { snapshot: null, messages: [], omittedMessages: 1 }, { ...input, messages: [{ ...message(1), status: 'running' }] }]) {
    assert.throws(() => parseAgentConversationView(invalid), AgentSessionProtocolError);
  }
  const huge = Array.from({ length: 17 }, (_, i) => ({ ...message(i + 1), input_text: 'x'.repeat(262144), output_text: '' }));
  assert.throws(() => parseAgentConversationView({ snapshot, messages: huge, omittedMessages: 0 }), AgentSessionProtocolError);
  assert.deepEqual(parseAgentConversationView({ snapshot: null, messages: [], omittedMessages: 0 }), { snapshot: null, messages: [], omittedMessages: 0 });
});
