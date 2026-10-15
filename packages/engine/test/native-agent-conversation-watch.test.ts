import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionHttpError, AgentSessionProtocolError, type AgentSessionMessage } from '@dex/protocol/agent-session';
import { parseAgentConversationView,
  type AgentConversationRecoveryResult, type ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { NativeAgentConversationWatcher } from '../src/native-agent-conversation-watch';
import { NativeDeviceOperationBusy } from '../src/native-device-key-store';
import { DexError } from '../src/errors';

const SID = '018f1240-0000-7000-8000-000000000011';
const FLOW = '018f1240-0000-7000-8000-000000000012';
const EVENT = '018f1240-0000-7000-8000-000000000013';
const TURN = '018f1240-0000-7000-8000-000000000014';
const message: AgentSessionMessage = { turn_id: TURN, sequence: 2, status: 'completed', input_text: 'question',
  output_text: 'answer', content_complete: true, source: 'user' };

function result(scope = 'verified-a', title = 'Conversation', source: AgentConversationRecoveryResult['source'] = 'replay',
  hasMore = false): AgentConversationRecoveryResult {
  return { state: { authScope: scope, focus: { active_agent_session_id: SID, version: 1, event_id: EVENT },
    snapshot: { id: SID, workflow_id: FLOW, title, current_sequence: 2, state_version: 1,
      message_history_complete: false, latest_turn: { id: TURN, status: 'completed', accepted_sequence: 1 } },
    eventCursor: { sequence: 2, eventId: EVENT, stateVersion: 1 }, messageCursor: 2,
    messages: [{ ...message }], omittedMessages: 0 }, source, hasMore };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('account selection aborts the old request and ignores an abort-ignoring late conversation', async () => {
  const started = deferred<AbortSignal>(); const late = deferred<AgentConversationRecoveryResult>();
  const stop = new AbortController(); const updates: any[] = [];
  const a = { reconcileConversation: async (_id: string, _old: ScopedAgentConversation | null, signal?: AbortSignal) => {
    started.resolve(signal!); return late.promise;
  } };
  const b = { reconcileConversation: async (id: string, previous: ScopedAgentConversation | null) => {
    assert.equal(id, '8'); assert.equal(previous, null); return result('verified-b', 'Other account', 'snapshot');
  } };
  const watcher = new NativeAgentConversationWatcher(a, '7');
  const running = watcher.run((update) => {
    updates.push(update); if (update.type === 'conversation' && update.user_id === '8') stop.abort();
  }, stop.signal);
  const signal = await started.promise; watcher.select(b, '8'); assert.equal(signal.aborted, true);
  late.resolve(result('verified-a', 'Stale'));
  await running;
  assert.deepEqual(updates.map(({ type, user_id }) => [type, user_id]), [
    ['reset', '7'], ['reset', '8'], ['conversation', '8'], ['stopped', '8'],
  ]);
  assert.equal(updates.some((update) => update.conversation?.snapshot?.title === 'Stale'), false);
});

test('whole-step deadline reconnects a hanging source and persistent keychain contention stops after three retries', async () => {
  const stop = new AbortController(); const updates: any[] = []; let calls = 0;
  const watcher = new NativeAgentConversationWatcher({
    reconcileConversation: async (_id: string, previous: ScopedAgentConversation | null, signal?: AbortSignal) => {
      calls++; assert.equal(previous, null);
      return calls === 1 ? untilAborted(signal!) : result('verified-a', 'Ready', 'snapshot');
    },
  }, '7', { requestTimeoutMs: 100, wait: async (ms: number, signal: AbortSignal) => {
    assert.equal(ms, 1000); assert.equal(signal.aborted, false);
  } });
  await watcher.run((update) => { updates.push(update); if (update.type === 'conversation') stop.abort(); }, stop.signal);
  assert.equal(calls, 2);
  assert.deepEqual(updates[1], { type: 'reconnecting', user_id: '7', retry_in_ms: 1000, reason: 'timeout' });

  calls = 0; const pauses: number[] = [];
  const stuck = new NativeAgentConversationWatcher({
    reconcileConversation: async () => { calls++; throw new NativeDeviceOperationBusy(); },
  }, '7', { wait: async (ms: number) => { pauses.push(ms); } });
  await assert.rejects(stuck.run(() => {}), (error: unknown) => error instanceof NativeDeviceOperationBusy);
  assert.equal(calls, 4); assert.deepEqual(pauses, [1000, 2000, 4000]);
});

test('watch publications expose isolated views and include backlog, scope and body-only metadata changes', async () => {
  const stop = new AbortController(); const updates: any[] = []; const pauses: number[] = [];
  let calls = 0;
  const source = { reconcileConversation: async (_id: string, previous: ScopedAgentConversation | null) => {
    calls++;
    if (calls > 1) {
      assert.equal(previous?.snapshot?.title, calls === 4 ? 'Renamed' : 'Conversation');
      assert.equal(previous?.messages[0]?.input_text, 'question');
    }
    if (calls <= 2) return result('credential-must-stay-private', 'Conversation', calls === 1 ? 'snapshot' : 'replay');
    if (calls === 3) return result('credential-must-stay-private', 'Renamed', 'replay', true);
    return result('rotated-scope-must-stay-private', 'Renamed', 'snapshot');
  } };
  const watcher = new NativeAgentConversationWatcher(source, '7', { wait: async (ms: number) => {
    pauses.push(ms); if (calls === 4) stop.abort();
  } });
  await watcher.run((update) => {
    updates.push(update);
    if (update.type === 'conversation' && updates.filter(({ type }) => type === 'conversation').length === 1) {
      update.conversation.snapshot!.title = 'callback mutation';
      update.conversation.messages[0]!.input_text = 'callback mutation';
    }
  }, stop.signal);
  assert.deepEqual(pauses, [2000, 2000, 0, 2000]);
  const publications = updates.filter(({ type }) => type === 'conversation');
  assert.equal(publications.length, 3);
  assert.deepEqual(publications.map(({ source, has_more }) => [source, has_more]), [
    ['snapshot', false], ['replay', true], ['snapshot', false],
  ]);
  assert.equal(publications[1].conversation.snapshot.title, 'Renamed');
  assert.equal(publications[1].conversation.messages[0].input_text, 'question');
  for (const update of publications) {
    assert.deepEqual(Object.keys(update.conversation).sort(), ['messages', 'omittedMessages', 'snapshot']);
    const encoded = JSON.stringify(update);
    for (const secret of ['credential-must-stay-private', 'rotated-scope-must-stay-private', 'authScope', 'eventCursor', 'messageCursor']) {
      assert.equal(encoded.includes(secret), false);
    }
  }
});

test('watch publishes when only backlog completeness changes and applies the matching delay', async () => {
  const stop = new AbortController(); const updates: any[] = []; const pauses: number[] = []; let calls = 0;
  const watcher = new NativeAgentConversationWatcher({ reconcileConversation: async () => {
    calls++; return result('same-scope', 'Same state', calls === 1 ? 'snapshot' : 'replay', calls === 2);
  } }, '7', { wait: async (ms: number) => {
    pauses.push(ms); if (calls === 3) stop.abort();
  } });
  await watcher.run((update) => updates.push(update), stop.signal);
  const conversations = updates.filter(({ type }) => type === 'conversation');
  assert.deepEqual(conversations.map(({ has_more }) => has_more), [false, true, false]);
  assert.deepEqual(conversations.map(({ conversation }) => conversation.snapshot.title), ['Same state', 'Same state', 'Same state']);
  assert.deepEqual(pauses, [2000, 0, 2000]);
});

test('authentication and permanent protocol failures stop once while retryable HTTP failures reconnect', async () => {
  for (const error of [new AgentSessionHttpError(401), new AgentSessionHttpError(403),
    new DexError('protocol_mismatch', 'private-server-body')]) {
    let calls = 0; const updates: any[] = [];
    const watcher = new NativeAgentConversationWatcher({ reconcileConversation: async () => { calls++; throw error; } }, '7', {
      wait: async () => assert.fail('permanent failure must not wait'),
    });
    await assert.rejects(watcher.run((update) => updates.push(update)),
      (failure: unknown) => failure instanceof DexError && failure.code === (error instanceof DexError ? error.code : 'auth_required'));
    assert.equal(calls, 1); assert.deepEqual(updates.map(({ type }) => type), ['reset', 'stopped']);
    assert.equal(JSON.stringify(updates).includes('private-server-body'), false);
  }
  for (const status of [408, 429, 500]) {
    const stop = new AbortController(); const updates: any[] = []; let calls = 0;
    const watcher = new NativeAgentConversationWatcher({ reconcileConversation: async () => {
      if (++calls === 1) throw new AgentSessionHttpError(status); return result('scope', 'recovered', 'snapshot');
    } }, '7', { wait: async () => {} });
    await watcher.run((update) => { updates.push(update); if (update.type === 'conversation') stop.abort(); }, stop.signal);
    assert.equal(updates.some((update) => update.type === 'reconnecting' && update.reason === 'server'), true);
  }
  const stop = new AbortController(); let calls = 0;
  const network = new NativeAgentConversationWatcher({ reconcileConversation: async () => {
    if (++calls === 1) throw new NativePlatformTransportError(); return result('scope', 'recovered', 'snapshot');
  } }, '7', { wait: async () => {} });
  await network.run((update) => { if (update.type === 'conversation') stop.abort(); }, stop.signal);
  assert.equal(calls, 2);
});

test('display projection validates cross-batch identity, null snapshots and retention limits while stripping internal state', () => {
  const state = result('credential-private', 'Projected').state;
  const view = parseAgentConversationView({ ...state, credential: 'private', events: [{ private: true }] });
  assert.deepEqual(Object.keys(view).sort(), ['messages', 'omittedMessages', 'snapshot']);
  assert.notEqual(view.snapshot, state.snapshot); assert.notEqual(view.messages, state.messages); assert.notEqual(view.messages[0], state.messages[0]);
  assert.equal(JSON.stringify(view).includes('credential-private'), false);
  assert.equal(JSON.stringify(view).includes('credential'), false);
  assert.equal(JSON.stringify(view).includes('events'), false);

  assert.throws(() => parseAgentConversationView({ snapshot: null, messages: [message], omittedMessages: 0 }), AgentSessionProtocolError);
  assert.throws(() => parseAgentConversationView({ snapshot: null, messages: [], omittedMessages: 1 }), AgentSessionProtocolError);
  assert.throws(() => parseAgentConversationView({ snapshot: state.snapshot, messages: [{ ...message, status: 'running' }], omittedMessages: 0 }),
    AgentSessionProtocolError);

  const many = Array.from({ length: 101 }, (_, index): AgentSessionMessage => ({ ...message,
    turn_id: `018f1240-0000-7000-8000-${String(index + 100).padStart(12, '0')}`, sequence: index + 1 }));
  const snapshot = { ...state.snapshot!, current_sequence: 200 };
  assert.throws(() => parseAgentConversationView({ snapshot, messages: many, omittedMessages: 0 }), AgentSessionProtocolError);

  const duplicateAcrossBatches = many.slice(0, 21); duplicateAcrossBatches[20] = { ...duplicateAcrossBatches[20]!, turn_id: duplicateAcrossBatches[0]!.turn_id };
  assert.throws(() => parseAgentConversationView({ snapshot, messages: duplicateAcrossBatches, omittedMessages: 0 }), AgentSessionProtocolError);

  const tooManyBytes = many.slice(0, 17).map((value) => ({ ...value, output_text: 'x'.repeat(262144) }));
  assert.throws(() => parseAgentConversationView({ snapshot, messages: tooManyBytes, omittedMessages: 0 }), AgentSessionProtocolError);
});
