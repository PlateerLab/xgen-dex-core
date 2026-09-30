import { DexError, NativeDeviceKeyStore, nativeDeviceEnrollment, nativeKeyScope,
  type ConfigStore, type NativeEnrollmentAction } from '@dex/engine';
import type { ParsedArgs } from './args';
import { flag, option, requiredOption } from './args';
import { promptSecret, readStdin } from './io';
import { stdin, stdout } from 'node:process';

export interface DeviceCommandDependencies {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  readPassword?: () => Promise<string>;
  write?: (value: string) => void;
  signal?: AbortSignal;
}
/** Explicit enrollment commands. They do not change the legacy CLI/TUI login or tool bridge. */
export async function runDeviceCommand(args: ParsedArgs, configs: ConfigStore, dependencies: DeviceCommandDependencies = {}): Promise<void> {
  const action = args.positionals[1];
  const allowed = new Set(['email', 'profile', 'json', 'password-stdin',
    ...(action === 'register' ? ['name'] : []), ...(action === 'request-approval' ? ['approver'] : [])]);
  if (!['register', 'status', 'approvers', 'request-approval'].includes(action) || args.positionals.length !== 2
    || [...args.options.keys()].some((key) => !allowed.has(key))) {
    throw new DexError('usage_error', 'dex device register|status|approvers|request-approval 명령과 지원하는 옵션을 사용하세요.');
  }
  const email = requiredOption(args, 'email');
  const name = option(args, 'name');
  if (name !== undefined && (!name.trim() || [...name.trim()].length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name))) {
    throw new DexError('usage_error', '기기 이름은 제어 문자 없이 1~80자로 입력하세요.');
  }
  let operation: NativeEnrollmentAction;
  if (action === 'request-approval') {
    const approver = requiredOption(args, 'approver');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approver)) {
      throw new DexError('usage_error', '승인 브라우저의 기기 ID가 필요합니다.');
    }
    operation = { action, approverDeviceId: approver.toLowerCase() };
  } else if (action === 'register') operation = { action, deviceName: name };
  else operation = { action: action as 'status' | 'approvers' };
  const config = await configs.read();
  const profileName = option(args, 'profile') ?? config.currentProfile;
  const profile = config.profiles[profileName];
  if (!profile) throw new DexError('not_found', '먼저 HTTPS 서버 프로필을 설정하세요.');
  const origin = nativeKeyScope({ origin: profile.serverUrl, platform: 'cli', userId: '1' }).origin;
  const password = await (dependencies.readPassword ?? (() => flag(args, 'password-stdin') || !stdin.isTTY ? readStdin() : promptSecret('Password: ')))();
  const result = await nativeDeviceEnrollment({ origin, email, password, operation,
    keys: dependencies.keys ?? new NativeDeviceKeyStore(), fetch: dependencies.fetch, signal: dependencies.signal });
  const write = dependencies.write ?? ((value) => { stdout.write(value); });
  if (flag(args, 'json')) {
    write(`${JSON.stringify({ action, profile: profileName, serverUrl: origin, storage: 'os-keychain-software', result }, null, 2)}\n`);
  } else if (action === 'approvers' && result && 'trusted_devices' in result) {
    const browsers = result.trusted_devices.filter((device) => device.platform === 'web');
    if (!browsers.length) write('승인 가능한 브라우저가 없습니다. 먼저 PC 브라우저를 등록하거나 관리자 복구를 진행하세요.\n');
    for (const device of browsers) write(`${device.device_id}  ${device.device_name ?? '브라우저'}${device.is_default_approver ? ' (기본 승인 기기)' : ''}\n`);
    if (result.more_trusted_devices) write('전체 신뢰 기기 목록은 내 페이지에서 확인하세요.\n');
  } else if (result && 'confirmation_code' in result) {
    write(`승인 요청: ${result.request_id}\n승인 브라우저: ${result.approver_device_id}\n비교 코드: ${result.confirmation_code}\n`);
    write('선택한 브라우저의 내 페이지 → 세션에서 비교 코드를 확인하고 승인하세요.\n');
  } else if (result && 'device_id' in result) {
    write(`CLI 기기: ${result.device_id} (${result.state})\n`);
    if (result.state === 'pending') write('dex device approvers로 승인 브라우저를 확인하고 request-approval을 실행하세요.\n');
  } else write('서버에 등록된 CLI 기기가 없습니다. dex device register를 실행하세요.\n');
}
