import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentAttachmentHttpError,
  AgentAttachmentOutcomeUnknown,
  AgentSessionAttachmentClient,
  AgentSessionAttachmentProtocolError,
  AgentSessionAttachmentTransportError,
  type AgentSessionAttachmentProofSource,
  type ReservedAgentAttachment,
} from '../src/agent-session-attachment-client';
import {
  AgentAttachmentValidationError,
  validateAgentAttachmentId,
  validateReserveAgentAttachment,
  type AgentAttachmentReceipt,
  type AgentAttachmentScope,
  type ReserveAgentAttachmentInput,
} from '../src/agent-session-attachments';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const ATTACHMENT = '018f1240-0000-7000-8000-000000000002';
const EXPIRES = '2026-10-06T12:00:00Z';
const BYTES = Uint8Array.from([104, 101, 108, 108, 111]);
const SCOPE: AgentAttachmentScope = {
  origin: ORIGIN, user_id: '7', session_id: SESSION, workflow_id: 'workflow-한글',
};
const METADATA: ReserveAgentAttachmentInput = {
  upload_key: 'upload-1', filename: '자료.txt', size_bytes: 5,
  media_type: 'text/plain', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
};
const RESERVED: ReservedAgentAttachment = {
  attachment_id: ATTACHMENT, status: 'reserved', expires_at: EXPIRES,
};
const RECEIPT: AgentAttachmentReceipt = {
  ...SCOPE, attachment_id: ATTACHMENT, filename: METADATA.filename,
  size_bytes: METADATA.size_bytes, media_type: METADATA.media_type, sha256: METADATA.sha256,
};

function proof(overrides: Partial<AgentSessionAttachmentProofSource> = {}): AgentSessionAttachmentProofSource {
  return {
    accessToken: async () => 'platform.access.jwt',
    signProof: async () => 'device.proof.jwt',
    ...overrides,
  };
}

test('reservation metadata and attachment identifiers are copied and validated synchronously', () => {
  const metadata = { ...METADATA };
  const result = validateReserveAgentAttachment(SCOPE, metadata);
  metadata.filename = 'changed.txt';
  assert.deepEqual(result, METADATA);
  assert.ok(Object.isFrozen(result));
  assert.equal(validateAgentAttachmentId(ATTACHMENT), ATTACHMENT);
  for (const invalid of [ATTACHMENT.toUpperCase(), '../attachment', '', null]) {
    assert.throws(() => validateAgentAttachmentId(invalid), AgentAttachmentValidationError);
  }
  for (const invalid of [
    { ...METADATA, upload_key: 'has space' }, { ...METADATA, upload_key: 'x'.repeat(129) },
    { ...METADATA, upload_key: 'stable-key\n' },
    { ...METADATA, filename: '../secret' }, { ...METADATA, size_bytes: true },
    { ...METADATA, media_type: 'Text/Plain' }, { ...METADATA, sha256: 'A'.repeat(64) },
    { ...METADATA, path: '/private/file' },
  ]) assert.throws(() => validateReserveAgentAttachment(SCOPE, invalid), AgentAttachmentValidationError);
});

test('all operations use exact URLs, methods, DPoP proofs and cookie-free no-redirect transport', async () => {
  const responses = [Response.json(RESERVED, { status: 201 }), Response.json(RECEIPT),
    Response.json(RECEIPT), new Response(null, { status: 204 })];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const signatures: Array<{ method: string; htu: string; token: string }> = [];
  const client = new AgentSessionAttachmentClient(ORIGIN, proof({
    signProof: async (method, htu, token) => {
      signatures.push({ method, htu, token });
      return `proof.${signatures.length}.jwt`;
    },
  }), (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return responses.shift()!;
  }) as typeof fetch);

  assert.deepEqual(await client.reserveAttachment(SCOPE, METADATA), RESERVED);
  assert.deepEqual(await client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, BYTES), RECEIPT);
  assert.deepEqual(await client.readReceipt(SCOPE, ATTACHMENT), RECEIPT);
  await client.cancelAttachment(SCOPE, ATTACHMENT);

  const base = `/api/agentflow/agent-sessions/${SESSION}/attachments`;
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    base, `${base}/${ATTACHMENT}/content`, `${base}/${ATTACHMENT}`, `${base}/${ATTACHMENT}/cancel`,
  ]);
  assert.deepEqual(calls.map(({ init }) => init.method), ['POST', 'PUT', 'GET', 'POST']);
  assert.deepEqual(signatures.map(({ method }) => method), ['POST', 'PUT', 'GET', 'POST']);
  assert.deepEqual(signatures.map(({ htu }) => htu), calls.map(({ url }) => url));
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), METADATA);
  assert.deepEqual(Array.from(calls[1].init.body as Uint8Array), Array.from(BYTES));
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'DPoP platform.access.jwt');
    assert.equal((call.init.headers as Record<string, string>).DPoP, `proof.${index + 1}.jwt`);
  }
  assert.equal((calls[1].init.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
  assert.equal((calls[1].init.headers as Record<string, string>)['Content-Length'], '5');
});

test('upload copies bytes and metadata before waiting for credentials', async () => {
  let release!: (token: string) => void;
  const waiting = new Promise<string>((resolve) => { release = resolve; });
  let sent: Uint8Array | undefined;
  const metadata = { ...METADATA };
  const bytes = Uint8Array.from(BYTES);
  const client = new AgentSessionAttachmentClient(ORIGIN, proof({ accessToken: () => waiting }),
    (async (_input, init) => {
      sent = init?.body as Uint8Array;
      return Response.json(RECEIPT);
    }) as typeof fetch);
  const pending = client.uploadAttachment(SCOPE, ATTACHMENT, metadata, bytes);
  bytes.fill(0); metadata.filename = 'mutated.txt'; release('platform.access.jwt');
  assert.deepEqual(await pending, RECEIPT);
  assert.deepEqual(Array.from(sent!), Array.from(BYTES));
});

test('invalid scope, metadata, id, bytes and size fail before credentials or proof', async () => {
  let credentials = 0; let signatures = 0; let fetches = 0;
  const client = new AgentSessionAttachmentClient(ORIGIN, proof({
    accessToken: async () => { credentials++; return 'platform.access.jwt'; },
    signProof: async () => { signatures++; return 'device.proof.jwt'; },
  }), (async () => { fetches++; throw new Error('unexpected'); }) as typeof fetch);
  const actions = [
    () => client.reserveAttachment({ ...SCOPE, origin: 'https://other.example.test' }, METADATA),
    () => client.reserveAttachment(SCOPE, { ...METADATA, path: '/tmp/private' } as never),
    () => client.uploadAttachment(SCOPE, '../id', METADATA, BYTES),
    () => client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, new Uint8Array(4)),
    () => client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, Uint8Array.from([104, 101, 108, 108, 112])),
    () => client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, 'raw path' as never),
  ];
  for (const action of actions) await assert.rejects(action(), TypeError);
  assert.deepEqual([credentials, signatures, fetches], [0, 0, 0]);
});

test('write status distinguishes authoritative rejection from unknown outcomes without retrying', async () => {
  for (const status of [400, 401, 403, 409, 422, 429]) {
    let calls = 0;
    const client = new AgentSessionAttachmentClient(ORIGIN, proof(), (async () => {
      calls++; return new Response('private path /tmp/file token', { status });
    }) as typeof fetch);
    await assert.rejects(client.reserveAttachment(SCOPE, METADATA), (error: unknown) =>
      error instanceof AgentAttachmentHttpError && error.status === status
      && !error.message.includes('/tmp/file'));
    assert.equal(calls, 1);
  }
  for (const status of [408, 500, 503]) {
    let calls = 0;
    const client = new AgentSessionAttachmentClient(ORIGIN, proof(), (async () => {
      calls++; return new Response('private', { status });
    }) as typeof fetch);
    await assert.rejects(client.reserveAttachment(SCOPE, METADATA), (error: unknown) =>
      error instanceof AgentAttachmentOutcomeUnknown && error.status === status);
    assert.equal(calls, 1);
  }
});

test('lost PUT acknowledgement stays unknown and recovery is an explicit receipt GET', async () => {
  const methods: string[] = [];
  const client = new AgentSessionAttachmentClient(ORIGIN, proof(), (async (_input, init) => {
    methods.push(String(init?.method));
    if (init?.method === 'PUT') throw new TypeError('socket lost with private path');
    return Response.json(RECEIPT);
  }) as typeof fetch);
  await assert.rejects(client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, BYTES), AgentAttachmentOutcomeUnknown);
  assert.deepEqual(methods, ['PUT']);
  assert.deepEqual(await client.readReceipt(SCOPE, ATTACHMENT), RECEIPT);
  assert.deepEqual(methods, ['PUT', 'GET']);
});

test('receipt scope, id and reservation metadata mismatches never become success', async () => {
  for (const broken of [
    { ...RECEIPT, attachment_id: '018f1240-0000-7000-8000-000000000003' },
    { ...RECEIPT, workflow_id: 'other' }, { ...RECEIPT, filename: 'other.txt' },
    { ...RECEIPT, size_bytes: 4 }, { ...RECEIPT, media_type: 'text/csv' },
    { ...RECEIPT, sha256: 'b'.repeat(64) },
  ]) {
    const client = new AgentSessionAttachmentClient(ORIGIN, proof(),
      (async () => Response.json(broken)) as typeof fetch);
    await assert.rejects(client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, BYTES), AgentAttachmentOutcomeUnknown);
  }
  const read = new AgentSessionAttachmentClient(ORIGIN, proof(),
    (async () => Response.json({ ...RECEIPT, attachment_id: '018f1240-0000-7000-8000-000000000003' })) as typeof fetch);
  await assert.rejects(read.readReceipt(SCOPE, ATTACHMENT), AgentSessionAttachmentProtocolError);
});

test('bounded response readers and caller cancellation do not hang', { timeout: 1500 }, async () => {
  const oversized = new AgentSessionAttachmentClient(ORIGIN, proof(),
    (async () => new Response(JSON.stringify({ value: 'x'.repeat(65536) }), { status: 201 })) as typeof fetch);
  await assert.rejects(oversized.reserveAttachment(SCOPE, METADATA), AgentAttachmentOutcomeUnknown);

  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  const ignored = new Promise<Response>(() => {});
  const client = new AgentSessionAttachmentClient(ORIGIN, proof(), (async () => {
    entered(); return ignored;
  }) as typeof fetch);
  const controller = new AbortController();
  const pending = client.uploadAttachment(SCOPE, ATTACHMENT, METADATA, BYTES, controller.signal);
  await dispatched; controller.abort();
  await assert.rejects(pending, AgentAttachmentOutcomeUnknown);

  const readController = new AbortController();
  const read = client.readReceipt(SCOPE, ATTACHMENT, readController.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); readController.abort();
  await assert.rejects(read, { name: 'AbortError' });
});

test('read failures retain authoritative statuses and scrub transport details', async () => {
  const unavailable = new AgentSessionAttachmentClient(ORIGIN, proof(),
    (async () => new Response('private', { status: 503 })) as typeof fetch);
  await assert.rejects(unavailable.readReceipt(SCOPE, ATTACHMENT), (error: unknown) =>
    error instanceof AgentAttachmentHttpError && error.status === 503);
  const lost = new AgentSessionAttachmentClient(ORIGIN, proof(),
    (async () => { throw new Error('token and /private/path'); }) as typeof fetch);
  await assert.rejects(lost.readReceipt(SCOPE, ATTACHMENT), (error: unknown) =>
    error instanceof AgentSessionAttachmentTransportError && !error.message.includes('/private/path'));
});

test('constructor rejects noncanonical and non-HTTPS origins', () => {
  for (const origin of ['http://app.example.test', 'https://app.example.test/', 'https://APP.example.test',
    'https://app.example.test:443', 'https://user:pass@app.example.test', 'https://xn--bcher-kva.example']) {
    assert.throws(() => new AgentSessionAttachmentClient(origin, proof()), TypeError);
  }
});
