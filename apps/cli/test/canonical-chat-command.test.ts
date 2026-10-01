import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  DexError,
  MemoryConfigStore,
  NativeDeviceKeyStore,
  defaultConfig,
} from '@dex/engine';
import type { SubmitAgentTurnInput, SubmittedAgentTurn } from '@dex/protocol/agent-session-mutation';
import { parseArgs } from '../src/args';
import {
  readCanonicalChatStdin,
  runCanonicalChatCommand,
  type CanonicalChatCommandDependencies,
} from '../src/canonical-chat-command';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000002';
const TURN = '018f1240-0000-7000-8000-000000000003';

function configs(origin = ORIGIN) {
  return new MemoryConfigStore({
    ...defaultConfig(),
    currentProfile: 'corp',
    profiles: { corp: { serverUrl: origin } },
  });
}

function argv(extra: string[] = []): string[] {
  return [
    'chat', '--canonical', '--user-id', '7', '--session-id', SESSION,
    '--expected-state-version', '3', '--idempotency-key', 'terminal-request-1',
    '--message', 'private prompt', ...extra,
  ];
}

test('invalid canonical arguments fail before config, credential, or network work', async () => {
  let reads = 0;
  let sessions = 0;
  let inputs = 0;
  const unreadable = {
    read: async () => { reads++; return defaultConfig(); },
    write: async () => undefined,
  };
  const dependency: CanonicalChatCommandDependencies = {
    sessionFactory: () => { sessions++; throw new Error('must not create'); },
    readInput: async () => { inputs++; return 'must not read'; },
  };
  const invalid = [
    ['chat', '--canonical=false', '--message', 'x'],
    ['chat', 'extra', '--canonical', '--message', 'x'],
    [...argv(), '--agent', 'legacy'],
    [...argv(), '--stdin'],
    argv().filter((value, index, values) => value !== '--message' && values[index - 1] !== '--message'),
    [...argv(), '--json=false'],
    argv().map((value) => value === '3' ? '03' : value),
    argv().map((value) => value === SESSION ? SESSION.toUpperCase() : value),
    argv().map((value) => value === 'terminal-request-1' ? 'bad key' : value),
    [
      'chat', '--canonical', '--user-id', '7', '--session-id', 'not-a-uuid',
      '--expected-state-version', '3', '--idempotency-key', 'request-1', '--stdin',
    ],
  ];
  for (const values of invalid) {
    await assert.rejects(runCanonicalChatCommand(parseArgs(values), unreadable, dependency), DexError);
  }
  assert.equal(reads, 0);
  assert.equal(sessions, 0);
  assert.equal(inputs, 0);
});

test('explicit repeats submit once per invocation with the same body and emit only safe acknowledgement metadata', async () => {
  const calls: Array<{ userId: string; sessionId: string; input: SubmitAgentTurnInput }> = [];
  const output: string[] = [];
  const sessionFactory: NonNullable<CanonicalChatCommandDependencies['sessionFactory']> = () => ({
    submitTurn: async (userId, sessionId, input): Promise<SubmittedAgentTurn> => {
      calls.push({ userId, sessionId, input });
      return {
        turn_id: TURN, status: calls.length === 1 ? 'accepted' : 'running',
        accepted_sequence: 10, state_version: 4, replayed: calls.length > 1,
        private_server_metadata: 'must not escape',
      } as SubmittedAgentTurn;
    },
  });
  const args = parseArgs([...argv(), '--json']);
  for (let index = 0; index < 2; index++) {
    await runCanonicalChatCommand(args, configs(), {
      sessionFactory,
      write: (value) => { output.push(value); },
    });
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], {
    userId: '7', sessionId: SESSION,
    input: {
      input_text: 'private prompt', expected_state_version: 3,
      idempotency_key: 'terminal-request-1',
    },
  });
  assert.equal(output.join('').includes('private prompt'), false);
  assert.equal(output.join('').includes('private_server_metadata'), false);
  const second = JSON.parse(output[1]!);
  assert.deepEqual(second, {
    mode: 'canonical', profile: 'corp', serverUrl: ORIGIN, user_id: '7',
    agent_session_id: SESSION, idempotency_key: 'terminal-request-1', expected_state_version: 3,
    result: { turn_id: TURN, status: 'running', accepted_sequence: 10, state_version: 4, replayed: true },
  });
});

test('an unknown submission outcome is not retried and exposes only explicit retry metadata', async () => {
  let calls = 0;
  await assert.rejects(
    runCanonicalChatCommand(parseArgs([...argv(), '--json']), configs(), {
      sessionFactory: () => ({
        submitTurn: async () => {
          calls++;
          throw new DexError('network_error', 'transport detail', {
            outcome: 'unknown', input_text: 'must not escape', extra: 'drop me',
          });
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DexError);
      assert.equal(error.code, 'network_error');
      assert.equal(error.message.includes('transport detail'), false);
      assert.deepEqual(error.details, {
        outcome: 'unknown', agent_session_id: SESSION,
        idempotency_key: 'terminal-request-1', expected_state_version: 3,
      });
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('missing OS credentials fail before fetch and never fall back to legacy auth', async () => {
  let requests = 0;
  const directory = await mkdtemp(join(tmpdir(), 'dex-canonical-chat-'));
  const keys = new NativeDeviceKeyStore({
    lockDirectory: directory,
    keychain: async () => ({
      getPassword: async () => null,
      setPassword: async () => assert.fail('must not create a key'),
      deletePassword: async () => false,
    }),
    env: {},
  });
  try {
    await assert.rejects(
      runCanonicalChatCommand(parseArgs(argv()), configs(), {
        keys,
        fetch: (async () => { requests++; return Response.json({}); }) as typeof fetch,
      }),
      (error: unknown) => error instanceof DexError && error.code === 'not_found',
    );
    assert.equal(requests, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stdin reader enforces byte and UTF-8 bounds and responds to cancellation', async () => {
  const exact = '\ufefffirst line\r\nsecond line\n\n';
  assert.equal(await readCanonicalChatStdin(undefined, Readable.from([Buffer.from(exact)])), exact);
  await assert.rejects(
    readCanonicalChatStdin(undefined, Readable.from([Buffer.alloc(262_145, 0x61)])),
    (error: unknown) => error instanceof DexError && error.code === 'usage_error',
  );
  await assert.rejects(
    readCanonicalChatStdin(undefined, Readable.from([Buffer.from([0xc3, 0x28])])),
    (error: unknown) => error instanceof DexError && error.code === 'usage_error',
  );
  const broken = new PassThrough();
  const failed = readCanonicalChatStdin(undefined, broken);
  broken.destroy(new Error('private stream detail'));
  await assert.rejects(failed, (error: unknown) => {
    assert.ok(error instanceof DexError);
    assert.equal(error.message, '표준 입력을 읽을 수 없습니다.');
    assert.equal(error.message.includes('private stream detail'), false);
    return true;
  });
  const controller = new AbortController();
  const stream = new PassThrough();
  const pending = readCanonicalChatStdin(controller.signal, stream);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
});
