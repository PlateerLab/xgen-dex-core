import { DexError, NativeCliSession, nativeKeyScope, type ConfigStore, type NativeDeviceKeyStore } from '@dex/engine';
import { parseCreatedAgentSession, parseSwitchedAgentFocus, validateCreateAgentSession, validateSwitchAgentFocus } from '@dex/protocol/agent-session-lifecycle';
import { parseAgentFocus, parseAgentSessionList } from '@dex/protocol/agent-session';
import { stdout } from 'node:process';
import { flag, option, requiredOption, type ParsedArgs } from './args';

type LifecycleSession = Pick<NativeCliSession, 'focus' | 'agentSessions' | 'createAgentSession' | 'switchAgentFocus'>;
export interface CanonicalSessionCommandDependencies {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  write?: (value: string) => void;
  signal?: AbortSignal;
  sessionFactory?: (origin: string) => LifecycleSession;
}
export const canonicalSessionActions = ['agent-sessions', 'create-agent-session', 'switch-agent-focus'] as const;

function integer(args: ParsedArgs, name: string, required: boolean, min: number, max: number): number | undefined {
  const raw = required ? requiredOption(args, name) : option(args, name);
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
    throw new DexError('usage_error', '대화 버전·목록 개수는 허용 범위의 정수여야 합니다.');
  }
  return Number(raw);
}

/** Explicit account-focus CAS only. Unknown writes are never replayed or rebased automatically. */
export async function runCanonicalSessionCommand(args: ParsedArgs, configs: ConfigStore, dependencies: CanonicalSessionCommandDependencies = {}): Promise<void> {
  const action = args.positionals[1];
  const allowed = new Set(['profile', 'user-id', 'json', ...(action === 'agent-sessions' ? ['limit', 'before-id']
    : action === 'create-agent-session' ? ['workflow-id', 'title', 'expected-version'] : ['session-id', 'clear', 'expected-version'])]);
  if (!canonicalSessionActions.some((value) => value === action) || args.positionals.length !== 2
    || [...args.options.keys()].some((key) => !allowed.has(key))
    || ['clear', 'json'].some((key) => args.options.has(key) && !flag(args, key))) throw new DexError('usage_error', '지원하는 Canonical 대화 명령과 옵션을 사용하세요.');
  const userId = requiredOption(args, 'user-id');
  const limit = action === 'agent-sessions' ? integer(args, 'limit', false, 1, 100) : undefined;
  const beforeId = action === 'agent-sessions' ? option(args, 'before-id') : undefined;
  if (beforeId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(beforeId)) {
    throw new DexError('usage_error', '대화 목록 커서를 확인하세요.');
  }
  const expectedVersion = action === 'agent-sessions' ? undefined : integer(args, 'expected-version', true, 0, Number.MAX_SAFE_INTEGER - 1)!;
  let create: ReturnType<typeof validateCreateAgentSession> | undefined;
  let switchFocus: ReturnType<typeof validateSwitchAgentFocus> | undefined;
  try {
    if (action === 'create-agent-session') create = validateCreateAgentSession({ workflow_id: requiredOption(args, 'workflow-id'),
      expected_version: expectedVersion, ...(args.options.has('title') ? { title: option(args, 'title') } : {}) });
    if (action === 'switch-agent-focus') {
      if (flag(args, 'clear') === args.options.has('session-id')) throw new TypeError();
      switchFocus = validateSwitchAgentFocus({ active_agent_session_id: flag(args, 'clear') ? null : requiredOption(args, 'session-id'),
        expected_version: expectedVersion });
    }
  } catch { throw new DexError('usage_error', '대화 생성·전환 입력과 현재 계정 대화 버전을 확인하세요.'); }
  const config = await configs.read();
  const profile = option(args, 'profile') ?? config.currentProfile;
  const configured = config.profiles[profile];
  if (!configured) throw new DexError('not_found', '먼저 HTTPS 서버 프로필을 설정하세요.');
  const scope = nativeKeyScope({ origin: configured.serverUrl, platform: 'cli', userId });
  const session = dependencies.sessionFactory?.(scope.origin) ?? new NativeCliSession(scope.origin, dependencies.keys, dependencies.fetch);
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  const result = action === 'agent-sessions' ? { focus: parseAgentFocus(await session.focus(userId, signal)),
    sessions: parseAgentSessionList(await session.agentSessions(userId, limit, beforeId, signal)) }
    : create ? parseCreatedAgentSession(await session.createAgentSession(userId, create, signal), create)
      : parseSwitchedAgentFocus(await session.switchAgentFocus(userId, switchFocus!, signal), switchFocus!);
  const write = dependencies.write ?? ((value: string) => { stdout.write(value); });
  write(`${JSON.stringify(flag(args, 'json') ? { action, profile, serverUrl: scope.origin, storage: 'os-keychain-software', result } : result, null, 2)}\n`);
}
