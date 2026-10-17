import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DexError, MemoryConfigStore, defaultConfig, type NativeCapabilitySnapshot } from '@dex/engine';
import { parseArgs } from '../src/args';
import { capabilityArgumentText } from '../src/native-capability-command';
import { runSessionCommand } from '../src/session-command';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000002';
const VERSION = '018f1240-0000-7000-8000-000000000003';
const NEXT_VERSION = '018f1240-0000-7000-8000-000000000004';
const SCOPE = 'a'.repeat(64);
const CAPABILITY = 'cap://device/018f1240-0000-7000-8000-000000000001/mcp/local/ReadFile';

function configs() {
  return new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: ORIGIN } } });
}

function session(overrides: Record<string, unknown> = {}) {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected session call'); };
  return { capabilityCatalog: unexpected, selectCapabilities: unexpected, capabilityApprovals: unexpected,
    adoptCapabilityApproval: unexpected, connectCapabilities: unexpected, ...overrides } as never;
}

test('selection and approval adoption pass exact CAS and auth scope once', async () => {
  const calls: Array<{ name: string; values: unknown[] }> = [];
  const output: string[] = [];
  const fake = session({
    async selectCapabilities(...values: unknown[]) {
      calls.push({ name: 'select', values });
      return { version: NEXT_VERSION, selected_capability_ids: [CAPABILITY], expires_at: 2_000_000_000 };
    },
    async adoptCapabilityApproval(...values: unknown[]) {
      calls.push({ name: 'adopt', values });
      return { approval_id: 17, intent_version: NEXT_VERSION, status: 'armed', expires_at: 2_000_000_000 };
    },
  });
  const dependencies = { capabilitySessionFactory: () => fake, write: (value: string) => output.push(value) };
  await runSessionCommand(parseArgs(['session', 'select-capabilities', '--profile', 'corp', '--user-id', '7',
    '--session-id', SESSION, '--capability-ids', JSON.stringify([CAPABILITY]), '--expected-version', 'null',
    '--auth-scope', SCOPE, '--json']), configs(), dependencies);
  await runSessionCommand(parseArgs(['session', 'adopt-capability-approval', '--profile', 'corp', '--user-id', '7',
    '--session-id', SESSION, '--approval-id', '17', '--expected-version', VERSION, '--auth-scope', SCOPE,
    '--json']), configs(), dependencies);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'select');
  assert.deepEqual(calls[0].values.slice(0, 3), ['7', SESSION, { capability_ids: [CAPABILITY], expected_version: null }]);
  assert.equal(calls[0].values[4], SCOPE);
  assert.equal(calls[1].name, 'adopt');
  assert.deepEqual(calls[1].values.slice(0, 4), ['7', SESSION, 17, VERSION]);
  assert.equal(calls[1].values[5], SCOPE);
  assert.equal(JSON.parse(output[0]).result.version, NEXT_VERSION);
  assert.equal(JSON.parse(output[1]).result.status, 'armed');
});

test('unknown flags and malformed explicit values fail before a session is made', async () => {
  let sessions = 0;
  const dependencies = { capabilitySessionFactory: () => { sessions++; return session(); } };
  const invalid = [
    ['session', 'capabilities', '--profile', 'corp', '--user-id', '7', '--session-id', SESSION, '--token', 'private'],
    ['session', 'connect-capabilities', '--profile', 'corp', '--user-id', '7', '--yes=true'],
    ['session', 'select-capabilities', '--profile', 'corp', '--user-id', '7', '--session-id', SESSION,
      '--capability-ids', '[]', '--expected-version', '0', '--auth-scope', SCOPE],
    ['session', 'capability-approvals', '--profile', 'corp', '--user-id', '7', '--session-id', SESSION,
      '--auth-scope', 'short'],
  ];
  for (const argv of invalid) await assert.rejects(runSessionCommand(parseArgs(argv), configs(), dependencies), DexError);
  assert.equal(sessions, 0);
});

test('catalog output exposes the required scope but drops credential-shaped session extras', async () => {
  const output: string[] = [];
  await runSessionCommand(parseArgs(['session', 'capabilities', '--profile', 'corp', '--user-id', '7',
    '--session-id', SESSION, '--json']), configs(), {
    capabilitySessionFactory: () => session({
      async capabilityCatalog() {
        return { capabilities: [], version: null, selected_capability_ids: [], expires_at: null,
          authScope: SCOPE, accessToken: 'private-access', refresh_token: 'private-refresh' };
      },
    }),
    write: (value) => output.push(value),
  });
  const parsed = JSON.parse(output[0]);
  assert.equal(parsed.result.auth_scope, SCOPE);
  assert.equal(output[0].includes('private-access'), false);
  assert.equal(output[0].includes('private-refresh'), false);
  assert.deepEqual(Object.keys(parsed.result).sort(), ['auth_scope', 'capabilities', 'expires_at', 'selected_capability_ids', 'version']);
});

test('approval listing uses the explicit account, session and auth scope', async () => {
  let values: unknown[] = [];
  const output: string[] = [];
  await runSessionCommand(parseArgs(['session', 'capability-approvals', '--profile', 'corp', '--user-id', '7',
    '--session-id', SESSION, '--auth-scope', SCOPE, '--json']), configs(), {
    capabilitySessionFactory: () => session({
      async capabilityApprovals(...received: unknown[]) { values = received; return { approvals: [] }; },
    }),
    write: (value) => output.push(value),
  });
  assert.deepEqual(values.slice(0, 2), ['7', SESSION]);
  assert.equal(values[3], SCOPE);
  assert.deepEqual(JSON.parse(output[0]).result, { approvals: [] });
});

test('headless connect is rejected before opening a capability socket', async () => {
  let connects = 0;
  await assert.rejects(runSessionCommand(parseArgs(['session', 'connect-capabilities', '--profile', 'corp',
    '--user-id', '7']), configs(), {
    isTTY: () => false,
    capabilitySessionFactory: () => session({ connectCapabilities: async () => { connects++; throw new Error('socket'); } }),
  }), (error: unknown) => error instanceof DexError && error.code === 'usage_error');
  assert.equal(connects, 0);
});

test('dismissed confirmation is denied exactly once and pre-return ready is buffered', async () => {
  const confirmations: Array<{ id: string; allowed: boolean }> = [];
  let current: NativeCapabilitySnapshot = { state: 'ready', confirmation: null };
  let closes = 0;
  const controller = {
    snapshot: () => current,
    async confirm(id: string, allowed: boolean) {
      confirmations.push({ id, allowed });
      current = { state: 'closed', confirmation: null };
      change?.(current);
    },
    async close() { closes++; },
  };
  let change: ((snapshot: NativeCapabilitySnapshot) => void) | undefined;
  await runSessionCommand(parseArgs(['session', 'connect-capabilities', '--profile', 'corp', '--user-id', '7']), configs(), {
    isTTY: () => true,
    capabilityTools: { catalog: () => [{ name: 'ReadFile', inputSchema: { type: 'object' } }],
      call: async () => ({ content: [] }) },
    confirmCapability: async () => undefined,
    capabilitySessionFactory: () => session({
      async connectCapabilities(_userId: string, options: { onChange(snapshot: NativeCapabilitySnapshot): void }) {
        change = options.onChange;
        change(current);
        queueMicrotask(() => {
          current = { state: 'confirmation_required', confirmation: { requestId: 'request_1', server: 'local', tool: 'ReadFile',
            args: { path: '/tmp/file' }, expiresAt: Math.floor(Date.now() / 1000) + 60, argsSha256: 'b'.repeat(64) } };
          change?.(current);
          change?.(current);
        });
        return controller;
      },
    }),
    write: () => undefined,
  });
  assert.deepEqual(confirmations, [{ id: 'request_1', allowed: false }]);
  assert.equal(closes, 1);
});

test('approval that arrives after expiry is never confirmed and closes the connection', async () => {
  const base = Date.now();
  let clock = base;
  let confirms = 0;
  let current: NativeCapabilitySnapshot;
  let change: ((snapshot: NativeCapabilitySnapshot) => void) | undefined;
  const controller = {
    snapshot: () => current,
    async confirm() { confirms++; },
    async close() { current = { state: 'closed', confirmation: null }; change?.(current); },
  };
  current = { state: 'confirmation_required', confirmation: { requestId: 'request_late', server: 'local', tool: 'ReadFile',
    args: {}, expiresAt: Math.floor(base / 1000) + 30, argsSha256: 'c'.repeat(64) } };
  await runSessionCommand(parseArgs(['session', 'connect-capabilities', '--profile', 'corp', '--user-id', '7']), configs(), {
    isTTY: () => true,
    now: () => clock,
    capabilityTools: { catalog: () => [{ name: 'ReadFile', inputSchema: { type: 'object' } }], call: async () => null },
    confirmCapability: async () => { clock += 60_000; return true; },
    capabilitySessionFactory: () => session({
      async connectCapabilities(_userId: string, options: { onChange(snapshot: NativeCapabilitySnapshot): void }) {
        change = options.onChange; options.onChange(current); return controller;
      },
    }),
    write: () => undefined,
  });
  assert.equal(confirms, 0);
  assert.equal(current.state, 'closed');
});

test('over-bound arguments are denied without offering the approval callback', async () => {
  const decisions: boolean[] = [];
  let prompted = false;
  let current: NativeCapabilitySnapshot;
  let change: ((snapshot: NativeCapabilitySnapshot) => void) | undefined;
  const controller = {
    snapshot: () => current,
    async confirm(_id: string, allowed: boolean) {
      decisions.push(allowed); current = { state: 'closed', confirmation: null }; change?.(current);
    },
    async close() {},
  };
  current = { state: 'confirmation_required', confirmation: { requestId: 'request_large', server: 'local', tool: 'ReadFile',
    args: { value: 'x'.repeat(20_000) }, expiresAt: Math.floor(Date.now() / 1000) + 60, argsSha256: 'd'.repeat(64) } };
  await runSessionCommand(parseArgs(['session', 'connect-capabilities', '--profile', 'corp', '--user-id', '7']), configs(), {
    isTTY: () => true,
    capabilityTools: { catalog: () => [{ name: 'ReadFile', inputSchema: { type: 'object' } }], call: async () => null },
    confirmCapability: async () => { prompted = true; return true; },
    capabilitySessionFactory: () => session({
      async connectCapabilities(_userId: string, options: { onChange(snapshot: NativeCapabilitySnapshot): void }) {
        change = options.onChange; options.onChange(current); return controller;
      },
    }),
    write: () => undefined,
  });
  assert.equal(prompted, false);
  assert.deepEqual(decisions, [false]);
});

test('connection failure aborts an open prompt and drains without a confirmation', async () => {
  let promptAborted = false;
  let confirms = 0;
  let current: NativeCapabilitySnapshot = { state: 'confirmation_required', confirmation: {
    requestId: 'request_rotated', server: 'local', tool: 'ReadFile', args: {},
    expiresAt: Math.floor(Date.now() / 1000) + 60, argsSha256: 'e'.repeat(64),
  } };
  let change: ((snapshot: NativeCapabilitySnapshot) => void) | undefined;
  const controller = {
    snapshot: () => current,
    async confirm() { confirms++; },
    async close() {},
  };
  await runSessionCommand(parseArgs(['session', 'connect-capabilities', '--profile', 'corp', '--user-id', '7']), configs(), {
    isTTY: () => true,
    capabilityTools: { catalog: () => [{ name: 'ReadFile', inputSchema: { type: 'object' } }], call: async () => null },
    confirmCapability: (_confirmation, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { promptAborted = true; resolve(undefined); }, { once: true });
    }),
    capabilitySessionFactory: () => session({
      async connectCapabilities(_userId: string, options: { onChange(snapshot: NativeCapabilitySnapshot): void }) {
        change = options.onChange; options.onChange(current);
        setImmediate(() => { current = { state: 'failed', confirmation: null }; change?.(current); });
        return controller;
      },
    }),
    write: () => undefined,
  });
  assert.equal(promptAborted, true);
  assert.equal(confirms, 0);
});

test('displayed argument JSON renders terminal controls visibly and rejects over-bound display', () => {
  const escaped = capabilityArgumentText({ command: `printf '\u001b[31m'` });
  assert.equal(escaped.includes('\u001b'), false);
  assert.equal(escaped.includes('\\u001b'), true);
  const rendered = capabilityArgumentText({ command: `printf '\u001b[31m'`, huge: 'x'.repeat(20_000) });
  assert.equal(rendered.includes('\u001b'), false);
  assert.equal(rendered.includes('x'.repeat(100)), false);
  assert.equal(rendered.includes('확인할 수 없습니다'), true);
});
