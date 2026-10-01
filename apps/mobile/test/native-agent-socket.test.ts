import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import type { ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { createMobileAgentSocketTransport, MobileSocketBusy, MobileSocketCursorConflict, MobileSocketInvalid, MobileSocketUnavailable,
  type MobileAgentSocketModule, type MobileAgentSocket } from '../src/lib/native-agent-socket';
import { createMobileAgentLiveWatcher } from '../src/lib/native-agent-live-watch';
import { MobileFocusWatchError } from '../src/lib/native-agent-focus-watch';

const origin = 'https://mobile.example.test'; const sid = randomUUID(); const jwt = 'access.jwt.signature'; const proof = 'proof.jwt.signature';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const frame = (after = 0) => ({ type: 'agent_session.events', events: [], next_cursor: after, snapshot_sequence: after, state_version: 1, has_more: false });
function fixture() {
  const calls: unknown[][] = []; const closes: string[] = [];
  const module: MobileAgentSocketModule = { newSocketId: randomUUID, openAgentSocket: async (...args) => { calls.push(args); },
    nextAgentSocket: async () => ({ type: 'events', text: JSON.stringify(frame()) }), closeAgentSocket: async (id) => { closes.push(id); } };
  return { module, calls, closes, transport: createMobileAgentSocketTransport(module, origin) };
}
test('native socket bridge receives only scoped route parameters and credentials, without browser fallback', async () => {
  const f = fixture(); const socket = await f.transport.open(sid, 42, jwt, proof, new AbortController().signal);
  assert.deepEqual(f.calls[0]!.slice(1), [origin, sid, '42', jwt, proof]); assert.deepEqual(await socket.next(), frame());
  await socket.close(); assert.equal(socket.closed, true); f.transport.assertAvailable();
  for (const field of ['newSocketId', 'openAgentSocket', 'nextAgentSocket', 'closeAgentSocket']) {
    assert.throws(() => createMobileAgentSocketTransport({ ...f.module, [field]: undefined } as any, origin), MobileSocketInvalid);
  }
});
test('noncanonical origins/IDs/cursors/credentials are rejected before native wire', async () => {
  const f = fixture();
  for (const bad of ['http://mobile.example.test', `${origin}/`, `${origin}?a=1`, 'https://user:pass@mobile.example.test']) assert.throws(() => createMobileAgentSocketTransport(f.module, bad), MobileSocketInvalid);
  for (const [id, after, token, dpop] of [[`${sid}\n`, 0, jwt, proof], [sid.toUpperCase(), 0, jwt, proof], [sid, -1, jwt, proof],
    [sid, Number.MAX_SAFE_INTEGER + 1, jwt, proof], [sid, 1.5, jwt, proof], [sid, 0, `${jwt}\n`, proof], [sid, 0, jwt, 'Bearer secret']]) {
    await assert.rejects(f.transport.open(String(id), Number(after), String(token), String(dpop), new AbortController().signal), MobileSocketInvalid);
  }
  assert.equal(f.calls.length, 0);
  for (const args of [[null, 0, jwt, proof], [sid, 0, null, proof], [sid, 0, jwt, undefined]]) {
    await assert.rejects(f.transport.open(...args as [string, number, string, string], new AbortController().signal), MobileSocketInvalid);
  }
});
test('native authentication/cursor/busy/invalid/transient errors retain safe classifications', async () => {
  for (const [code, Expected] of [['mobile_socket_authentication', PlatformCredentialUnavailable], ['mobile_socket_cursor_conflict', MobileSocketCursorConflict],
    ['mobile_socket_busy', MobileSocketBusy], ['mobile_socket_invalid', MobileSocketInvalid], ['mobile_socket_unavailable', MobileSocketUnavailable]] as const) {
    const f = fixture(); f.module.openAgentSocket = async () => { throw { code, message: 'private-token' }; };
    await assert.rejects(f.transport.open(sid, 0, jwt, proof, new AbortController().signal), (e: Error) => e instanceof Expected && !e.message.includes('private'));
    await new Promise((r) => setImmediate(r)); f.transport.assertAvailable();
  }
});
test('aborted or closed sockets keep the origin busy across owners until actual native acknowledgement', async () => {
  const f = fixture(); const gate = deferred<void>(); const opened = deferred<void>(); const stop = new AbortController();
  f.module.openAgentSocket = async () => opened.promise; f.module.closeAgentSocket = async () => gate.promise;
  const reading = f.transport.open(sid, 0, jwt, proof, stop.signal); stop.abort(); await assert.rejects(reading);
  const other = createMobileAgentSocketTransport(f.module, origin); assert.throws(other.assertAvailable, MobileSocketBusy);
  await assert.rejects(other.open(sid, 0, jwt, proof, new AbortController().signal), MobileSocketBusy);
  opened.resolve(); assert.throws(other.assertAvailable, MobileSocketBusy); gate.resolve(); await new Promise((r) => setImmediate(r)); other.assertAvailable();
});
test('malformed, extra-field, oversized and invalid JSON frames stop; concurrent next is rejected', async () => {
  for (const raw of [null, { type: 'binary', text: '{}' }, { type: 'events', text: '{}', secret: 'private' }, { type: 'events', text: 'x'.repeat(1048577) }, { type: 'events', text: 'invalid' }]) {
    const f = fixture(); f.module.nextAgentSocket = async () => raw; const socket = await f.transport.open(sid, 0, jwt, proof, new AbortController().signal);
    await assert.rejects(socket.next(), MobileSocketInvalid); await socket.close();
  }
  const f = fixture(); const gate = deferred<unknown>(); f.module.nextAgentSocket = async () => gate.promise;
  const socket = await f.transport.open(sid, 0, jwt, proof, new AbortController().signal); const next = socket.next();
  await assert.rejects(socket.next(), MobileSocketBusy); gate.resolve({ type: 'events', text: JSON.stringify(frame()) }); await next; await socket.close();
});
function state(sequence = 0): ScopedAgentConversation {
  return { authScope: 'verified-account', focus: { active_agent_session_id: sid, version: 1, event_id: sid },
    snapshot: { id: sid, workflow_id: 'wf', title: 'Shared', state_version: 1, current_sequence: sequence, message_history_complete: false },
    eventCursor: { sequence, stateVersion: 1, eventId: null }, messageCursor: 0, messages: [], omittedMessages: 0 };
}
function socketFixture() {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void; let reads = 0; let closed = false;
  const socket: MobileAgentSocket = { get closed() { return closed; }, next: async () => { reads++; return new Promise((r, j) => { resolve = r; reject = j; }); },
    close: async () => { closed = true; reject?.(new MobileSocketUnavailable()); } };
  return { socket, reads: () => reads, frame: (value: unknown) => resolve(value), fail: (value: unknown) => reject(value) };
}
test('socket frames wake HTTP reconciliation, while quiet connections keep periodic checks and only one native read', async () => {
  const f = socketFixture(); const stop = new AbortController(); let calls = 0; let opens = 0; let waits = 0; const updates: any[] = [];
  const watcher = createMobileAgentLiveWatcher({ reconcileConversation: async () => ({ state: state(++calls > 1 ? 1 : 0), source: 'replay', hasMore: false }),
    openConversationSocket: async () => { opens++; return f.socket; } }, { wait: async (_ms, signal) => {
    if (++waits === 1) { f.frame({ ...frame(1), events: [{ event_id: randomUUID(), sequence: 1, event_type: 'turn.accepted', created_at: new Date().toISOString() }] });
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } else if (waits === 3) stop.abort();
  } });
  await watcher.run((u) => updates.push(u), stop.signal); assert.equal(opens, 1); assert.equal(calls, 3); assert.equal(f.reads(), 2); assert.equal(f.socket.closed, true);
  assert.equal(updates.at(-1).reason, 'cancelled'); assert.equal(JSON.stringify(updates).includes('authScope'), false);
});
test('manual reads do not open sockets and permanent/authentication socket failures clear the view once', async () => {
  const source = { reconcileConversation: async () => ({ state: state(), source: 'snapshot' as const, hasMore: false }), openConversationSocket: async () => assert.fail('manual must not open') };
  await createMobileAgentLiveWatcher(source).run(() => undefined, new AbortController().signal, true);
  for (const error of [new PlatformCredentialUnavailable(), new MobileSocketInvalid()]) {
    const f = socketFixture(); const updates: any[] = []; let calls = 0;
    const watcher = createMobileAgentLiveWatcher({ ...source, reconcileConversation: async () => { calls++; return source.reconcileConversation(); },
      openConversationSocket: async () => f.socket }, { wait: async () => { f.fail(error); await new Promise((r) => setImmediate(r)); } });
    await assert.rejects(watcher.run((u) => updates.push(u), new AbortController().signal), MobileFocusWatchError); assert.equal(calls, 1);
    assert.equal(updates.at(-1).reason, error instanceof PlatformCredentialUnavailable ? 'authentication' : 'failed'); assert.equal(f.socket.closed, true);
  }
});
test('cursor conflicts rehydrate once; repeated conflicts without cursor progress stop', async () => {
  const stop = new AbortController(); let opens = 0; const previous: Array<ScopedAgentConversation | null> = []; let current = socketFixture(); const updates: any[] = [];
  const watcher = createMobileAgentLiveWatcher({ reconcileConversation: async (old) => { previous.push(old); return { state: state(), source: 'snapshot', hasMore: false }; },
    openConversationSocket: async () => { opens++; current = socketFixture(); return current.socket; } }, { wait: async () => {
    current.fail(new MobileSocketCursorConflict()); await new Promise((r) => setImmediate(r));
  } });
  await assert.rejects(watcher.run((u) => updates.push(u), stop.signal), MobileFocusWatchError); assert.equal(opens, 2); assert.deepEqual(previous, [null, null]); assert.equal(updates.at(-1).reason, 'failed');
});

test('transient socket failure reconnects from the last HTTP cursor and republishes after clearing', async () => {
  const stop = new AbortController(); const sockets = [socketFixture(), socketFixture()]; const opened: number[] = []; const updates: any[] = []; let waits = 0;
  const watcher = createMobileAgentLiveWatcher({ reconcileConversation: async () => ({ state: state(42), source: 'replay', hasMore: false }),
    openConversationSocket: async (value) => { opened.push(value.eventCursor!.sequence); return sockets[opened.length - 1]!.socket; }
  }, { wait: async () => {
    if (++waits === 1) { sockets[0]!.fail(new MobileSocketUnavailable()); await new Promise((r) => setImmediate(r)); }
    if (waits === 3) stop.abort();
  } });
  await watcher.run((u) => updates.push(u), stop.signal);
  assert.deepEqual(opened, [42, 42]); assert.equal(sockets.every((s) => s.socket.closed), true);
  assert.equal(updates.filter((u) => u.type === 'reconnecting').length, 1);
  assert.equal(updates.filter((u) => u.type === 'value').length, 2);
});

test('focus switches close the old stream and ignore late frames from its owner', async () => {
  const stop = new AbortController(); const oldFrame = deferred<unknown>(); const next = socketFixture(); const otherSid = randomUUID();
  let oldClosed = false; let calls = 0; let waits = 0; const opened: string[] = []; const updates: any[] = [];
  const old: MobileAgentSocket = { get closed() { return oldClosed; }, next: () => oldFrame.promise, close: async () => { oldClosed = true; } };
  const watcher = createMobileAgentLiveWatcher({ reconcileConversation: async () => {
    const value = state(); if (++calls > 1) { value.focus.active_agent_session_id = otherSid; value.snapshot!.id = otherSid; }
    return { state: value, source: 'snapshot', hasMore: false };
  }, openConversationSocket: async (value) => { opened.push(value.snapshot!.id); return opened.length === 1 ? old : next.socket; }
  }, { wait: async () => {
    if (++waits === 2) { oldFrame.resolve({ type: 'invalid', secret: 'old-account-content' }); await new Promise((r) => setImmediate(r)); }
    if (waits === 3) stop.abort();
  } });
  await watcher.run((u) => updates.push(u), stop.signal);
  assert.deepEqual(opened, [sid, otherSid]); assert.equal(oldClosed, true); assert.equal(next.socket.closed, true);
  assert.equal(updates.some((u) => u.reason === 'failed'), false); assert.equal(JSON.stringify(updates).includes('old-account-content'), false);
});

test('a timed-out native handshake cannot overlap another socket; persistent closing stops bounded retries', async () => {
  const f = fixture(); const opened = deferred<void>(); const closed = deferred<void>(); let attempts = 0;
  f.module.openAgentSocket = async () => { attempts++; return opened.promise; }; f.module.closeAgentSocket = async () => closed.promise;
  const updates: any[] = []; const stop = new AbortController();
  const watcher = createMobileAgentLiveWatcher({ reconcileConversation: async () => ({ state: state(), source: 'snapshot', hasMore: false }),
    openConversationSocket: (value, signal) => f.transport.open(value.snapshot!.id, value.eventCursor!.sequence, jwt, proof, signal)
  }, { requestTimeoutMs: 100, wait: async () => undefined });
  await assert.rejects(watcher.run((u) => updates.push(u), stop.signal), MobileFocusWatchError);
  assert.equal(attempts, 1); assert.equal(updates.at(-1).reason, 'failed'); assert.throws(f.transport.assertAvailable, MobileSocketBusy);
  closed.resolve(); opened.resolve(); await new Promise((r) => setImmediate(r)); f.transport.assertAvailable();
});
