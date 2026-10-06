import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DexError, type NativeAgentConversationUpdate } from '@dex/engine';
import type {
  AgentFocus,
  AgentSessionSnapshot,
  OwnedAgentSession,
} from '@dex/protocol/agent-session';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import type { AgentAttachmentReceipt } from '@dex/protocol/agent-session-attachments';
import { AgentTurnComposeFailure, type AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import type {
  CreateAgentSessionInput,
  CreatedAgentSession,
  SwitchAgentFocusInput,
} from '@dex/protocol/agent-session-lifecycle';
import { CanonicalTuiChatModel } from '../src/tui/canonical-chat-model';
import type {
  CanonicalTuiAttachmentDraft,
  CanonicalTuiAttachmentScope,
  CanonicalTuiChatSource,
} from '../src/tui/canonical-chat-types';

const ACCOUNT = { profile: 'corp', origin: 'https://app.example.test', userId: '7' };
const SESSION1 = '11111111-1111-4111-8111-111111111111';
const SESSION2 = '22222222-2222-4222-8222-222222222222';
const SESSION3 = '33333333-3333-4333-8333-333333333333';
const EVENT1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TURN1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BINDING1 = 'native-binding.private.one';
const BINDING2 = 'native-binding.private.two';
const ATTACHMENT1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATTACHMENT2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function snapshot(id = SESSION1, version = 2): AgentSessionSnapshot {
  return {
    id, workflow_id: 'workflow', title: `Session ${id.slice(0, 1)}`,
    current_sequence: 3, state_version: version, message_history_complete: true,
    latest_turn: null,
  };
}

function conversation(id = SESSION1, version = 2): AgentConversationView {
  return { snapshot: snapshot(id, version), messages: [], omittedMessages: 0 };
}

function focus(id: string | null = SESSION1, version = 1): AgentFocus {
  return {
    active_agent_session_id: id,
    version,
    event_id: version === 0 ? null : version === 1 ? EVENT1 : EVENT2,
  };
}

function item(id: string, status: 'active' | 'archived' = 'active'): OwnedAgentSession {
  return {
    id, workflow_id: 'workflow', title: `Item ${id.slice(0, 1)}`, status,
    current_sequence: 3, state_version: 2,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('condition did not become true');
}

type CatalogResult = Awaited<ReturnType<CanonicalTuiChatSource['catalog']>>;

class ChatSource implements CanonicalTuiChatSource {
  currentBinding: string | null = BINDING1;
  currentConversation: AgentConversationView = conversation();
  currentFocus: AgentFocus = focus();
  currentItems: OwnedAgentSession[] = [item(SESSION1), item(SESSION2)];
  currentCursor: string | null = null;
  readCalls = 0;
  catalogCalls: Array<string | undefined> = [];
  createCalls: Array<{ binding: string; input: CreateAgentSessionInput }> = [];
  selectCalls: Array<{ binding: string; input: SwitchAgentFocusInput }> = [];
  sendCalls: Array<{ binding: string; request: AgentTurnComposeRequest }> = [];
  settleCalls = 0;
  attachmentDrafts: CanonicalTuiAttachmentDraft[] = [];
  attachmentCalls: Array<{ action: string; binding: string; scope: CanonicalTuiAttachmentScope; value?: unknown }> = [];
  readImpl?: (signal: AbortSignal) => Promise<{ conversation: AgentConversationView; has_more: boolean }>;
  catalogImpl?: (signal: AbortSignal, beforeId?: string) => Promise<CatalogResult>;
  createImpl?: (binding: string, input: CreateAgentSessionInput, signal: AbortSignal) => Promise<CreatedAgentSession>;
  selectImpl?: (binding: string, input: SwitchAgentFocusInput, signal: AbortSignal) => Promise<AgentFocus>;
  sendImpl?: (binding: string, request: AgentTurnComposeRequest, signal: AbortSignal) => Promise<unknown>;
  settleImpl?: () => Promise<void>;
  selectAttachmentsImpl?: (binding: string, scope: CanonicalTuiAttachmentScope, paths: readonly string[], signal: AbortSignal) => Promise<readonly CanonicalTuiAttachmentDraft[]>;

  binding(): string | null { return this.currentBinding; }

  async read(signal: AbortSignal) {
    this.readCalls++;
    if (this.readImpl) return this.readImpl(signal);
    return { conversation: this.currentConversation, has_more: false };
  }

  async watch(_update: (value: NativeAgentConversationUpdate) => void, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }

  async settle(): Promise<void> {
    this.settleCalls++;
    await this.settleImpl?.();
  }

  async catalog(signal: AbortSignal, beforeId?: string): Promise<CatalogResult> {
    this.catalogCalls.push(beforeId);
    if (this.catalogImpl) return this.catalogImpl(signal, beforeId);
    return {
      binding: this.currentBinding!, focus: this.currentFocus,
      sessions: { items: this.currentItems, next_cursor: this.currentCursor, has_more: this.currentCursor !== null },
    };
  }

  async create(binding: string, input: CreateAgentSessionInput, signal: AbortSignal): Promise<CreatedAgentSession> {
    this.createCalls.push({ binding, input });
    if (this.createImpl) return this.createImpl(binding, input, signal);
    const nextFocus = focus(SESSION2, input.expected_version + 1);
    return { id: SESSION2, workflow_id: input.workflow_id, focus: nextFocus };
  }

  async select(binding: string, input: SwitchAgentFocusInput, signal: AbortSignal): Promise<AgentFocus> {
    this.selectCalls.push({ binding, input });
    if (this.selectImpl) return this.selectImpl(binding, input, signal);
    return focus(input.active_agent_session_id, input.expected_version + 1);
  }

  async send(binding: string, request: AgentTurnComposeRequest, signal: AbortSignal): Promise<unknown> {
    this.sendCalls.push({ binding, request });
    if (this.sendImpl) return this.sendImpl(binding, request, signal);
    assert.equal(request.operation, 'submit');
    return envelope(request, {
      turn_id: TURN1, status: 'accepted', accepted_sequence: 4,
      state_version: request.input.expected_state_version + 1, replayed: false,
    });
  }

  attachments(binding: string, scope: CanonicalTuiAttachmentScope): readonly CanonicalTuiAttachmentDraft[] {
    this.attachmentCalls.push({ action: 'list', binding, scope });
    return this.attachmentDrafts.map((value) => ({ ...value, ...(value.receipt ? { receipt: { ...value.receipt } } : {}) }));
  }

  async selectAttachments(binding: string, scope: CanonicalTuiAttachmentScope, paths: readonly string[], signal: AbortSignal) {
    this.attachmentCalls.push({ action: 'select', binding, scope, value: [...paths] });
    if (this.selectAttachmentsImpl) return this.selectAttachmentsImpl(binding, scope, paths, signal);
    const start = this.attachmentDrafts.length;
    this.attachmentDrafts.push(...paths.map((path, index) => ({
      handle: `selection-${start + index}`,
      filename: path.split('/').at(-1) || 'file',
      sizeBytes: index + 1,
      mediaType: 'application/octet-stream',
      status: 'selected' as const,
      sha256: `${index + 1}`.repeat(64).slice(0, 64),
    })));
    return this.attachments(binding, scope);
  }

  async uploadAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string) {
    this.attachmentCalls.push({ action: 'upload', binding, scope, value: handle });
    const index = this.attachmentDrafts.findIndex((value) => value.handle === handle);
    const value = this.attachmentDrafts[index]!;
    const attachmentId = index === 0 ? ATTACHMENT1 : ATTACHMENT2;
    const receipt: AgentAttachmentReceipt = {
      origin: ACCOUNT.origin, user_id: ACCOUNT.userId,
      session_id: scope.agentSessionId, workflow_id: scope.workflowId,
      attachment_id: attachmentId, filename: value.filename, size_bytes: value.sizeBytes,
      media_type: value.mediaType, sha256: value.sha256,
    };
    this.attachmentDrafts[index] = { ...value, status: 'ready', receipt };
    return this.attachments(binding, scope);
  }

  async recoverAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string) {
    this.attachmentCalls.push({ action: 'recover', binding, scope, value: handle });
    return this.attachments(binding, scope);
  }

  async cancelAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string) {
    this.attachmentCalls.push({ action: 'cancel', binding, scope, value: handle });
    this.attachmentDrafts = this.attachmentDrafts.filter((value) => value.handle !== handle);
    return this.attachments(binding, scope);
  }

  discardAttachments(binding: string, scope: CanonicalTuiAttachmentScope) {
    this.attachmentCalls.push({ action: 'discard', binding, scope });
    this.attachmentDrafts = [];
    return [];
  }

  attachmentReferences(binding: string, scope: CanonicalTuiAttachmentScope) {
    this.attachmentCalls.push({ action: 'references', binding, scope });
    if (this.attachmentDrafts.some((value) => value.status !== 'ready' || !value.receipt)) throw new TypeError('not ready');
    return this.attachmentDrafts.map((value) => ({
      attachment_id: value.receipt!.attachment_id,
      sha256: value.receipt!.sha256,
    }));
  }

  clearAttachments(): void { this.attachmentDrafts = []; }
}

function envelope(request: AgentTurnComposeRequest, mutation: unknown): unknown {
  return {
    ...request.scope,
    agent_session_id: request.agent_session_id,
    mutation,
  };
}

async function ready(source = new ChatSource()): Promise<{ source: ChatSource; model: CanonicalTuiChatModel }> {
  const model = new CanonicalTuiChatModel(ACCOUNT, source, () => 'stable-request-1');
  assert.equal(await model.read(), true);
  assert.equal(await model.loadCatalog(), true);
  return { source, model };
}

test('immediate snapshots are defensive and catalog paging replaces one bounded page', async () => {
  const source = new ChatSource();
  source.currentCursor = SESSION2;
  source.catalogImpl = async (_signal, beforeId) => beforeId === undefined
    ? {
      binding: BINDING1, focus: { ...focus(), private_token: 'focus-secret' } as AgentFocus,
      sessions: {
        items: [
          { ...item(SESSION1), access_token: 'item-secret' },
          item(SESSION2),
        ],
        next_cursor: SESSION2, has_more: true,
      },
    }
    : {
      binding: BINDING1, focus: focus(),
      sessions: { items: [item(SESSION3, 'archived')], next_cursor: null, has_more: false },
    };
  const model = new CanonicalTuiChatModel(ACCOUNT, source);
  const updates: string[] = [];
  const unsubscribe = model.subscribe((view) => { updates.push(view.status); });
  assert.deepEqual(updates, ['idle']);
  assert.equal(await model.read(), true);
  assert.equal(await model.loadCatalog(), true);
  model.setDraft('same focus draft');
  assert.equal(model.state.catalog.canLoadOlder, true);
  assert.equal(await model.loadCatalog(true), true);
  assert.deepEqual(model.state.catalog.items.map((value) => value.id), [SESSION3]);
  assert.equal(model.state.catalog.olderPage, true);
  assert.equal(model.state.draft, 'same focus draft');
  assert.equal(JSON.stringify(model.state).includes('secret'), false);
  assert.equal(JSON.stringify(model.state).includes(BINDING1), false);

  const exposed = model.state;
  exposed.catalog.items[0]!.title = 'mutated';
  exposed.catalog.focus!.version = 99;
  assert.notEqual(model.state.catalog.items[0]!.title, 'mutated');
  assert.equal(model.state.catalog.focus!.version, 1);
  unsubscribe();
  await model.dispose();
});

test('an unknown turn preserves its exact private request and only explicit retry resends it', async () => {
  const { source, model } = await ready();
  let attempts = 0;
  source.sendImpl = async (_binding, request) => {
    attempts++;
    if (attempts === 1) throw new AgentTurnComposeFailure('unknown');
    assert.equal(request.operation, 'submit');
    return envelope(request, {
      turn_id: TURN1, status: 'completed', accepted_sequence: 4,
      state_version: request.input.expected_state_version + 1, replayed: true,
      private_receipt: 'server-secret',
    });
  };
  model.setDraft('private prompt');
  assert.equal(await model.submit(), false);
  assert.equal(source.sendCalls.length, 1);
  assert.equal(model.state.turn.status, 'unknown');
  assert.equal(model.state.turn.canRetry, false);
  assert.equal(model.state.canEdit, false);
  assert.equal(await model.create('workflow', 'must not run'), false);
  assert.equal(source.createCalls.length, 0);

  assert.equal(await model.read(), true);
  assert.equal(model.state.turn.canRetry, true);
  const publicRequest = model.state.turn.request as unknown as Record<string, unknown>;
  assert.equal('input' in publicRequest, false);
  assert.equal('input_text' in publicRequest, false);
  assert.equal('scope' in publicRequest, false);
  assert.equal(JSON.stringify(model.state).includes(BINDING1), false);
  assert.equal(await model.retry(), true);
  assert.equal(source.sendCalls.length, 2);
  assert.deepEqual(source.sendCalls[1]!.request, source.sendCalls[0]!.request);
  assert.equal(model.state.draft, '');
  assert.equal(JSON.stringify(model.state).includes('server-secret'), false);
  await model.dispose();
});

test('a lost create acknowledgement runs once and blocks writes until an explicit latest catalog read', async () => {
  const source = new ChatSource();
  source.currentCursor = SESSION2;
  const { model } = await ready(source);
  model.setDraft('discard when focus changes');
  source.createImpl = async (_binding, input) => {
    source.currentFocus = focus(SESSION2, input.expected_version + 1);
    source.currentConversation = conversation(SESSION2);
    source.currentItems = [item(SESSION2), item(SESSION1)];
    throw new DexError('network_error', 'private transport detail', {
      outcome: 'unknown', access_token: 'private-token',
    });
  };
  assert.equal(await model.create('workflow', 'new session'), false);
  assert.equal(source.createCalls.length, 1);
  assert.equal(model.state.catalog.writeBlocked, true);
  assert.equal(model.state.catalog.canWrite, false);
  assert.equal(JSON.stringify(model.state).includes('private'), false);
  assert.equal(await model.create('workflow', 'must not replay'), false);
  assert.equal(source.createCalls.length, 1);

  source.catalogImpl = async (_signal, beforeId) => beforeId === undefined
    ? {
      binding: BINDING1, focus: source.currentFocus,
      sessions: { items: source.currentItems, next_cursor: null, has_more: false },
    }
    : {
      binding: BINDING1, focus: focus(),
      sessions: { items: [item(SESSION3)], next_cursor: null, has_more: false },
    };
  assert.equal(await model.loadCatalog(true), true);
  assert.equal(model.state.catalog.writeBlocked, true);
  assert.equal(model.state.catalog.canWrite, false);
  assert.equal(await model.loadCatalog(), true);
  assert.equal(model.state.catalog.writeBlocked, false);
  assert.equal(model.state.catalog.focus!.active_agent_session_id, SESSION2);
  assert.equal(model.state.draft, '');
  assert.equal(source.createCalls.length, 1);
  await model.dispose();
});

test('stop fences a late create acknowledgement and preserves the uncertain lock through reread', async () => {
  const { source, model } = await ready();
  const late = deferred<CreatedAgentSession>();
  source.createImpl = async () => late.promise;
  model.setDraft('same login draft');
  const creating = model.create('workflow', 'new');
  await until(() => source.createCalls.length === 1);
  const stopping = model.stop();
  assert.equal(model.state.conversation, null);
  assert.equal(model.state.draft, 'same login draft');

  source.currentFocus = focus(SESSION2, 2);
  source.currentConversation = conversation(SESSION2);
  late.resolve({ id: SESSION2, workflow_id: 'workflow', focus: source.currentFocus });
  assert.equal(await creating, false);
  await stopping;
  assert.equal(model.state.catalog.writeBlocked, true);
  assert.equal(model.state.draft, 'same login draft');
  assert.equal(await model.read(), true);
  assert.equal(model.state.catalog.writeBlocked, true);
  assert.equal(model.state.catalog.canWrite, false);
  assert.equal(model.state.draft, '');
  await model.dispose();
});

test('a catalog transition aborts a read and waits for both the task and vault drain', async () => {
  const source = new ChatSource();
  const readResult = deferred<{ conversation: AgentConversationView; has_more: boolean }>();
  const firstDrain = deferred<void>();
  source.readImpl = async () => readResult.promise;
  source.settleImpl = async () => {
    if (source.settleCalls === 1) await firstDrain.promise;
  };
  const model = new CanonicalTuiChatModel(ACCOUNT, source);
  const reading = model.read();
  await until(() => source.readCalls === 1);
  const loading = model.loadCatalog();
  readResult.resolve({ conversation: conversation(), has_more: false });
  await until(() => source.settleCalls === 1);
  assert.equal(source.catalogCalls.length, 0);
  assert.equal(model.state.conversation, null);
  firstDrain.resolve();
  assert.equal(await reading, false);
  assert.equal(await loading, true);
  assert.equal(source.catalogCalls.length, 1);
  assert.equal(model.state.status, 'connected');
  await model.dispose();
});

test('double-click writes dispatch once and a focus acknowledgement is checked against exact CAS', async () => {
  const { source, model } = await ready();
  const created = deferred<CreatedAgentSession>();
  source.createImpl = async () => created.promise;
  const first = model.create('workflow', 'new');
  await until(() => source.createCalls.length === 1);
  assert.equal(await model.create('workflow', 'duplicate'), false);
  assert.equal(source.createCalls.length, 1);
  source.currentConversation = conversation(SESSION2);
  source.currentFocus = focus(SESSION2, 2);
  created.resolve({ id: SESSION2, workflow_id: 'workflow', focus: source.currentFocus });
  assert.equal(await first, true);
  assert.equal(source.createCalls.length, 1);
  assert.equal(model.state.catalog.focus!.active_agent_session_id, SESSION2);

  // The current replacement page owns selection eligibility.
  assert.equal(await model.select(SESSION1), false);
  assert.equal(source.selectCalls.length, 0);
  await model.dispose();
});

test('temporary loss preserves same-scope draft, while binding or focus changes fence private state', async () => {
  const { source, model } = await ready();
  model.setDraft('keep through reconnect');
  source.readImpl = async () => {
    throw new DexError('network_error', 'private failure');
  };
  assert.equal(await model.read(), false);
  assert.equal(model.state.draft, 'keep through reconnect');
  assert.equal(model.state.canEdit, false);

  source.readImpl = undefined;
  assert.equal(await model.read(), true);
  assert.equal(model.state.draft, 'keep through reconnect');
  source.currentBinding = BINDING2;
  assert.equal(await model.read(), true);
  assert.equal(model.state.draft, '');
  assert.equal(model.state.catalog.focus, null);
  assert.equal(model.state.catalog.items.length, 0);
  assert.equal(model.state.status, 'connected');
  assert.equal(model.state.canEdit, true);
  assert.equal(JSON.stringify(model.state).includes(BINDING2), false);
  await model.dispose();
});

test('malformed lifecycle and cross-scope turn acknowledgements fail closed without leaking metadata', async () => {
  const lifecycle = await ready();
  lifecycle.source.createImpl = async () => ({
    id: SESSION2, workflow_id: 'wrong-workflow', focus: focus(SESSION2, 99),
    access_token: 'lifecycle-secret',
  } as CreatedAgentSession);
  assert.equal(await lifecycle.model.create('workflow', 'new'), false);
  assert.equal(lifecycle.model.state.catalog.writeBlocked, true);
  assert.equal(lifecycle.model.state.catalog.canWrite, false);
  assert.equal(JSON.stringify(lifecycle.model.state).includes('secret'), false);
  await lifecycle.model.dispose();

  const turn = await ready();
  turn.source.sendImpl = async (_binding, request) => ({
    ...request.scope,
    profile: 'other-profile',
    agent_session_id: request.agent_session_id,
    mutation: {
      turn_id: TURN1, status: 'accepted', accepted_sequence: 4,
      state_version: 3, replayed: false,
    },
    refresh_token: 'turn-secret',
  });
  turn.model.setDraft('visible editor text');
  assert.equal(await turn.model.submit(), false);
  assert.equal(turn.model.state.turn.status, 'unknown');
  assert.equal(JSON.stringify(turn.model.state).includes('turn-secret'), false);
  assert.equal(JSON.stringify(turn.model.state).includes(BINDING1), false);
  await turn.model.dispose();
  assert.equal(turn.model.state.draft, '');
  assert.equal(turn.model.state.conversation, null);
  assert.equal(turn.model.state.catalog.items.length, 0);
});

test('attachments must all be ready and an uncertain turn retries the exact ordered references after local cancellation', async () => {
  const { source, model } = await ready();
  model.setDraft('message with files');
  assert.equal(await model.selectAttachments(['/tmp/first secret.txt', '/tmp/second.bin']), true);
  assert.deepEqual(model.state.attachments.items.map((value) => value.status), ['selected', 'selected']);
  assert.equal(JSON.stringify(model.state).includes('/tmp/'), false);
  assert.equal(JSON.stringify(model.state).includes('selection-'), false);
  assert.equal(JSON.stringify(model.state).includes('dddddddd'), false);
  assert.equal(await model.submit(), false);
  assert.equal(source.sendCalls.length, 0);
  assert.match(model.state.attachments.notice, /ready/);

  assert.equal(await model.uploadAttachment(0), true);
  assert.equal(await model.uploadAttachment(1), true);
  assert.deepEqual(model.state.attachments.items.map((value) => value.status), ['ready', 'ready']);
  let attempts = 0;
  source.sendImpl = async (_binding, request) => {
    attempts++;
    if (attempts === 1) throw new AgentTurnComposeFailure('unknown');
    return envelope(request, {
      turn_id: TURN1, status: 'completed', accepted_sequence: 4,
      state_version: request.input.expected_state_version + 1, replayed: true,
    });
  };
  assert.equal(await model.submit(), false);
  assert.equal(source.sendCalls.length, 1);
  assert.deepEqual(source.sendCalls[0]!.request.operation === 'submit'
    ? source.sendCalls[0]!.request.input.attachments : undefined, [
    { attachment_id: ATTACHMENT1, sha256: '1'.repeat(64) },
    { attachment_id: ATTACHMENT2, sha256: '2'.repeat(64) },
  ]);

  // Local/server cancellation changes the visible draft only. The composer owns
  // the original text, CAS, idempotency key and ordered attachment references.
  assert.equal(await model.read(), true);
  assert.equal(await model.cancelAttachment(0), true);
  assert.equal(source.sendCalls.length, 1);
  assert.equal(model.state.attachments.items.length, 1);
  assert.equal(model.state.turn.canRetry, true);
  assert.equal(await model.retry(), true);
  assert.equal(source.sendCalls.length, 2);
  assert.deepEqual(source.sendCalls[1], source.sendCalls[0]);
  assert.equal(model.state.draft, '');
  await model.dispose();
});

test('a stopped or credential-replaced attachment selection cannot restore a late private draft', async () => {
  const source = new ChatSource();
  const late = deferred<readonly CanonicalTuiAttachmentDraft[]>();
  source.selectAttachmentsImpl = async () => late.promise;
  const { model } = await ready(source);
  const selecting = model.selectAttachments(['/tmp/private-name.txt']);
  await until(() => source.attachmentCalls.some((value) => value.action === 'select'));
  const stopping = model.stop();
  source.currentBinding = BINDING2;
  late.resolve([{
    handle: 'private-handle', filename: 'private-name.txt', sizeBytes: 9,
    mediaType: 'application/octet-stream', status: 'selected', sha256: 'a'.repeat(64),
  }]);
  assert.equal(await selecting, false);
  await stopping;
  assert.deepEqual(model.state.attachments.items, []);
  assert.equal(JSON.stringify(model.state).includes('private-handle'), false);
  assert.equal(JSON.stringify(model.state).includes('/tmp/'), false);
  await model.dispose();
});
