import {
  DexError,
  NativeCliSession,
  nativeKeyScope,
  type ConfigStore,
  type NativeDeviceKeyStore,
} from '@dex/engine';
import {
  validateSubmitAgentTurn,
  type SubmitAgentTurnInput,
  type SubmittedAgentTurn,
} from '@dex/protocol/agent-session-mutation';
import { stdin, stdout } from 'node:process';
import type { ParsedArgs } from './args';
import { flag, option, requiredOption } from './args';

const MAX_INPUT_BYTES = 262_144;

interface CanonicalTurnSession {
  submitTurn(
    userId: string,
    sessionId: string,
    input: SubmitAgentTurnInput,
    signal?: AbortSignal,
  ): Promise<SubmittedAgentTurn>;
}

export interface CanonicalChatCommandDependencies {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  readInput?: (signal?: AbortSignal) => Promise<string>;
  write?: (value: string) => void;
  signal?: AbortSignal;
  sessionFactory?: (
    origin: string,
    keys?: NativeDeviceKeyStore,
    fetchImpl?: typeof fetch,
  ) => CanonicalTurnSession;
}

function abortError(): Error {
  return Object.assign(new Error('입력이 취소되었습니다.'), { name: 'AbortError' });
}

/** Read one UTF-8 message without allowing an unbounded stdin allocation. */
export async function readCanonicalChatStdin(
  signal?: AbortSignal,
  input: NodeJS.ReadableStream = stdin,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const pause = () => {
      if ('pause' in input && typeof input.pause === 'function') input.pause();
    };
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      pause();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_INPUT_BYTES) {
        fail(new DexError('usage_error', `메시지는 UTF-8 ${MAX_INPUT_BYTES}바이트 이하여야 합니다.`));
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        resolve(value);
      } catch {
        reject(new DexError('usage_error', '메시지는 올바른 UTF-8이어야 합니다.'));
      }
    };
    const onError = () => fail(new DexError('usage_error', '표준 입력을 읽을 수 없습니다.'));
    const onAbort = () => fail(abortError());
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function decimalVersion(args: ParsedArgs): number {
  const raw = requiredOption(args, 'expected-state-version');
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DexError('usage_error', '--expected-state-version은 1 이상의 정규 십진수여야 합니다.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new DexError('usage_error', '--expected-state-version은 안전한 정수 범위여야 합니다.');
  }
  return value;
}

function validateUserId(value: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new DexError('usage_error', '--user-id는 유효한 계정 ID여야 합니다.');
  }
  return value;
}

function unknownOutcome(
  error: unknown,
  metadata: { agent_session_id: string; idempotency_key: string; expected_state_version: number },
): never {
  if (error instanceof DexError && error.code === 'network_error'
    && (error.details as { outcome?: unknown } | undefined)?.outcome === 'unknown') {
    throw new DexError(
      'network_error',
      '턴 제출 결과를 확인할 수 없습니다. 같은 메시지와 idempotency key로 명시적으로 다시 실행하세요.',
      { outcome: 'unknown', ...metadata },
    );
  }
  throw error;
}

/** Explicit one-shot Canonical submission. Completion is observed through session watchers. */
export async function runCanonicalChatCommand(
  args: ParsedArgs,
  configs: ConfigStore,
  dependencies: CanonicalChatCommandDependencies = {},
): Promise<void> {
  const allowed = new Set([
    'canonical', 'user-id', 'session-id', 'expected-state-version', 'idempotency-key',
    'profile', 'message', 'stdin', 'json',
  ]);
  if (args.positionals.length !== 1 || args.positionals[0] !== 'chat'
    || !flag(args, 'canonical') || [...args.options.keys()].some((key) => !allowed.has(key))) {
    throw new DexError('usage_error', 'Canonical 채팅 명령과 지원하는 옵션을 사용하세요.');
  }
  for (const name of ['stdin', 'json']) {
    if (args.options.has(name) && !flag(args, name)) {
      throw new DexError('usage_error', `--${name}은 값을 받지 않는 플래그입니다.`);
    }
  }
  const message = option(args, 'message');
  const fromStdin = flag(args, 'stdin');
  if ((message === undefined) === !fromStdin) {
    throw new DexError('usage_error', '--message 또는 --stdin 중 하나만 사용하세요.');
  }

  const userId = validateUserId(requiredOption(args, 'user-id'));
  const agentSessionId = requiredOption(args, 'session-id');
  const idempotencyKey = requiredOption(args, 'idempotency-key');
  const expectedStateVersion = decimalVersion(args);
  // Check all metadata before a --stdin invocation can block or consume input.
  try {
    validateSubmitAgentTurn(agentSessionId, {
      input_text: 'x',
      expected_state_version: expectedStateVersion,
      idempotency_key: idempotencyKey,
    });
  } catch {
    throw new DexError(
      'usage_error',
      'Canonical session ID, state version 또는 idempotency key 형식이 올바르지 않습니다.',
    );
  }
  const inputText = message ?? await (dependencies.readInput ?? readCanonicalChatStdin)(dependencies.signal);
  let input: SubmitAgentTurnInput;
  try {
    input = validateSubmitAgentTurn(agentSessionId, {
      input_text: inputText,
      expected_state_version: expectedStateVersion,
      idempotency_key: idempotencyKey,
    });
  } catch {
    throw new DexError(
      'usage_error',
      'Canonical session ID, 메시지, state version 또는 idempotency key 형식이 올바르지 않습니다.',
    );
  }

  const config = await configs.read();
  const profileName = option(args, 'profile') ?? config.currentProfile;
  const profile = config.profiles[profileName];
  if (!profile) throw new DexError('not_found', '먼저 HTTPS 서버 프로필을 설정하세요.');
  const origin = nativeKeyScope({ origin: profile.serverUrl, platform: 'cli', userId }).origin;
  const factory = dependencies.sessionFactory
    ?? ((origin, keys, fetchImpl) => new NativeCliSession(origin, keys, fetchImpl));
  const session = factory(origin, dependencies.keys, dependencies.fetch);
  const metadata = {
    agent_session_id: agentSessionId,
    idempotency_key: idempotencyKey,
    expected_state_version: expectedStateVersion,
  };
  let result: SubmittedAgentTurn;
  try {
    result = await session.submitTurn(userId, agentSessionId, input, dependencies.signal);
  } catch (error) {
    unknownOutcome(error, metadata);
  }
  const safeResult: SubmittedAgentTurn = {
    turn_id: result.turn_id,
    status: result.status,
    accepted_sequence: result.accepted_sequence,
    state_version: result.state_version,
    replayed: result.replayed,
  };

  const output = dependencies.write ?? ((value: string) => { stdout.write(value); });
  const envelope = {
    mode: 'canonical', profile: profileName, serverUrl: origin,
    user_id: userId, ...metadata, result: safeResult,
  };
  if (flag(args, 'json')) {
    output(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  output(`${safeResult.replayed ? '기존 Canonical 턴을 확인했습니다.' : 'Canonical 턴 제출을 수락했습니다.'}\n`);
  output(`Agent Session: ${agentSessionId}\n`);
  output(`Idempotency key: ${idempotencyKey}\n`);
  output(`요청 state version: ${expectedStateVersion}\n`);
  output(`Turn: ${safeResult.turn_id}\n`);
  output(`상태: ${safeResult.status}${safeResult.replayed ? ' (replayed)' : ''}\n`);
  output(`수락 sequence: ${safeResult.accepted_sequence}\n`);
  output(`상태 version: ${safeResult.state_version}\n`);
  output(`결과 확인: dex session watch-live --user-id ${userId} --profile ${profileName}\n`);
}
