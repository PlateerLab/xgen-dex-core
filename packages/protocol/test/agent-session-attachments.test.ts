import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AGENT_ATTACHMENT_MAX_BYTES, AGENT_ATTACHMENT_MAX_COUNT, AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  AgentAttachmentValidationError, parseAgentAttachmentReceipt, parseAgentAttachmentScope,
  prepareAgentAttachmentReferences, type AgentAttachmentReceipt, type AgentAttachmentScope,
} from '../src/agent-session-attachments';
import { AgentSessionMutationClient } from '../src/agent-session-mutation';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/agent-session-attachments.json', import.meta.url), 'utf8')) as {
  version: number;
  cases: { name: string; scope: unknown; receipts: unknown; valid: boolean; references?: unknown }[];
};
assert.equal(fixtures.version, 1);
const scope: AgentAttachmentScope = {
  origin: 'https://xgen.example.com', user_id: '7',
  session_id: '11111111-1111-4111-8111-111111111111', workflow_id: 'workflow-한글',
};
const receipt: AgentAttachmentReceipt = {
  ...scope, attachment_id: '22222222-2222-4222-8222-222222222222',
  filename: '자료.txt', size_bytes: 42, media_type: 'text/plain', sha256: 'a'.repeat(64),
};

for (const fixture of fixtures.cases) {
  test(`shared SDK/DEX attachment contract: ${fixture.name}`, () => {
    if (fixture.valid) assert.deepEqual(prepareAgentAttachmentReferences(fixture.receipts, fixture.scope), fixture.references);
    else assert.throws(() => prepareAgentAttachmentReferences(fixture.receipts, fixture.scope), AgentAttachmentValidationError);
  });
}

test('references keep exact order and immutable copies without display or identity metadata', () => {
  const input = [{ ...receipt }, { ...receipt, attachment_id: '33333333-3333-4333-8333-333333333333', sha256: 'b'.repeat(64) }];
  const result = prepareAgentAttachmentReferences(input, scope);
  assert.deepEqual(Object.keys(result[0]), ['attachment_id', 'sha256']);
  assert.deepEqual(result.map((item) => item.attachment_id), input.map((item) => item.attachment_id));
  input.reverse(); input[1].sha256 = 'c'.repeat(64); input.length = 0;
  assert.equal(result[0].attachment_id, receipt.attachment_id);
  assert.equal(result[0].sha256, receipt.sha256);
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen));
  assert.throws(() => (result as unknown[]).push({}), TypeError);
  assert.throws(() => { (result[0] as { sha256: string }).sha256 = 'c'.repeat(64); }, TypeError);
  const parsed = parseAgentAttachmentReceipt(receipt, scope);
  assert.ok(Object.isFrozen(parsed)); assert.notEqual(parsed, receipt);
  const context = parseAgentAttachmentScope(scope);
  assert.ok(Object.isFrozen(context)); assert.notEqual(context, scope);
});

test('byte, count, integer and aggregate boundaries are enforced before intent preparation', () => {
  assert.equal(AGENT_ATTACHMENT_MAX_BYTES, 104857600);
  assert.equal(AGENT_ATTACHMENT_MAX_TOTAL_BYTES, 104857600);
  assert.equal(AGENT_ATTACHMENT_MAX_COUNT, 10);
  const exact = { ...receipt, size_bytes: AGENT_ATTACHMENT_MAX_BYTES, filename: '가'.repeat(85), workflow_id: '가'.repeat(42) + 'ab' };
  assert.equal(parseAgentAttachmentReceipt(exact, { ...scope, workflow_id: exact.workflow_id }).filename, exact.filename);
  for (const patch of [{ filename: exact.filename + 'a' }, { size_bytes: 104857601 }, { size_bytes: NaN }, { size_bytes: Infinity }]) {
    assert.throws(() => parseAgentAttachmentReceipt({ ...exact, ...patch }, { ...scope, workflow_id: exact.workflow_id }), AgentAttachmentValidationError);
  }
  assert.throws(() => parseAgentAttachmentScope({ ...scope, workflow_id: exact.workflow_id + 'a' }), AgentAttachmentValidationError);
  const ten = Array.from({ length: 10 }, (_, index) => ({ ...receipt, attachment_id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, size_bytes: 10485760 }));
  assert.equal(prepareAgentAttachmentReferences(ten, scope).length, 10);
  assert.throws(() => prepareAgentAttachmentReferences([...ten, receipt], scope), AgentAttachmentValidationError);
  ten[0].size_bytes++;
  assert.throws(() => prepareAgentAttachmentReferences(ten, scope), AgentAttachmentValidationError);
});

test('reject accessor/inherited/symbol fields, non-arrays and sparse input without exposing their errors', () => {
  let accessed = false;
  const accessor = { ...receipt };
  Object.defineProperty(accessor, 'filename', { get: () => { accessed = true; throw new Error('private storage path'); } });
  for (const input of [accessor, Object.create(receipt), { ...receipt, [Symbol('secret')]: true }]) {
    assert.throws(() => parseAgentAttachmentReceipt(input, scope), AgentAttachmentValidationError);
  }
  assert.equal(accessed, false);
  for (const input of [null, {}, 'raw bytes', new Array(1), new Set([receipt])]) {
    assert.throws(() => prepareAgentAttachmentReferences(input, scope), AgentAttachmentValidationError);
  }
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('password=secret'); } });
  assert.throws(() => parseAgentAttachmentScope(proxy), {
    name: 'AgentAttachmentValidationError', message: 'Invalid canonical Agent Session attachment metadata',
  });
});

test('parsed receipts are bound to every authenticated context field; MIME is not an image claim', () => {
  const parsed = parseAgentAttachmentReceipt({ ...receipt, media_type: 'image/png' }, scope);
  assert.equal(parsed.media_type, 'image/png');
  assert.equal('kind' in parsed, false);
  for (const changed of [
    { origin: 'https://other.example.com' }, { user_id: '8' },
    { session_id: '33333333-3333-4333-8333-333333333333' }, { workflow_id: 'other' },
  ]) assert.throws(() => prepareAgentAttachmentReferences([parsed], { ...scope, ...changed }), AgentAttachmentValidationError);
  assert.equal(parseAgentAttachmentScope({ ...scope, user_id: '9223372036854775807' }).user_id, '9223372036854775807');
});

test('metadata preparation never enables attachment submission to the current text-only API', async () => {
  let tokenCalls = 0; let proofCalls = 0; let wireCalls = 0;
  const client = new AgentSessionMutationClient(scope.origin, {
    accessToken: async () => { tokenCalls++; return 'token'; },
    signProof: async () => { proofCalls++; return 'proof'; },
  }, async () => { wireCalls++; throw new Error('must not dispatch'); });
  const references = prepareAgentAttachmentReferences([receipt], scope);
  await assert.rejects(() => client.submitTurn(scope.session_id, {
    input_text: 'text', idempotency_key: 'one', expected_state_version: 1,
    attachments: references,
  } as never), TypeError);
  assert.deepEqual([tokenCalls, proofCalls, wireCalls], [0, 0, 0]);
});
