import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentConversationRecoveryResult, ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { NativeAgentLiveWatcher, type NativeAgentLiveSource } from '../src/native-agent-live-watch';
import {
  NativeSocketAuthentication,
  NativeSocketBusy,
  NativeSocketCursorConflict,
  NativeSocketUnavailable,
  type NativeAgentSocket,
} from '../src/native-agent-socket';
import { DexError } from '../src/errors';

const SID = '018f1240-0000-7000-8000-000000000001';
const OTHER_SID = '018f1240-0000-7000-8000-000000000002';
const EVENT1 = '018f1240-0000-7000-8000-000000000003';
const EVENT2 = '018f1240-0000-7000-8000-000000000004';
const CREATED = '2026-01-01T00:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function conversation(
  title = 'Conversation',
  options: { scope?: string; sid?: string | null; sequence?: number; hasMore?: boolean; source?: AgentConversationRecoveryResult['source'] } = {},
): AgentConversationRecoveryResult {
  const scope = options.scope ?? 'credential-must-stay-private';
  const sid = options.sid === undefined ? SID : options.sid;
  const sequence = options.sequence ?? 0;
  const state: ScopedAgentConversation = sid === null
    ? { authScope: scope, focus: { active_agent_session_id: null, version: 2, event_id: EVENT2 },
      snapshot: null, eventCursor: null, messageCursor: 0, messages: [], omittedMessages: 0 }
    : { authScope: scope, focus: { active_agent_session_id: sid, version: 1, event_id: EVENT1 },
      snapshot: { id: sid, workflow_id: 'workflow', title, current_sequence: sequence,
        state_version: 1, message_history_complete: true },
      eventCursor: { sequence, stateVersion: 1, eventId: sequence === 0 ? null : EVENT2 },
      messageCursor: 0, messages: [], omittedMessages: 0 };
  return { state, source: options.source ?? 'snapshot', hasMore: options.hasMore ?? false };
}

function eventFrame(sequence = 1) {
  return { type: 'agent_session.events', events: [{ event_id: sequence === 1 ? EVENT1 : EVENT2,
    sequence, event_type: 'turn.updated', created_at: CREATED }], next_cursor: sequence,
  snapshot_sequence: sequence, state_version: 1, has_more: false };
}

class TestSocket implements NativeAgentSocket {
  closed = false;
  nextCalls = 0;
  closeCalls = 0;
  readonly frame = deferred<unknown>();
  constructor(private readonly closeGate?: ReturnType<typeof deferred<void>>) {}
  next(): Promise<unknown> { this.nextCalls++; return this.frame.promise; }
  async close(): Promise<void> {
    this.closeCalls++;
    if (this.closeGate) await this.closeGate.promise;
    this.closed = true;
  }
}

class FailingSocket implements NativeAgentSocket {
  closed = false;
  closeCalls = 0;
  constructor(private readonly failure: unknown) {}
  next(): Promise<unknown> { return Promise.reject(this.failure); }
  async close(): Promise<void> { this.closeCalls++; this.closed = true; }
}

function forever(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('quiet checks keep one pending receive and a WSS event wakes authoritative HTTP reconciliation', async () => {
  const stop = new AbortController(); const socket = new TestSocket(); const previous: Array<ScopedAgentConversation | null> = [];
  const updates: any[] = []; let calls = 0; let opens = 0;
  const source: NativeAgentLiveSource = {
    reconcileConversation: async (_user, old) => {
      previous.push(old); calls++;
      return conversation(calls === 1 ? 'Before wake' : 'After wake', { source: calls === 1 ? 'snapshot' : 'replay' });
    },
    openConversationSocket: async (_user, state) => {
      opens++; assert.equal(state.snapshot?.id, SID); return socket;
    },
  };
  const watcher = new NativeAgentLiveWatcher(source, '7', { wait: (_ms, signal) => forever(signal) });
  await watcher.run((update) => {
    updates.push(update);
    if (update.type === 'conversation' && update.conversation.snapshot?.title === 'Before wake') {
      assert.deepEqual(Object.keys(update.conversation).sort(), ['messages', 'omittedMessages', 'snapshot']);
      assert.equal(JSON.stringify(update).includes('credential-must-stay-private'), false);
      socket.frame.resolve(eventFrame());
    } else if (update.type === 'conversation') stop.abort();
  }, stop.signal);
  assert.equal(calls, 2); assert.equal(opens, 1); assert.equal(socket.nextCalls, 2);
  assert.equal(previous[0], null); assert.equal(previous[1]?.snapshot?.title, 'Before wake');
  assert.deepEqual(updates.filter(({ type }) => type === 'conversation').map(({ conversation }) => conversation.snapshot.title),
    ['Before wake', 'After wake']);
});

test('quiet HTTP intervals do not stack socket receives and HTTP backlog drains before opening WSS', async () => {
  const stop = new AbortController(); const socket = new TestSocket(); const pauses: number[] = [];
  let calls = 0; let opens = 0;
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => {
      calls++;
      if (calls === 1) return conversation('Backlog', { hasMore: true });
      return conversation('Caught up', { source: 'replay' });
    },
    openConversationSocket: async () => { opens++; assert.equal(calls, 2); return socket; },
  }, '7', { wait: async (ms) => {
    pauses.push(ms);
    if (calls === 4) stop.abort();
  } });
  await watcher.run(() => {}, stop.signal);
  assert.equal(calls, 4); assert.equal(opens, 1); assert.equal(socket.nextCalls, 1);
  assert.deepEqual(pauses, [0, 2000, 2000, 2000]);
});

test('an empty duplicate-cursor frame waits for the remaining quiet timer before polling HTTP', async () => {
  const stop = new AbortController(); const quiet = deferred<void>(); const waiting = deferred<void>();
  let calls = 0; let nextCalls = 0; let waits = 0;
  const socket: NativeAgentSocket = {
    closed: false,
    next: async () => {
      nextCalls++;
      if (nextCalls === 1) return { type: 'agent_session.events', events: [], next_cursor: 0,
        snapshot_sequence: 0, state_version: 1, has_more: false };
      return deferred<unknown>().promise;
    },
    close: async () => {},
  };
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => { calls++; return conversation(); },
    openConversationSocket: async () => socket,
  }, '7', { wait: async () => {
    waits++;
    if (waits === 1) { waiting.resolve(); await quiet.promise; }
    else stop.abort();
  } });
  const running = watcher.run(() => {}, stop.signal);
  await waiting.promise; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(nextCalls, 1);
  quiet.resolve(); await running;
  assert.equal(calls, 2); assert.equal(nextCalls, 2);
});

test('scope or active conversation changes close the old socket before selecting another stream', async () => {
  const stop = new AbortController(); const first = new TestSocket(); const second = new TestSocket(); let calls = 0;
  const opened: string[] = [];
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => {
      calls++;
      if (calls === 1) return conversation('First');
      if (calls === 2) return conversation('', { sid: null, source: 'replay' });
      return conversation('Second', { scope: 'new-account-scope', sid: OTHER_SID });
    },
    openConversationSocket: async (_user, state) => {
      opened.push(state.snapshot!.id);
      return opened.length === 1 ? first : second;
    },
  }, '7', { wait: async () => {
    if (calls === 2) { first.frame.resolve(eventFrame()); await Promise.resolve(); }
    if (calls === 3) stop.abort();
  } });
  await watcher.run(() => {}, stop.signal);
  assert.deepEqual(opened, [SID, OTHER_SID]); assert.equal(first.closeCalls, 1); assert.equal(first.closed, true);
  assert.equal(second.closeCalls, 1);
});

test('HTTP snapshot recovery for the same scope and sid closes and reopens its event stream', async () => {
  const stop = new AbortController(); const first = new TestSocket(); const second = new TestSocket();
  let calls = 0; let opens = 0;
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => conversation('Same sid', { source: ++calls === 1 ? 'snapshot' : 'recovered' }),
    openConversationSocket: async () => ++opens === 1 ? first : second,
  }, '7', { wait: async () => {} });
  await watcher.run((update) => {
    if (update.type === 'conversation' && update.source === 'recovered') stop.abort();
  }, stop.signal);
  assert.equal(calls, 2); assert.equal(opens, 2);
  assert.equal(first.closeCalls, 1); assert.equal(first.closed, true);
  assert.equal(second.closeCalls, 1);
});

test('cancellation closes a socket whose open completes late and never publishes the stale conversation', async () => {
  const stop = new AbortController(); const opening = deferred<NativeAgentSocket>(); const socket = new TestSocket();
  const updates: any[] = []; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => conversation('Must not publish'),
    openConversationSocket: async () => { entered(); return opening.promise; },
  }, '7');
  const running = watcher.run((update) => updates.push(update), stop.signal);
  await started; stop.abort(); await running;
  opening.resolve(socket); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates.map(({ type }) => type), ['reset', 'stopped']);
  assert.equal(socket.closeCalls, 1); assert.equal(socket.closed, true);
});

test('run cancellation does not resolve until the active socket acknowledges close', async () => {
  const stop = new AbortController(); const closeGate = deferred<void>(); const socket = new TestSocket(closeGate);
  const published = deferred<void>();
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => conversation('Open'),
    openConversationSocket: async () => socket,
  }, '7');
  let settled = false;
  const running = watcher.run((update) => {
    if (update.type === 'conversation') { published.resolve(); stop.abort(); }
  }, stop.signal).then(() => { settled = true; });
  await published.promise; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.closeCalls, 1); assert.equal(settled, false);
  closeGate.resolve(); await running;
  assert.equal(socket.closed, true); assert.equal(settled, true); assert.equal(socket.closeCalls, 1);
});

test('one cursor conflict requests a fresh snapshot and preserves that intent while close acknowledgement keeps WSS busy', async () => {
  const stop = new AbortController(); const closeGate = deferred<void>(); const first = new TestSocket(closeGate); const second = new TestSocket();
  first.frame.resolve(eventFrame(2));
  const previous: Array<ScopedAgentConversation | null> = []; const updates: any[] = [];
  let calls = 0; let openCalls = 0;
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async (_user, old) => {
      previous.push(old); calls++;
      return conversation(calls === 1 ? 'Initial' : 'Recovered', { source: calls === 1 ? 'snapshot' : 'recovered' });
    },
    openConversationSocket: async () => {
      openCalls++;
      if (openCalls === 1) return first;
      if (!first.closed) throw new NativeSocketBusy();
      return second;
    },
  }, '7', { wait: async (ms) => {
    if (ms === 1000) closeGate.resolve();
  } });
  await watcher.run((update) => {
    updates.push(update);
    if (update.type === 'conversation' && update.conversation.snapshot?.title === 'Recovered'
      && updates.some(({ type }) => type === 'reconnecting')) stop.abort();
  }, stop.signal);
  assert.equal(openCalls, 3); assert.deepEqual(previous, [null, null, null]);
  assert.equal(updates.some((update) => update.type === 'reconnecting' && update.reason === 'busy'), true);
});

test('authentication is rechecked once without refresh and repeated no-progress failure stops', async () => {
  const sockets = [new TestSocket(), new TestSocket()];
  for (const socket of sockets) socket.frame.reject(new NativeSocketAuthentication());
  const previous: Array<ScopedAgentConversation | null> = []; let calls = 0; let opens = 0;
  const updates: any[] = [];
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async (_user, old) => { previous.push(old); calls++; return conversation('Same'); },
    openConversationSocket: async () => sockets[opens++]!,
  }, '7', { wait: (_ms, signal) => forever(signal) });
  await assert.rejects(watcher.run((update) => updates.push(update)),
    (error: unknown) => error instanceof DexError && error.code === 'auth_required');
  assert.equal(calls, 2); assert.equal(opens, 2); assert.notEqual(previous[1], null);
  assert.deepEqual(updates.map(({ type }) => type), ['reset', 'conversation', 'stopped']);
  assert.equal(updates.at(-1).reason, 'authentication');
});

test('repeated handshake cursor conflicts without progress stop after one snapshot recovery', async () => {
  const previous: Array<ScopedAgentConversation | null> = []; const updates: any[] = [];
  let calls = 0; let opens = 0;
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async (_user, old) => { previous.push(old); calls++; return conversation('Same'); },
    openConversationSocket: async () => { opens++; throw new NativeSocketCursorConflict(); },
  }, '7', { wait: async () => {} });
  await assert.rejects(watcher.run((update) => updates.push(update)),
    (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  assert.equal(calls, 2); assert.equal(opens, 2); assert.deepEqual(previous, [null, null]);
  assert.deepEqual(updates.map(({ type }) => type), ['reset', 'reconnecting', 'reconnecting', 'stopped']);
});

test('transient socket failure uses bounded watcher retry, while malformed frames fail permanently', async () => {
  const stop = new AbortController(); const transient = new TestSocket(); const recovered = new TestSocket();
  transient.frame.reject(new NativeSocketUnavailable()); let calls = 0; let opens = 0; const pauses: number[] = [];
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => conversation(++calls === 1 ? 'Initial' : 'Recovered'),
    openConversationSocket: async () => opens++ === 0 ? transient : recovered,
  }, '7', { wait: async (ms, signal) => { pauses.push(ms); if (ms === 2000) await forever(signal); } });
  await watcher.run((update) => {
    if (update.type === 'conversation' && update.conversation.snapshot?.title === 'Recovered') stop.abort();
  }, stop.signal);
  assert.deepEqual(pauses, [2000, 1000]); assert.equal(calls, 2);

  const malformed = new TestSocket(); malformed.frame.resolve({ type: 'private-malformed-frame' });
  let malformedCalls = 0; const updates: any[] = [];
  const broken = new NativeAgentLiveWatcher({
    reconcileConversation: async () => { malformedCalls++; return conversation('Initial'); },
    openConversationSocket: async () => malformed,
  }, '7', { wait: (_ms, signal) => forever(signal) });
  await assert.rejects(broken.run((update) => updates.push(update)),
    (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  assert.equal(malformedCalls, 1); assert.equal(updates.at(-1).reason, 'failed');
});

test('persistent unavailable sockets stop on the fourth no-progress failure after three retries', async () => {
  const sockets = Array.from({ length: 4 }, () => new FailingSocket(new NativeSocketUnavailable()));
  const retryDelays: number[] = []; const updates: any[] = []; let calls = 0; let opens = 0;
  const watcher = new NativeAgentLiveWatcher({
    reconcileConversation: async () => { calls++; return conversation('No progress'); },
    openConversationSocket: async () => sockets[opens++]!,
  }, '7', { intervalMs: 333, wait: async (ms, signal) => {
    if (ms === 333) await forever(signal); else retryDelays.push(ms);
  } });
  await assert.rejects(watcher.run((update) => updates.push(update)),
    (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  assert.equal(calls, 4); assert.equal(opens, 4); assert.deepEqual(retryDelays, [1000, 1000, 1000]);
  assert.equal(updates.filter(({ type }) => type === 'reconnecting').length, 3);
  assert.equal(updates.at(-1).type, 'stopped'); assert.equal(updates.at(-1).reason, 'failed');
  assert.deepEqual(sockets.map(({ closeCalls }) => closeCalls), [1, 1, 1, 1]);
});
