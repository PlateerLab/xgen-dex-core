import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeRpcResult } from '@dex/rpc';
import type { DesktopNativeBridge, DesktopNativeNotice } from '../src/native-session-types';
import { DesktopCapabilityModel } from '../src/renderer/src/native-capability-model';
import { createDesktopScopedBridge } from '../src/renderer/src/native-session-binding';

const session = '00000000-0000-4000-8000-000000000001';
const version = '00000000-0000-4000-8000-000000000002';
const device = '00000000-0000-4000-8000-000000000003';
const capId = `cap://device/${device}/mcp/local/Shell`;
const expires = Math.floor(Date.now() / 1000) + 60;
const envelope = { platform_type: 'desktop' as const, profile: 'desktop', user_id: '7', server_url: 'https://fixture.example.test' };
function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let receive!: (notice: DesktopNativeNotice) => void;
  let foreign = false;
  const bridge: DesktopNativeBridge = {
    async request(method, params = {}) {
      calls.push({ method, params });
      const value: NativeRpcResult = { ...envelope };
      if (foreign) value.server_url = 'https://foreign.example.test';
      if (method === 'capabilities') value.capability_catalog = { authScope: 'a'.repeat(64), version, expires_at: expires,
        selected_capability_ids: [], capabilities: [{ capability_id: capId, device_id: device,
          name: 'Shell', server: 'local', description: 'Local shell', inputSchema: { type: 'object' }, risk: 'high',
          approval_mode: 'per_call', connection_id: version, epoch: version, descriptor_hash: 'b'.repeat(64) }] };
      if (method === 'capability-approvals') assert.equal(params.expected_auth_scope, 'a'.repeat(64));
      if (method === 'capability-approvals') value.capability_approvals = { approvals: [{ approval_id: 19,
        intent_version: version, status: 'approved', capability_id: capId, tool_name: 'Shell', target_device_id: device,
        args_sha256: 'c'.repeat(64), source_turn_id: session, expires_at: expires }] };
      if (method === 'select-capabilities') value.capability_selection = { version, expires_at: expires,
        selected_capability_ids: params.capability_ids as string[] };
      if (method === 'adopt-capability-approval') value.capability_adoption = { approval_id: 19,
        intent_version: version, status: 'armed', expires_at: expires };
      return { ok: true, value };
    },
    onUpdate(listener) { receive = listener; return () => {}; },
  };
  const model = new DesktopCapabilityModel(createDesktopScopedBridge(bridge, envelope.server_url, '7'), session, () => {});
  return { model, calls, emit: (notice: DesktopNativeNotice) => receive(notice), setForeign: () => { foreign = true; } };
}

test('selection is explicit, versioned and bound to the displayed native auth scope', async () => {
  const { model, calls } = fixture();
  await model.save(); assert.equal(calls.length, 0);
  await model.refresh(); model.toggle(capId); await model.save();
  assert.deepEqual(calls.find((c) => c.method === 'select-capabilities')?.params, {
    agent_session_id: session, expected_auth_scope: 'a'.repeat(64), capability_ids: [capId], expected_version: version,
  });
  assert.equal(model.state.catalog, null); // Re-read before another write.
  model.dispose();
});

test('approved delayed work requires an explicit click; stale/foreign catalog cannot arm it', async () => {
  const { model, calls, setForeign } = fixture();
  await model.refresh(); assert.equal(calls.some((c) => c.method === 'adopt-capability-approval'), false);
  await model.adopt(19);
  assert.deepEqual(calls.find((c) => c.method === 'adopt-capability-approval')?.params, {
    agent_session_id: session, approval_id: 19, expected_auth_scope: 'a'.repeat(64), expected_version: version,
  });
  setForeign(); await model.refresh(); await model.adopt(19);
  assert.equal(calls.filter((c) => c.method === 'adopt-capability-approval').length, 1);
  assert.equal(model.state.authScope, null);
  model.dispose();
});

test('confirmation defaults to no acknowledgement and consumes the visible request once', async () => {
  const { model, calls, emit } = fixture();
  const notice = { type: 'update' as const, value: { ...envelope, view: 'capabilities' as const,
    snapshot: { state: 'confirmation_required' as const, confirmation: { requestId: version,
      agentSessionId: session, server: 'local', tool: 'Shell', args: { command: 'echo fixture' },
      expiresAt: expires, argsSha256: 'd'.repeat(64) } } } };
  emit(notice); assert.equal(calls.length, 0);
  await Promise.all([model.confirm(true), model.confirm(true)]);
  assert.deepEqual(calls.filter((c) => c.method === 'confirm-capability').map((c) => c.params), [{ request_id: version, confirmed: true }]);
  emit({ ...notice, value: { ...notice.value, user_id: '8' } });
  assert.equal(model.state.connection, null);
  model.dispose(); assert.equal(calls.at(-1)?.method, 'disconnect-capabilities');
});

test('expired confirmation is sent as rejection and account reset clears all pending UI state', async () => {
  const { model, calls, emit } = fixture();
  emit({ type: 'update', value: { ...envelope, view: 'capabilities', snapshot: { state: 'confirmation_required',
    confirmation: { requestId: version, agentSessionId: session, server: 'local', tool: 'Shell', args: {},
      expiresAt: 1, argsSha256: 'd'.repeat(64) } } } });
  await model.confirm(true);
  assert.equal(calls.find((c) => c.method === 'confirm-capability')?.params.confirmed, false);
  await model.refresh(); emit({ type: 'cleared' });
  assert.equal(model.state.catalog, null); assert.equal(model.state.approvals.length, 0);
  model.dispose();
});
