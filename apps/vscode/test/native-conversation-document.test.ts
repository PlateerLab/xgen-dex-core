import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS, NativeConversationDocument, nativeConversationText } from '../src/native-conversation-document';
import type { NativeSessionViewState } from '../src/native-session-controller';

const conversation = { snapshot: { id: '00000000-0000-4000-8000-000000000001', workflow_id: 'flow', title: 'Shared', current_sequence: 2,
  state_version: 2, message_history_complete: false, latest_turn: { id: '00000000-0000-4000-8000-000000000002', status: 'running' as const, accepted_sequence: 2 } },
messages: [
  { turn_id: '00000000-0000-4000-8000-000000000003', sequence: 1, status: 'completed' as const, input_text: 'hello', output_text: 'world', content_complete: true, source: 'user' as const },
  { turn_id: '00000000-0000-4000-8000-000000000004', sequence: 2, status: 'failed' as const, input_text: null, output_text: null, content_complete: false, source: 'unknown' as const, raw_execution: 'private-raw-value' },
], omittedMessages: 3, authScope: 'private-auth-scope', eventCursor: 'private-cursor' };

const connected = { status: 'connected', focus: null, conversation, hasMore: true } as NativeSessionViewState;

test('virtual conversation text shows validated complete messages and bounded-history notes only', () => {
  const text = nativeConversationText(connected);
  for (const expected of ['Shared', '최신 턴: running', 'hello', 'world', '이전 메시지 3개 생략', '본문 미완전 메시지 1개 제외', '추가 내용 확인 중']) assert.ok(text.includes(expected));
  for (const rejected of ['private-raw-value', 'private-auth-scope', 'private-cursor']) assert.equal(text.includes(rejected), false);
});

test('document updates live and clears prior content on reconnect and stop', async () => {
  const fired: unknown[] = []; let disposed = false; let opened = false;
  const uri = { path: '/current-shared-conversation.txt' } as any;
  const changes = { event: (() => ({ dispose() {} })) as any, fire: (value: unknown) => fired.push(value), dispose: () => { disposed = true; } };
  const document = new NativeConversationDocument(uri, changes, async () => { opened = true; });
  document.update(connected); assert.ok(document.provideTextDocumentContent().includes('hello')); assert.deepEqual(fired, [uri]);
  document.update({ status: 'reconnecting', focus: null, conversation: null, hasMore: false });
  assert.equal(document.provideTextDocumentContent().includes('hello'), false); assert.match(document.provideTextDocumentContent(), /복구/);
  document.update({ status: 'stopped', focus: null, conversation: null, hasMore: false });
  assert.equal(document.provideTextDocumentContent().includes('hello'), false); assert.match(document.provideTextDocumentContent(), /중단/);
  await document.show(); assert.equal(opened, true); document.dispose(); assert.equal(disposed, true);
});

test('virtual document has a fixed upper bound', () => {
  const huge = { ...conversation, messages: [{ ...conversation.messages[0], input_text: 'x'.repeat(NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS + 100) }] };
  const text = nativeConversationText({ status: 'connected', focus: null, conversation: huge, hasMore: false } as NativeSessionViewState);
  assert.ok(text.length < NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS + 100); assert.match(text, /표시 한도/);
});
