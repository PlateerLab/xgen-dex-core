import { DexError, NativeAgentLiveWatcher, NativeCliSession, nativeKeyScope, type ConfigStore } from '@dex/engine';
import type { ParsedArgs } from './args';
import { flag, option, requiredOption } from './args';
import { isInteractiveTerminal, type TerminalModeInput } from './mode';
import type { CanonicalTuiAccount, CanonicalTuiSource } from './tui/canonical-types';
import { createCanonicalTuiChatSource } from './canonical-tui-chat-source';

export interface CanonicalTuiCommandDependencies {
  terminal: TerminalModeInput;
  launch?: (account: CanonicalTuiAccount, source: CanonicalTuiSource) => Promise<void>;
  sourceFactory?: (account: CanonicalTuiAccount) => CanonicalTuiSource;
}

/** Only the native host receives credentials and cursors; Ink receives the display projection. */
export function createCanonicalTuiSource(
  account: CanonicalTuiAccount,
  session = new NativeCliSession(account.origin),
): CanonicalTuiSource {
  return {
    read: (signal) => session.conversation(account.userId, signal),
    watch: (update, signal) => new NativeAgentLiveWatcher(session, account.userId).run(update, signal),
    settle: () => session.settleProofOperations(),
  };
}

/** Validate before loading Ink or initializing any legacy engine/auth/tool host. */
export async function runCanonicalTuiCommand(
  args: ParsedArgs,
  configs: ConfigStore,
  dependencies: CanonicalTuiCommandDependencies,
): Promise<void> {
  const allowed = new Set(['canonical', 'user-id', 'profile']);
  if (args.positionals.length !== 1 || args.positionals[0] !== 'ui'
    || !flag(args, 'canonical') || [...args.options.keys()].some((key) => !allowed.has(key))) {
    throw new DexError('usage_error', 'dex ui --canonical --user-id <id> [--profile <name>]을 사용하세요.');
  }
  const userId = requiredOption(args, 'user-id');
  if (!/^[1-9][0-9]{0,9}$/.test(userId) || Number(userId) > 2_147_483_647) {
    throw new DexError('usage_error', '--user-id는 유효한 계정 ID여야 합니다.');
  }
  if (!isInteractiveTerminal(dependencies.terminal)) {
    throw new DexError('usage_error', 'Canonical 터미널 UI는 대화형 TTY에서만 실행할 수 있습니다.');
  }
  if (args.options.has('profile') && !option(args, 'profile')) {
    throw new DexError('usage_error', '--profile 값이 필요합니다.');
  }
  const config = await configs.read();
  const profileName = option(args, 'profile') ?? config.currentProfile;
  const profile = config.profiles[profileName];
  if (!profile) throw new DexError('not_found', '먼저 HTTPS 서버 프로필을 설정하세요.');
  const origin = nativeKeyScope({ origin: profile.serverUrl, platform: 'cli', userId }).origin;
  const account = { profile: profileName, origin, userId };
  const source = (dependencies.sourceFactory ?? createCanonicalTuiChatSource)(account);
  const launch = dependencies.launch ?? (await import('./tui/canonical-chat-index')).runCanonicalChatTui;
  await launch(account, source);
}
