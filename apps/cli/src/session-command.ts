import { DexError, NativeCliSession, NativeDeviceKeyStore, NativeAgentFocusWatcher, nativeKeyScope, type ConfigStore } from '@dex/engine';
import type { ParsedArgs } from './args';
import { flag, option, requiredOption } from './args';
import { promptSecret, readStdin } from './io';
import { stdin, stdout } from 'node:process';

export interface SessionCommandDependencies {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  readPassword?: () => Promise<string>;
  write?: (value: string) => void;
  signal?: AbortSignal;
}
export async function runSessionCommand(args: ParsedArgs, configs: ConfigStore, dependencies: SessionCommandDependencies = {}): Promise<void> {
  const action = args.positionals[1];
  const actions = ['login', 'status', 'refresh', 'focus', 'watch-focus', 'logout', 'forget-local'];
  const watching = action === 'watch-focus';
  const needsPassword = action === 'login' || action === 'logout';
  const allowed = new Set(['profile', ...(watching ? ['jsonl', 'interval-ms'] : ['json']), ...(action === 'login' ? ['email'] : ['user-id']),
    ...(needsPassword ? ['password-stdin'] : [])]);
  if (!actions.includes(action) || args.positionals.length !== 2 || [...args.options.keys()].some((key) => !allowed.has(key))) {
    throw new DexError('usage_error', 'dex session login|status|refresh|focus|watch-focus|logout|forget-local 명령과 지원하는 옵션을 사용하세요.');
  }
  const account = requiredOption(args, action === 'login' ? 'email' : 'user-id');
  const config = await configs.read();
  const profileName = option(args, 'profile') ?? config.currentProfile;
  const profile = config.profiles[profileName];
  if (!profile) throw new DexError('not_found', '먼저 HTTPS 서버 프로필을 설정하세요.');
  const scope = nativeKeyScope({ origin: profile.serverUrl, platform: 'cli', userId: action === 'login' ? '1' : account });
  const session = new NativeCliSession(scope.origin, dependencies.keys, dependencies.fetch);
  const write = dependencies.write ?? ((value) => { stdout.write(value); });
  if (watching) {
    const rawInterval = option(args, 'interval-ms');
    if (rawInterval !== undefined && !/^[0-9]+$/.test(rawInterval)) throw new DexError('usage_error', '--interval-ms는 200~60000 사이의 정수여야 합니다.');
    const watcher = new NativeAgentFocusWatcher(session, account, { intervalMs: rawInterval === undefined ? undefined : Number(rawInterval) });
    await watcher.run((update) => {
      if (flag(args, 'jsonl')) write(`${JSON.stringify({ action, profile: profileName, serverUrl: scope.origin, ...update })}\n`);
      else if (update.type === 'reset') write(`계정 ${update.user_id}의 현재 대화를 확인합니다.\n`);
      else if (update.type === 'focus') write(`현재 대화: ${update.focus.active_agent_session_id ?? '-'} (version ${update.focus.version}, ${update.source})\n`);
      else if (update.type === 'reconnecting') write(`연결을 복구합니다. 재시도는 1~30초 간격으로 진행합니다.\n`);
      else write(`포커스 구독 종료: ${update.reason}\n`);
    }, dependencies.signal);
    return;
  }
  const password = needsPassword ? await (dependencies.readPassword ?? (() => flag(args, 'password-stdin') || !stdin.isTTY ? readStdin() : promptSecret('Password: ')))() : '';
  const signal = dependencies.signal;
  const result = action === 'login' ? await session.login(account, password, signal)
    : action === 'status' ? await session.status(account, signal)
    : action === 'refresh' ? await session.refresh(account, signal)
    : action === 'focus' ? await session.focus(account, signal)
    : action === 'logout' ? await session.logout(account, password, signal) : await session.forgetLocal(account, signal);
  if (flag(args, 'json')) {
    write(`${JSON.stringify({ action, profile: profileName, serverUrl: scope.origin, storage: 'os-keychain-software',
      ...(action === 'forget-local' ? { server_revoked: false } : {}), result }, null, 2)}\n`);
  } else if ('state' in result) {
    write(`계정 ID: ${result.user_id}\nCLI Platform Session: ${result.session_id ?? '-'} (${result.state})\n`);
    if (action === 'forget-local') write('로컬 세션 자격증명만 지웠습니다. 서버 세션은 폐기하지 않았습니다. 내 페이지에서 서버 세션을 확인하세요.\n');
    else if (result.state === 'active') write('OS 키체인에서 access 자격증명을 사용할 수 있습니다. 서버의 현재 유효성은 인증된 요청에서 확인합니다.\n');
    else if (['login_pending', 'refreshing', 'logout_pending'].includes(result.state)) write('이전 작업의 완료 여부를 확인할 수 없습니다. 내 페이지에서 서버 세션을 폐기한 뒤 forget-local과 login을 진행하세요.\n');
  } else write(`${JSON.stringify(result, null, 2)}\n`);
}
