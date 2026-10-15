import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DexError, MemoryConfigStore, defaultConfig } from '@dex/engine';
import type { AgentFocus, OwnedAgentSession } from '@dex/protocol/agent-session';
import type { CreatedAgentSession } from '@dex/protocol/agent-session-lifecycle';
import { parseArgs } from '../src/args';
import {
  runCanonicalSessionCommand,
  type CanonicalSessionCommandDependencies,
} from '../src/canonical-session-command';
import { runSessionCommand } from '../src/session-command';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const BEFORE = '018f1240-0000-7000-8000-000000000002';
const EVENT = '018f1240-0000-7000-8000-000000000003';
const FOCUS: AgentFocus = { active_agent_session_id: SESSION, version: 8, event_id: EVENT };
const CREATED: CreatedAgentSession = { id: SESSION, workflow_id: 'workflow-1', focus: FOCUS };
const ITEM: OwnedAgentSession = {
  id: SESSION, workflow_id: 'workflow-1', title: 'Owned', status: 'active',
  current_sequence: 2, state_version: 3,
};

function configs(origin = ORIGIN) {
  return new MemoryConfigStore({
    ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } },
  });
}

function dependencies(output: string[], calls: Array<Record<string, unknown>>): CanonicalSessionCommandDependencies {
  return {
    write: (value) => { output.push(value); },
    sessionFactory: (origin) => {
      calls.push({ method: 'factory', origin });
      return {
        focus: async (userId, signal) => {
          calls.push({ method: 'focus', userId, signal }); return FOCUS;
        },
        agentSessions: async (userId, limit, beforeId, signal) => {
          calls.push({ method: 'agentSessions', userId, limit, beforeId, signal });
          return { items: [ITEM], next_cursor: BEFORE, has_more: true };
        },
        createAgentSession: async (userId, input, signal) => {
          calls.push({ method: 'createAgentSession', userId, input, signal }); return CREATED;
        },
        switchAgentFocus: async (userId, input, signal) => {
          calls.push({ method: 'switchAgentFocus', userId, input, signal });
          return input.active_agent_session_id === null
            ? { active_agent_session_id: null, version: input.expected_version + 1, event_id: EVENT }
            : FOCUS;
        },
      };
    },
  };
}

test('catalog, create, select and clear pass explicit scoped arguments once', async () => {
  const output: string[] = []; const calls: Array<Record<string, unknown>> = [];
  const deps = dependencies(output, calls);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'agent-sessions', '--user-id', '7', '--limit', '17', '--before-id', BEFORE, '--json',
  ]), configs(), deps);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1',
    '--expected-version', '7', '--json',
  ]), configs(), deps);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'switch-agent-focus', '--user-id', '7', '--session-id', SESSION,
    '--expected-version', '8', '--json',
  ]), configs(), deps);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'switch-agent-focus', '--user-id', '7', '--clear',
    '--expected-version', '8', '--json',
  ]), configs(), deps);

  assert.deepEqual(calls.filter(({ method }) => method !== 'factory'), [
    { method: 'focus', userId: '7', signal: undefined },
    { method: 'agentSessions', userId: '7', limit: 17, beforeId: BEFORE, signal: undefined },
    { method: 'createAgentSession', userId: '7', input: {
      workflow_id: 'workflow-1', expected_version: 7, title: '',
    }, signal: undefined },
    { method: 'switchAgentFocus', userId: '7', input: {
      active_agent_session_id: SESSION, expected_version: 8,
    }, signal: undefined },
    { method: 'switchAgentFocus', userId: '7', input: {
      active_agent_session_id: null, expected_version: 8,
    }, signal: undefined },
  ]);
  assert.equal(calls.filter(({ method }) => method === 'factory').every(({ origin }) => origin === ORIGIN), true);
  const values = output.map((raw) => JSON.parse(raw));
  assert.deepEqual(values[0], {
    action: 'agent-sessions', profile: 'corp', serverUrl: ORIGIN, storage: 'os-keychain-software',
    result: { focus: FOCUS, sessions: { items: [ITEM], next_cursor: BEFORE, has_more: true } },
  });
  assert.deepEqual(values.slice(1).map(({ action, result }) => ({ action, result })), [
    { action: 'create-agent-session', result: CREATED },
    { action: 'switch-agent-focus', result: FOCUS },
    { action: 'switch-agent-focus', result: { active_agent_session_id: null, version: 9, event_id: EVENT } },
  ]);
});

test('runSessionCommand routes Canonical actions without changing the scoped dependency', async () => {
  const output: string[] = []; const calls: Array<Record<string, unknown>> = [];
  const deps = dependencies(output, calls);
  await runSessionCommand(parseArgs([
    'session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1',
    '--title', 'From CLI', '--expected-version', '7', '--json',
  ]), configs(), deps);
  assert.deepEqual(calls.at(-1), {
    method: 'createAgentSession', userId: '7',
    input: { workflow_id: 'workflow-1', expected_version: 7, title: 'From CLI' }, signal: undefined,
  });
  assert.equal(JSON.parse(output[0]!).result.id, SESSION);
});

test('invalid flags, versions, limits, cursors and clear selection fail before session work', async () => {
  let factories = 0; let writes = 0;
  const deps: CanonicalSessionCommandDependencies = {
    sessionFactory: () => { factories++; throw new Error('must not create'); },
    write: () => { writes++; },
  };
  const invalid = [
    ['session', 'agent-sessions', '--user-id', '7', '--limit', '0'],
    ['session', 'agent-sessions', '--user-id', '7', '--limit', '101'],
    ['session', 'agent-sessions', '--user-id', '7', '--limit', '01'],
    ['session', 'agent-sessions', '--user-id', '7', '--before-id', BEFORE.toUpperCase()],
    ['session', 'agent-sessions', '--user-id', '7', '--json=false'],
    ['session', 'agent-sessions', '--user-id', '7', '--password', 'private'],
    ['session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1'],
    ['session', 'create-agent-session', '--user-id', '7', '--workflow-id', '', '--expected-version', '0'],
    ['session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1', '--expected-version', '-1'],
    ['session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1', '--expected-version', '01'],
    ['session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1', '--expected-version', String(Number.MAX_SAFE_INTEGER)],
    ['session', 'switch-agent-focus', '--user-id', '7', '--expected-version', '8'],
    ['session', 'switch-agent-focus', '--user-id', '7', '--clear', '--session-id', SESSION, '--expected-version', '8'],
    ['session', 'switch-agent-focus', '--user-id', '7', '--clear=true', '--expected-version', '8'],
    ['session', 'switch-agent-focus', '--user-id', '7', '--session-id', SESSION.toUpperCase(), '--expected-version', '8'],
    ['session', 'switch-agent-focus', '--user-id', '7', '--session-id', SESSION, '--expected-version', '8', '--origin-id', 'hidden'],
  ];
  for (const argv of invalid) {
    await assert.rejects(runCanonicalSessionCommand(parseArgs(argv), configs(), deps),
      (error: unknown) => error instanceof DexError && error.code === 'usage_error', argv.join(' '));
  }
  assert.deepEqual([factories, writes], [0, 0]);
});

test('HTTPS origin and native user scope are checked before constructing a session', async () => {
  let factories = 0;
  const deps: CanonicalSessionCommandDependencies = {
    sessionFactory: () => { factories++; throw new Error('must not create'); },
  };
  for (const [origin, userId] of [['http://app.example.test', '7'], [ORIGIN, '0'], [ORIGIN, '2147483648']]) {
    await assert.rejects(runCanonicalSessionCommand(parseArgs([
      'session', 'agent-sessions', '--user-id', userId,
    ]), configs(origin), deps), (error: unknown) => error instanceof DexError && error.code === 'config_invalid');
  }
  assert.equal(factories, 0);
});

test('an unknown lifecycle result is invoked once and never emits a late success', async () => {
  let attempts = 0; const output: string[] = [];
  await assert.rejects(runCanonicalSessionCommand(parseArgs([
    'session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1',
    '--expected-version', '0', '--json',
  ]), configs(), {
    write: (value) => { output.push(value); },
    sessionFactory: () => ({
      focus: async () => FOCUS,
      agentSessions: async () => ({ items: [], next_cursor: null, has_more: false }),
      createAgentSession: async () => {
        attempts++;
        throw new DexError('network_error', '결과를 확인할 수 없습니다.', {
          outcome: 'unknown', operation: 'create_agent_session', expected_version: 0,
        });
      },
      switchAgentFocus: async () => FOCUS,
    }),
  }), (error: unknown) => error instanceof DexError && error.code === 'network_error'
    && (error.details as { outcome?: unknown } | undefined)?.outcome === 'unknown');
  assert.equal(attempts, 1);
  assert.deepEqual(output, []);
});

test('command output projects catalog and lifecycle receipts without extra session fields', async () => {
  const output: string[] = [];
  const deps: CanonicalSessionCommandDependencies = {
    write: (value) => { output.push(value); },
    sessionFactory: () => ({
      focus: async () => ({ ...FOCUS, private_server_field: 'private-server-secret' }),
      agentSessions: async () => ({ items: [{ ...ITEM, private_server_field: 'private-server-secret' }],
        next_cursor: null, has_more: false, private_server_field: 'private-server-secret' }),
      createAgentSession: async () => ({ ...CREATED, private_server_field: 'private-server-secret' }),
      switchAgentFocus: async () => ({ ...FOCUS, private_server_field: 'private-server-secret' }),
    }),
  };
  await runCanonicalSessionCommand(parseArgs([
    'session', 'agent-sessions', '--user-id', '7', '--json',
  ]), configs(), deps);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'create-agent-session', '--user-id', '7', '--workflow-id', 'workflow-1',
    '--expected-version', '7', '--json',
  ]), configs(), deps);
  await runCanonicalSessionCommand(parseArgs([
    'session', 'switch-agent-focus', '--user-id', '7', '--session-id', SESSION,
    '--expected-version', '8', '--json',
  ]), configs(), deps);
  assert.equal(output.join('').includes('private_server_field'), false);
  assert.equal(output.join('').includes('private-server-secret'), false);
});
