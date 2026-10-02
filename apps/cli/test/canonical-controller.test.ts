import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DexError, type NativeAgentConversationUpdate } from '@dex/engine';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import { CanonicalTuiController } from '../src/tui/canonical-controller';
import type { CanonicalTuiSource } from '../src/tui/canonical-types';

const USER = '7';
const SNAPSHOT = {
  id: randomUUID(), workflow_id: 'workflow', title: 'Shared',
  current_sequence: 4, state_version: 2, message_history_complete: false,
};

function conversation(text = 'answer'): AgentConversationView {
  return {
    snapshot: { ...SNAPSHOT },
    messages: [{
      turn_id: randomUUID(), sequence: 2, status: 'completed', source: 'user',
      input_text: 'question', output_text: text, content_complete: true,
    }],
    omittedMessages: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('condition did not become true');
}

function source(overrides: Partial<CanonicalTuiSource> = {}): CanonicalTuiSource {
  return {
    read: async () => ({ conversation: conversation(), has_more: false }),
    watch: async (_update, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
    },
    settle: async () => {},
    ...overrides,
  };
}

test('read publishes only parsed display data and subscribers cannot mutate controller state', async () => {
  const raw = {
    ...conversation(),
    private_token: 'read-secret',
    snapshot: { ...SNAPSHOT, credential: 'snapshot-secret' },
    messages: [{ ...conversation().messages[0]!, tool_result: 'message-secret' }],
  };
  let readCalls = 0; let settleCalls = 0;
  const controller = new CanonicalTuiController(source({
    read: async () => {
      readCalls++;
      return { conversation: raw as AgentConversationView, has_more: true };
    },
    settle: async () => { settleCalls++; },
  }), USER);
  const snapshots: string[] = [];
  const unsubscribe = controller.subscribe((view) => { snapshots.push(view.status); });

  assert.deepEqual(snapshots, ['idle']);
  assert.equal(await controller.read(), true);
  assert.deepEqual([readCalls, settleCalls], [1, 1]);
  assert.deepEqual(snapshots, ['idle', 'reading', 'connected']);
  assert.equal(controller.state.hasMore, true);
  assert.equal(JSON.stringify(controller.state).includes('secret'), false);

  const exposed = controller.state;
  exposed.conversation!.snapshot!.title = 'mutated';
  exposed.conversation!.messages[0]!.output_text = 'mutated';
  assert.equal(controller.state.conversation!.snapshot!.title, 'Shared');
  assert.equal(controller.state.conversation!.messages[0]!.output_text, 'answer');
  unsubscribe();
  await controller.dispose();
});

test('authentication denial is fixed copy and never exposes thrown details', async () => {
  const controller = new CanonicalTuiController(source({
    read: async () => {
      throw new DexError('auth_required', 'access.jwt.private', { refresh_token: 'refresh.private' });
    },
    settle: async () => { throw new Error('vault.private'); },
  }), USER);

  assert.equal(await controller.read(), false);
  assert.equal(controller.state.status, 'stopped');
  assert.equal(controller.state.conversation, null);
  assert.match(controller.state.error, /인증/);
  assert.equal(JSON.stringify(controller.state).includes('private'), false);
  await controller.stop();
  await controller.dispose();
});

test('duplicate reads are coalesced and a read-to-watch switch waits for task and vault drain', async () => {
  const readResult = deferred<{ conversation: AgentConversationView; has_more: boolean }>();
  const firstSettle = deferred<void>();
  const watchEnd = deferred<void>();
  let readCalls = 0; let watchCalls = 0; let settleCalls = 0; let readAborted = false;
  const controller = new CanonicalTuiController(source({
    read: async (signal) => {
      readCalls++;
      signal.addEventListener('abort', () => { readAborted = true; }, { once: true });
      return readResult.promise;
    },
    watch: async (_update, signal) => {
      watchCalls++;
      signal.addEventListener('abort', () => { watchEnd.resolve(); }, { once: true });
      return watchEnd.promise;
    },
    settle: async () => {
      settleCalls++;
      if (settleCalls === 1) await firstSettle.promise;
    },
  }), USER);

  const reading = controller.read();
  assert.equal(await controller.read(), false);
  await until(() => readCalls === 1);
  const watching = controller.watch();
  assert.equal(readAborted, true);
  assert.equal(controller.state.conversation, null);
  readResult.resolve({ conversation: conversation('late-private-result'), has_more: false });
  await until(() => settleCalls === 1);
  assert.equal(watchCalls, 0);
  assert.equal(controller.state.conversation, null);

  firstSettle.resolve();
  assert.equal(await reading, false);
  assert.equal(await watching, true);
  assert.equal(watchCalls, 1);
  assert.equal(await controller.watch(), false);
  await controller.dispose();
  assert.equal(settleCalls, 2);
  assert.equal(controller.state.conversation, null);
});

test('watch resolves after starting, sanitizes updates, and clears stale data on reconnect and malformed type', async () => {
  const end = deferred<void>();
  let emit!: (update: NativeAgentConversationUpdate) => void;
  let watchCalls = 0; let settleCalls = 0;
  const controller = new CanonicalTuiController(source({
    watch: (update) => {
      watchCalls++;
      emit = update;
      return end.promise;
    },
    settle: async () => { settleCalls++; },
  }), USER);

  assert.equal(await controller.watch(), true);
  assert.equal(watchCalls, 1);
  assert.equal(await controller.watch(), false);
  emit({
    type: 'conversation', user_id: USER, source: 'snapshot', has_more: true,
    conversation: {
      ...conversation(), private_token: 'watch-secret',
      messages: [{ ...conversation().messages[0]!, execution_io: 'private' }],
    } as unknown as AgentConversationView,
  });
  assert.equal(controller.state.status, 'connected');
  assert.equal(controller.state.watching, true);
  assert.equal(controller.state.hasMore, true);
  assert.equal(JSON.stringify(controller.state).includes('secret'), false);

  emit({ type: 'reconnecting', user_id: USER, retry_in_ms: 1000, reason: 'transport' });
  assert.equal(controller.state.status, 'reconnecting');
  assert.equal(controller.state.conversation, null);
  emit({ type: 'reset', user_id: USER });
  assert.equal(controller.state.status, 'reading');
  assert.equal(controller.state.conversation, null);
  emit({ type: 'authentication', user_id: USER } as unknown as NativeAgentConversationUpdate);
  assert.equal(controller.state.status, 'stopped');
  assert.equal(controller.state.conversation, null);
  assert.match(controller.state.error, /응답/);

  end.resolve();
  await until(() => settleCalls === 1);
  assert.match(controller.state.error, /응답/);
  await controller.dispose();
});

test('authentication stop clears a rendered transcript without leaking a later rejection', async () => {
  const end = deferred<void>();
  let emit!: (update: NativeAgentConversationUpdate) => void;
  let settleCalls = 0;
  const controller = new CanonicalTuiController(source({
    watch: (update) => { emit = update; return end.promise; },
    settle: async () => { settleCalls++; },
  }), USER);
  assert.equal(await controller.watch(), true);
  emit({ type: 'conversation', user_id: USER, source: 'replay', has_more: false, conversation: conversation() });
  assert.notEqual(controller.state.conversation, null);
  emit({ type: 'stopped', user_id: USER, reason: 'authentication' });
  assert.equal(controller.state.conversation, null);
  assert.match(controller.state.error, /인증/);
  emit({ type: 'conversation', user_id: USER, source: 'snapshot', has_more: false, conversation: conversation('late') });
  assert.equal(controller.state.conversation, null);
  end.reject(new DexError('auth_required', 'access.private'));
  await until(() => settleCalls === 1);
  assert.match(controller.state.error, /인증/);
  assert.equal(JSON.stringify(controller.state).includes('private'), false);
  await controller.dispose();
});

test('malformed, cross-user and invalid conversation updates fail closed and abort the watch', async () => {
  const badUpdates: unknown[] = [
    { type: 'conversation', user_id: '8', source: 'snapshot', has_more: false, conversation: conversation() },
    { type: 'conversation', user_id: USER, source: 'private', has_more: false, conversation: conversation() },
    { type: 'conversation', user_id: USER, source: 'snapshot', has_more: 'false', conversation: conversation() },
    { type: 'unknown', user_id: USER, access_token: 'private' },
    { type: 'conversation', user_id: USER, source: 'snapshot', has_more: false,
      conversation: { snapshot: null, messages: [conversation().messages[0]], omittedMessages: 0 } },
  ];

  for (const bad of badUpdates) {
    let emit!: (update: NativeAgentConversationUpdate) => void;
    let aborted = false; let settleCalls = 0;
    const controller = new CanonicalTuiController(source({
      watch: async (update, signal) => {
        emit = update;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        });
      },
      settle: async () => { settleCalls++; },
    }), USER);
    assert.equal(await controller.watch(), true);
    emit(bad as NativeAgentConversationUpdate);
    await until(() => settleCalls === 1);
    assert.equal(aborted, true);
    assert.equal(controller.state.status, 'stopped');
    assert.equal(controller.state.conversation, null);
    assert.match(controller.state.error, /응답/);
    assert.equal(JSON.stringify(controller.state).includes('private'), false);
    await controller.dispose();
  }
});

test('stop clears synchronously, ignores late callbacks, and waits for task plus settle', async () => {
  const task = deferred<void>(); const drain = deferred<void>();
  let emit!: (update: NativeAgentConversationUpdate) => void;
  let settleCalls = 0; let readCalls = 0;
  const controller = new CanonicalTuiController(source({
    read: async () => { readCalls++; return { conversation: conversation('fresh'), has_more: false }; },
    watch: (update) => { emit = update; return task.promise; },
    settle: async () => {
      settleCalls++;
      if (settleCalls === 1) await drain.promise;
    },
  }), USER);
  assert.equal(await controller.watch(), true);
  emit({ type: 'conversation', user_id: USER, source: 'snapshot', has_more: false, conversation: conversation() });
  assert.notEqual(controller.state.conversation, null);

  let stopped = false;
  const stopping = controller.stop().then(() => { stopped = true; });
  assert.equal(controller.state.status, 'stopped');
  assert.equal(controller.state.conversation, null);
  emit({ type: 'conversation', user_id: USER, source: 'snapshot', has_more: false, conversation: conversation('late') });
  assert.equal(controller.state.conversation, null);
  const queuedRead = controller.read();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(stopped, false);
  assert.equal(settleCalls, 0);
  assert.equal(readCalls, 0);

  task.resolve();
  await until(() => settleCalls === 1);
  assert.equal(stopped, false);
  assert.equal(readCalls, 0);
  drain.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(await queuedRead, true);
  assert.equal(readCalls, 1);
  assert.equal(settleCalls, 2);
  const finalConversation = controller.state.conversation as AgentConversationView | null;
  assert.equal(finalConversation?.messages[0]?.output_text, 'fresh');
  await controller.dispose();
});
