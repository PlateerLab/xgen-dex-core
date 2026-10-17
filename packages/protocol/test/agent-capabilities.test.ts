import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentCapabilitiesClient,
  AgentCapabilitiesHttpError,
  AgentCapabilitiesOutcomeUnknown,
  AgentCapabilitiesProtocolError,
  AgentCapabilitiesTransportError,
  parseCapabilityApprovalPage,
  parseCapabilityCatalog,
  validateSelectCapabilities,
  type AgentCapabilitiesProofSource,
} from '../src/agent-capabilities';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const DEVICE = '018f1240-0000-7000-8000-000000000002';
const CONNECTION = `conn_${'c'.repeat(32)}`;
const EPOCH = `epoch_${'e'.repeat(32)}`;
const VERSION = '018f1240-0000-7000-8000-000000000005';
const TURN = '018f1240-0000-7000-8000-000000000006';
const INTENT = '018f1240-0000-7000-8000-000000000007';
const CAPABILITY = `cap://device/${DEVICE}/mcp/local/Read`;

function catalog(patch: Record<string, unknown> = {}) {
  return {
    capabilities: [{ capability_id: CAPABILITY, server: 'local', name: 'Read', description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, risk: 'high', approval_mode: 'per_call',
      device_id: DEVICE, connection_id: CONNECTION, epoch: EPOCH, descriptor_hash: 'a'.repeat(64) }],
    version: VERSION, selected_capability_ids: [CAPABILITY], expires_at: 2_000_000_000, ...patch,
  };
}

function approvals(patch: Record<string, unknown> = {}) {
  return { approvals: [{ approval_id: 7, intent_version: INTENT, status: 'pending', capability_id: CAPABILITY,
    tool_name: 'Read', target_device_id: DEVICE, args_sha256: 'b'.repeat(64), source_turn_id: TURN,
    expires_at: 2_000_000_000 }], ...patch };
}

function proof(): AgentCapabilitiesProofSource {
  return { accessToken: async () => 'access.safe.jwt', signProof: async () => 'proof.safe.jwt' };
}

test('uses only the canonical capability routes, DPoP and closed projected results', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const responses = [catalog(), { version: VERSION, selected_capability_ids: [CAPABILITY], expires_at: 2_000_000_000 },
    approvals(), { approval_id: 7, intent_version: VERSION, status: 'armed', expires_at: 2_000_000_000 }];
  const client = new AgentCapabilitiesClient(ORIGIN, proof(), (async (input, init = {}) => {
    calls.push({ url: String(input), init }); return Response.json(responses.shift());
  }) as typeof fetch);
  assert.deepEqual(await client.catalog(SESSION), catalog());
  assert.deepEqual(await client.select(SESSION, { capability_ids: [CAPABILITY], expected_version: VERSION }), {
    version: VERSION, selected_capability_ids: [CAPABILITY], expires_at: 2_000_000_000,
  });
  assert.deepEqual(await client.approvals(SESSION), approvals());
  assert.deepEqual(await client.adopt(SESSION, 7, INTENT), {
    approval_id: 7, intent_version: VERSION, status: 'armed', expires_at: 2_000_000_000,
  });
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${new URL(url).pathname}`), [
    `GET /api/agentflow/agent-sessions/${SESSION}/capabilities`,
    `PUT /api/agentflow/agent-sessions/${SESSION}/capabilities`,
    `GET /api/agentflow/agent-sessions/${SESSION}/capability-approvals`,
    `POST /api/agentflow/agent-sessions/${SESSION}/capability-approvals/7/adopt`,
  ]);
  for (const { init } of calls) {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'DPoP access.safe.jwt'); assert.equal(headers.DPoP, 'proof.safe.jwt');
  }
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { capability_ids: [CAPABILITY], expected_version: VERSION });
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { expected_version: INTENT });
});

test('catalog and approvals reject open, malformed, duplicated and unsafe shapes', () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>;
  const safe = parseCapabilityCatalog(catalog({ capabilities: [{ ...catalog().capabilities[0], inputSchema: schema }] }));
  const properties = safe.capabilities[0]!.inputSchema.properties as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(properties), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(properties, '__proto__'), true);
  for (const value of [
    catalog({ private_token: 'secret' }),
    catalog({ capabilities: [{ ...catalog().capabilities[0], descriptor_version: 1 }] }),
    catalog({ capabilities: [catalog().capabilities[0], catalog().capabilities[0]] }),
    catalog({ capabilities: [{ ...catalog().capabilities[0], capability_id: 'cap://device/wrong/mcp/local/Read' }] }),
    catalog({ version: null }),
    catalog({ capabilities: [{ ...catalog().capabilities[0], inputSchema: { type: 'array' } }] }),
  ]) assert.throws(() => parseCapabilityCatalog(value), AgentCapabilitiesProtocolError);
  for (const value of [
    approvals({ private_token: 'secret' }),
    { approvals: [{ ...approvals().approvals[0], secret: true }] },
    { approvals: [approvals().approvals[0], approvals().approvals[0]] },
    { approvals: [{ ...approvals().approvals[0], target_device_id: SESSION }] },
    { approvals: [{ ...approvals().approvals[0], status: 'unknown' }] },
  ]) assert.throws(() => parseCapabilityApprovalPage(value), AgentCapabilitiesProtocolError);
});

test('selection input is detached, closed and bounded', () => {
  const ids = [CAPABILITY];
  const value = validateSelectCapabilities({ capability_ids: ids, expected_version: null });
  ids[0] = 'cap://device/mutated';
  assert.deepEqual(value, { capability_ids: [CAPABILITY], expected_version: null });
  for (const item of [
    { capability_ids: [CAPABILITY, CAPABILITY], expected_version: null },
    { capability_ids: new Array(65).fill(CAPABILITY), expected_version: null },
    { capability_ids: [CAPABILITY], expected_version: 'bad' },
    { capability_ids: [CAPABILITY], expected_version: null, extra: true },
  ]) assert.throws(() => validateSelectCapabilities(item), TypeError);
});

test('responses are size bounded and writes never retry or classify uncertain transport as rejected', async () => {
  let calls = 0;
  const oversized = new AgentCapabilitiesClient(ORIGIN, proof(), (async () => {
    calls++; return new Response('x'.repeat(1024 * 1024 + 1));
  }) as typeof fetch);
  await assert.rejects(oversized.catalog(SESSION), AgentCapabilitiesProtocolError);
  assert.equal(calls, 1);
  const duplicate = new AgentCapabilitiesClient(ORIGIN, proof(), (async () => new Response(
    '{"capabilities":[],"capabilities":[],"version":null,"selected_capability_ids":[],"expires_at":null}',
    { headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch);
  await assert.rejects(duplicate.catalog(SESSION), AgentCapabilitiesProtocolError);

  const offline = new AgentCapabilitiesClient(ORIGIN, proof(), (async () => { calls++; throw new Error('private'); }) as typeof fetch);
  await assert.rejects(offline.catalog(SESSION), AgentCapabilitiesTransportError);
  await assert.rejects(offline.select(SESSION, { capability_ids: [], expected_version: null }), AgentCapabilitiesOutcomeUnknown);
  assert.equal(calls, 3);

  const rejected = new AgentCapabilitiesClient(ORIGIN, proof(), (async () => new Response('secret', { status: 409 })) as typeof fetch);
  await assert.rejects(rejected.select(SESSION, { capability_ids: [], expected_version: null }),
    (error: unknown) => error instanceof AgentCapabilitiesHttpError && error.status === 409 && !error.message.includes('secret'));

  const malformed = new AgentCapabilitiesClient(ORIGIN, proof(), (async () => Response.json({
    version: VERSION, selected_capability_ids: [], expires_at: 'wrong',
  })) as typeof fetch);
  await assert.rejects(malformed.select(SESSION, { capability_ids: [], expected_version: null }), AgentCapabilitiesOutcomeUnknown);
});
