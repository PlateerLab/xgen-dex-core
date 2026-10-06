import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { DexError, type NativeCliSession } from '@dex/engine';
import type { ReserveAgentAttachmentInput } from '@dex/protocol/agent-session-attachments';
import type { AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import { createCanonicalTuiChatSource } from '../src/canonical-tui-chat-source';

const ACCOUNT = { profile: 'corp', origin: 'https://app.example.test', userId: '7' };
const SESSION = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const BINDING1 = 'native-binding.private.one';
const BINDING2 = 'native-binding.private.two';
const SCOPE = { agentSessionId: SESSION, workflowId: 'workflow' };

class AttachmentSession {
  authScopes: string[] = [];
  reserveCalls: ReserveAgentAttachmentInput[] = [];
  uploadCalls = 0;
  receiptCalls = 0;
  cancelCalls = 0;
  submitCalls: unknown[] = [];
  reserveUnknown = false;
  uploadUnknown = false;

  async agentSessionCatalog() {
    return {
      authScope: BINDING1,
      focus: { active_agent_session_id: SESSION, version: 1, event_id: null },
      sessions: { items: [], next_cursor: null, has_more: false },
    };
  }

  async withProofSource<T>(_userId: string, work: (proof: never, current: string, generation: string) => Promise<T>) {
    const current = this.authScopes.shift() ?? BINDING1;
    return work(undefined as never, current, 'generation');
  }

  async reserveAttachment(_userId: string, _sessionId: string, _workflowId: string, metadata: ReserveAgentAttachmentInput) {
    this.reserveCalls.push({ ...metadata });
    if (this.reserveUnknown) {
      this.reserveUnknown = false;
      throw new DexError('network_error', 'private reserve detail', { outcome: 'unknown' });
    }
    return { attachment_id: ATTACHMENT, status: 'reserved' as const, expires_at: '2030-01-01T00:00:00Z' };
  }

  async uploadAttachment(_userId: string, sessionId: string, workflowId: string, _attachmentId: string,
    metadata: ReserveAgentAttachmentInput, bytes: Uint8Array) {
    this.uploadCalls++;
    assert.equal(bytes.byteLength, metadata.size_bytes);
    if (this.uploadUnknown) {
      this.uploadUnknown = false;
      throw new DexError('network_error', 'private upload detail', { outcome: 'unknown' });
    }
    return this.receipt(sessionId, workflowId, metadata);
  }

  async readAttachmentReceipt(_userId: string, sessionId: string, workflowId: string, _attachmentId: string) {
    this.receiptCalls++;
    return this.receipt(sessionId, workflowId, this.reserveCalls.at(-1)!);
  }

  async cancelAttachment() { this.cancelCalls++; }
  async settleProofOperations() {}

  async submitTurn(_userId: string, _sessionId: string, input: unknown) {
    this.submitCalls.push(input);
    return { turn_id: TURN, status: 'accepted', accepted_sequence: 1, state_version: 2, replayed: false };
  }

  private receipt(sessionId: string, workflowId: string, metadata: ReserveAgentAttachmentInput) {
    return {
      origin: ACCOUNT.origin, user_id: ACCOUNT.userId, session_id: sessionId, workflow_id: workflowId,
      attachment_id: ATTACHMENT, filename: metadata.filename, size_bytes: metadata.size_bytes,
      media_type: metadata.media_type, sha256: metadata.sha256,
    };
  }
}

async function fixture(contents = 'attachment bytes') {
  const directory = await mkdtemp(join(tmpdir(), 'dex-cli-attachment-'));
  const path = join(directory, 'name with spaces.txt');
  await writeFile(path, contents);
  const session = new AttachmentSession();
  const source = createCanonicalTuiChatSource(ACCOUNT, session as unknown as NativeCliSession);
  await source.catalog(new AbortController().signal);
  return { directory, path, session, source };
}

test('explicit CLI selection rechecks the private login after reading and retains no draft after rotation', async () => {
  const value = await fixture();
  try {
    value.session.authScopes.push(BINDING1, BINDING2);
    await assert.rejects(
      value.source.selectAttachments(BINDING1, SCOPE, [value.path], new AbortController().signal),
      (error: unknown) => error instanceof DexError && error.code === 'auth_required'
        && !error.message.includes(value.path),
    );
    assert.deepEqual(value.source.attachments(BINDING1, SCOPE), []);
  } finally {
    value.source.clearAttachments();
    await rm(value.directory, { recursive: true });
  }
});

test('unknown reserve requires explicit stable re-reserve before upload and produces one ready reference', async () => {
  const value = await fixture();
  try {
    await value.source.selectAttachments(BINDING1, SCOPE, [relative(process.cwd(), value.path)], new AbortController().signal);
    const selected = value.source.attachments(BINDING1, SCOPE)[0]!;
    value.session.reserveUnknown = true;
    await assert.rejects(value.source.uploadAttachment(
      BINDING1, SCOPE, selected.handle, new AbortController().signal,
    ));
    assert.equal(value.source.attachments(BINDING1, SCOPE)[0]!.status, 'uncertain');
    assert.equal(value.session.uploadCalls, 0);

    await value.source.recoverAttachment(BINDING1, SCOPE, selected.handle, new AbortController().signal);
    assert.equal(value.source.attachments(BINDING1, SCOPE)[0]!.status, 'reserved');
    assert.equal(value.session.reserveCalls.length, 2);
    assert.deepEqual(value.session.reserveCalls[1], value.session.reserveCalls[0]);
    await value.source.uploadAttachment(BINDING1, SCOPE, selected.handle, new AbortController().signal);
    assert.equal(value.source.attachments(BINDING1, SCOPE)[0]!.status, 'ready');
    assert.equal(value.session.uploadCalls, 1);
    assert.deepEqual(value.source.attachmentReferences(BINDING1, SCOPE), [{
      attachment_id: ATTACHMENT,
      sha256: value.session.reserveCalls[0]!.sha256,
    }]);
  } finally {
    value.source.clearAttachments();
    await rm(value.directory, { recursive: true });
  }
});

test('unknown PUT recovery uses GET only and a successful attached submit releases local bytes', async () => {
  const value = await fixture();
  try {
    await value.source.selectAttachments(BINDING1, SCOPE, [value.path], new AbortController().signal);
    const selected = value.source.attachments(BINDING1, SCOPE)[0]!;
    value.session.uploadUnknown = true;
    await assert.rejects(value.source.uploadAttachment(
      BINDING1, SCOPE, selected.handle, new AbortController().signal,
    ));
    assert.equal(value.source.attachments(BINDING1, SCOPE)[0]!.status, 'uncertain');
    const reserveCount = value.session.reserveCalls.length;
    const uploadCount = value.session.uploadCalls;
    await value.source.recoverAttachment(BINDING1, SCOPE, selected.handle, new AbortController().signal);
    assert.equal(value.session.reserveCalls.length, reserveCount);
    assert.equal(value.session.uploadCalls, uploadCount);
    assert.equal(value.session.receiptCalls, 1);

    const references = value.source.attachmentReferences(BINDING1, SCOPE);
    const request: AgentTurnComposeRequest = {
      operation: 'submit',
      scope: { platform_type: 'cli', profile: ACCOUNT.profile, server_url: ACCOUNT.origin, user_id: ACCOUNT.userId },
      agent_session_id: SESSION,
      input: { input_text: 'send', expected_state_version: 1, idempotency_key: 'stable-key', attachments: references },
    };
    await value.source.send(BINDING1, request, new AbortController().signal);
    assert.deepEqual(value.source.attachments(BINDING1, SCOPE), []);
    assert.deepEqual((value.session.submitCalls[0] as { attachments: unknown }).attachments, references);
  } finally {
    value.source.clearAttachments();
    await rm(value.directory, { recursive: true });
  }
});
