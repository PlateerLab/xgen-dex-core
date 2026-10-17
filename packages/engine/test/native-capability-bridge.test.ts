import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  connectNativeCapabilityBridge,
  type NativeCapabilityOptions,
  type NativeCapabilitySnapshot,
} from '../src/native-capability-bridge';
import { NativeSocketUnavailable, type NativeAgentCapabilitySocket } from '../src/native-agent-socket';

const DEVICE = '018f1240-0000-7000-8000-000000000002';
const SID = '018f1240-0000-7000-8000-000000000003';
const CONNECTION = `conn_${'c'.repeat(32)}`;
const EPOCH = `epoch_${'e'.repeat(32)}`;
const CAPABILITY = `cap://device/${DEVICE}/mcp/local/Read`;
const NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF';

class FakeSocket implements NativeAgentCapabilitySocket {
  closed = false;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly frames: unknown[] = [];
  private waiting: { resolve(value: unknown): void; reject(error: unknown): void } | null = null;
  next(): Promise<unknown> {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.closed) return Promise.reject(new NativeSocketUnavailable());
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  async send(value: Readonly<Record<string, unknown>>): Promise<void> { this.sent.push({ ...value }); }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.waiting?.reject(new NativeSocketUnavailable()); this.waiting = null;
  }
  push(value: unknown): void {
    if (this.waiting) { const waiter = this.waiting; this.waiting = null; waiter.resolve(value); }
    else this.frames.push(value);
  }
}

const tool = { server: 'local', name: 'Read', description: 'Read',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } } } as const;

function ready(patch: Record<string, unknown> = {}) {
  return { type: 'ready', protocol: 'canonical-capabilities-v1', connection_id: CONNECTION, epoch: EPOCH,
    descriptors: [{ ...tool, risk: 'high', approval_mode: 'per_call', required_scope: ['tool.execute'],
      capability_id: CAPABILITY, device_id: DEVICE, platform_session_id: SID, connection_id: CONNECTION,
      epoch: EPOCH, descriptor_version: 1, descriptor_hash: 'a'.repeat(64) }],
    expires_at: Date.now() / 1000 + 60, ...patch };
}

function confirmation(args: Record<string, unknown> = { path: 'README.md' }, patch: Record<string, unknown> = {},
  canonical = JSON.stringify(args, Object.keys(args).sort())) {
  return { type: 'capability_confirm', request_id: randomUUID(), operation: 'mcp.call', args,
    args_canonical: canonical, expires_at: Date.now() / 1000 + 30, connection_id: CONNECTION, epoch: EPOCH, capability_id: CAPABILITY,
    args_sha256: createHash('sha256').update(canonical).digest('hex'), confirmation_nonce: NONCE, ...patch };
}

function call(confirm: ReturnType<typeof confirmation>, patch: Record<string, unknown> = {}) {
  return { type: 'mcp_call', request_id: confirm.request_id, server: 'local', tool: 'Read', operation: 'mcp.call',
    args: confirm.args, deadline_ms: 20_000, connection_id: CONNECTION, epoch: EPOCH, capability_id: CAPABILITY,
    args_canonical: confirm.args_canonical, args_sha256: confirm.args_sha256, confirmation_nonce: NONCE, ...patch };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() >= deadline) assert.fail('condition did not become true'); await new Promise((resolve) => setImmediate(resolve)); }
}

async function connected(overrides: Partial<NativeCapabilityOptions> = {}, guard = async () => {}, readyFrame = ready()) {
  const socket = new FakeSocket(); const snapshots: NativeCapabilitySnapshot[] = [];
  const calls: Array<{ server: string; tool: string; args: Readonly<Record<string, unknown>>; signal: AbortSignal }> = [];
  const options: NativeCapabilityOptions = { tools: [tool],
    call: async (server, name, args, signal) => { calls.push({ server, tool: name, args, signal }); return { content: [{ type: 'text', text: 'ok' }] }; },
    onChange: (snapshot) => snapshots.push(snapshot), ...overrides };
  socket.push(readyFrame);
  const controller = await connectNativeCapabilityBridge(socket, options,
    { accessExpiresAt: Date.now() / 1000 + 120, assertCurrent: guard });
  return { socket, snapshots, calls, controller };
}

test('publishes ready only after exact descriptor binding and a current generation check', async () => {
  let checks = 0; const f = await connected({}, async () => { checks++; });
  assert.equal(checks, 1);
  assert.deepEqual(f.socket.sent[0], { type: 'hello', descriptor_version: 1, tools: [tool] });
  assert.deepEqual(f.snapshots, [{ state: 'ready', confirmation: null }]);
  assert.deepEqual(f.controller.snapshot(), { state: 'ready', confirmation: null });
  assert.equal(JSON.stringify(f.controller.snapshot()).includes('nonce'), false);
  await f.controller.close();
  assert.deepEqual(f.snapshots.at(-1), { state: 'closed', confirmation: null });
});

test('a rejected ready frame never reaches the observer', async () => {
  const socket = new FakeSocket(); const snapshots: NativeCapabilitySnapshot[] = [];
  socket.push(ready({ protocol: 'legacy-capabilities' }));
  await assert.rejects(connectNativeCapabilityBridge(socket, { tools: [tool], call: async () => null,
    onChange: (snapshot) => snapshots.push(snapshot) },
  { accessExpiresAt: Date.now() / 1000 + 120, assertCurrent: async () => {} }));
  assert.deepEqual(snapshots, []); assert.equal(socket.closed, true);
});

test('requires explicit confirmation, then dispatches the one exactly matching call and sanitizes its result', async () => {
  let checks = 0; const f = await connected({}, async () => { checks++; });
  const confirm = confirmation(); f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
  const view = f.controller.snapshot().confirmation!;
  assert.deepEqual(view, { requestId: confirm.request_id, server: 'local', tool: 'Read', args: confirm.args,
    expiresAt: confirm.expires_at, argsSha256: confirm.args_sha256 });
  assert.equal(JSON.stringify(view).includes(NONCE), false);
  await f.controller.confirm(confirm.request_id, true);
  assert.equal(f.controller.snapshot().state, 'executing');
  f.socket.push(call(confirm));
  await waitFor(() => f.socket.sent.some((frame) => frame.type === 'mcp_result'));
  assert.equal(f.calls.length, 1); assert.equal(checks, 4);
  const result = f.socket.sent.find((frame) => frame.type === 'mcp_result')!;
  assert.equal(result.ok, true); assert.deepEqual(result.result, { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(f.controller.snapshot().state, 'ready');
  await f.controller.close();
});

test('forged arguments, unconfirmed calls and duplicate confirmations fail closed without dispatch', async () => {
  for (const mode of ['mutated', 'unconfirmed', 'duplicate'] as const) {
    const f = await connected(); const confirm = confirmation(); f.socket.push(confirm);
    await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
    if (mode !== 'unconfirmed') await f.controller.confirm(confirm.request_id, true);
    if (mode === 'duplicate') f.socket.push(confirm);
    else f.socket.push(call(confirm, mode === 'mutated' ? { args: { path: 'OTHER' } } : {}));
    await waitFor(() => f.controller.snapshot().state === 'failed');
    assert.equal(f.calls.length, 0, mode); assert.equal(f.socket.closed, true, mode);
  }
});

test('denial never dispatches and cancellation aborts an active local effect', async () => {
  const denied = await connected(); const no = confirmation(); denied.socket.push(no);
  await waitFor(() => denied.controller.snapshot().state === 'confirmation_required');
  await denied.controller.confirm(no.request_id, false);
  assert.equal(denied.controller.snapshot().state, 'ready'); assert.equal(denied.calls.length, 0);
  await denied.controller.close();

  let aborted = false;
  const running = await connected({ call: async (_server, _tool, _args, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const yes = confirmation(); running.socket.push(yes);
  await waitFor(() => running.controller.snapshot().state === 'confirmation_required');
  await running.controller.confirm(yes.request_id, true); running.socket.push(call(yes));
  await waitFor(() => running.controller.snapshot().state === 'executing');
  running.socket.push({ type: 'mcp_cancel', request_id: yes.request_id, reason: 'completed_or_stopped' });
  await waitFor(() => aborted && running.controller.snapshot().state === 'ready');
  assert.equal(running.socket.sent.some((frame) => frame.type === 'mcp_result'), false);
  await running.controller.close();
});

test('a stale generation blocks confirmation before any authority echo', async () => {
  let current = true;
  const f = await connected({}, async () => { if (!current) throw new Error('stale'); });
  const confirm = confirmation(); f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
  current = false;
  await assert.rejects(f.controller.confirm(confirm.request_id, true), /stale/);
  assert.equal(f.socket.sent.filter((frame) => frame.type === 'capability_confirmed').length, 0);
  assert.equal(f.controller.snapshot().state, 'failed');
});

test('uses backend canonical bytes for whole floats, fractions, negative zero and non-ASCII arguments', async () => {
  const f = await connected();
  const args = { whole_float: 1, fraction: 1.25, negative_zero: -0, small: 0.000001, text: '한글' };
  const canonical = '{"fraction":1.25,"negative_zero":-0.0,"small":1e-06,"text":"\\ud55c\\uae00","whole_float":1.0}';
  const confirm = confirmation(args, {}, canonical); f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
  await f.controller.confirm(confirm.request_id, true); f.socket.push(call(confirm));
  await waitFor(() => f.calls.length === 1 && f.controller.snapshot().state === 'ready');
  assert.deepEqual(f.calls[0]!.args, args);
  await f.controller.close();
});

test('preserves special JSON member names as inert own argument properties', async () => {
  const f = await connected();
  const args = JSON.parse('{"__proto__":"safe"}') as Record<string, unknown>;
  const confirm = confirmation(args, {}, '{"__proto__":"safe"}'); f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
  const exposed = f.controller.snapshot().confirmation!.args;
  assert.equal(Object.getPrototypeOf(exposed), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(exposed, '__proto__'), true);
  assert.equal(exposed.__proto__, 'safe');
  await f.controller.confirm(confirm.request_id, false); await f.controller.close();
});

test('rejects mutated, duplicate-member and noncanonical argument bytes', async () => {
  const bad = [
    confirmation({ n: 1 }, {}, '{"n":2.0}'),
    confirmation({ n: 0 }, {}, '{"n":-0.0}'),
    confirmation({ n: 1 }, {}, '{"n":1,"n":1}'),
    confirmation({ n: 1 }, {}, '{ "n":1}'),
    confirmation({ path: 7 }, {}, '{"path":7}'),
  ];
  for (const confirm of bad) {
    const f = await connected(); f.socket.push(confirm);
    await waitFor(() => f.controller.snapshot().state === 'failed');
    assert.equal(f.calls.length, 0);
  }
});

test('rejects canonical integers that cannot survive JavaScript JSON parsing exactly', async () => {
  const f = await connected();
  const rounded = JSON.parse('{"n":9007199254740993}') as Record<string, unknown>;
  const confirm = confirmation(rounded, {}, '{"n":9007199254740993}');
  f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'failed');
  assert.equal(f.snapshots.some((snapshot) => snapshot.state === 'confirmation_required'), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.socket.sent.some((frame) => frame.type === 'capability_confirmed'), false);
});

test('concurrent double confirmation emits at most one authority response', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  const f = await connected({}, async () => { if (++checks > 1) await gate; });
  const confirm = confirmation(); f.socket.push(confirm);
  await waitFor(() => f.controller.snapshot().state === 'confirmation_required');
  const first = f.controller.confirm(confirm.request_id, true);
  const second = f.controller.confirm(confirm.request_id, true);
  await assert.rejects(second);
  release(); await first;
  assert.equal(f.socket.sent.filter((frame) => frame.type === 'capability_confirmed').length, 1);
  await f.controller.close();
});

test('authority and unconfirmed request expiry never leave a usable ready or confirmation snapshot', async () => {
  const authority = await connected({}, async () => {}, ready({ expires_at: Date.now() / 1000 + 0.03 }));
  await waitFor(() => authority.controller.snapshot().state === 'failed');
  assert.equal(authority.socket.closed, true);

  const request = await connected();
  request.socket.push(confirmation({ path: 'README.md' }, { expires_at: Date.now() / 1000 + 0.03 }));
  await waitFor(() => request.controller.snapshot().state === 'confirmation_required');
  await waitFor(() => request.controller.snapshot().state === 'failed');
  assert.equal(request.calls.length, 0); assert.equal(request.socket.closed, true);
});
