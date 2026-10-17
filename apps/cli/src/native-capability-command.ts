import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  DexError,
  LOCAL_SERVER,
  NativeCliSession,
  NativeDeviceKeyStore,
  getLocalToolProvider,
  nativeKeyScope,
  type ConfigStore,
  type LocalToolSchema,
  type NativeAgentSocketTransport,
  type NativeCapabilityCallContext,
  type NativeCapabilityConfirmation,
  type NativeCapabilityController,
  type NativeCapabilitySnapshot,
} from '@dex/engine';
import { validateSelectCapabilities } from '@dex/protocol/agent-capabilities';
import { flag, option, requiredOption, type ParsedArgs } from './args';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ARGUMENT_DISPLAY = 8_192;

type CapabilitySession = Pick<NativeCliSession, 'capabilityCatalog' | 'selectCapabilities' | 'capabilityApprovals'
  | 'adoptCapabilityApproval' | 'connectCapabilities'>;

export interface TrustedCliCapabilityTools {
  catalog(): readonly LocalToolSchema[];
  call(tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal,
    context: NativeCapabilityCallContext): Promise<unknown>;
}

export interface NativeCapabilityCommandDependencies {
  keys?: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  write?: (value: string) => void;
  signal?: AbortSignal;
  socket?: NativeAgentSocketTransport;
  capabilitySessionFactory?: (origin: string) => CapabilitySession;
  capabilityTools?: TrustedCliCapabilityTools;
  isTTY?: () => boolean;
  confirmCapability?: (confirmation: NativeCapabilityConfirmation, signal: AbortSignal) => Promise<boolean | undefined>;
  now?: () => number;
}

export const nativeCapabilityActions = ['capabilities', 'select-capabilities', 'capability-approvals',
  'adopt-capability-approval', 'connect-capabilities'] as const;

function usage(): never {
  throw new DexError('usage_error', '지원하는 기기 기능 명령과 명시적인 계정·프로필·대화·버전 옵션을 사용하세요.');
}

function expectedVersion(args: ParsedArgs, nullable: boolean): string | null {
  const value = requiredOption(args, 'expected-version');
  if (nullable && value === 'null') return null;
  if (!UUID.test(value)) usage();
  return value;
}

function authScope(args: ParsedArgs, required: boolean): string | undefined {
  const value = required ? requiredOption(args, 'auth-scope') : option(args, 'auth-scope');
  if (value !== undefined && !HEX64.test(value)) usage();
  return value;
}

function positiveInteger(args: ParsedArgs, name: string): number {
  const raw = requiredOption(args, name);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) usage();
  return Number(raw);
}

function capabilityIds(args: ParsedArgs): ReturnType<typeof validateSelectCapabilities>['capability_ids'] {
  let parsed: unknown;
  try { parsed = JSON.parse(requiredOption(args, 'capability-ids')); }
  catch { usage(); }
  try { return validateSelectCapabilities({ capability_ids: parsed, expected_version: null }).capability_ids; }
  catch { return usage(); }
}

function closedOptions(args: ParsedArgs, action: string): void {
  const allowed = new Set(['profile', 'user-id', ...(action === 'connect-capabilities' ? [] : ['session-id']),
    ...(action === 'capabilities' ? ['auth-scope', 'json']
      : action === 'select-capabilities' ? ['auth-scope', 'capability-ids', 'expected-version', 'json']
        : action === 'capability-approvals' ? ['auth-scope', 'json']
          : action === 'adopt-capability-approval' ? ['auth-scope', 'approval-id', 'expected-version', 'json'] : [])]);
  if (args.positionals.length !== 2 || [...args.options.keys()].some((key) => !allowed.has(key))
    || (args.options.has('json') && !flag(args, 'json'))) usage();
}

function selectionOutput(result: Awaited<ReturnType<CapabilitySession['selectCapabilities']>>) {
  return { version: result.version, selected_capability_ids: result.selected_capability_ids, expires_at: result.expires_at };
}

function adoptionOutput(result: Awaited<ReturnType<CapabilitySession['adoptCapabilityApproval']>>) {
  return { approval_id: result.approval_id, intent_version: result.intent_version,
    status: result.status, expires_at: result.expires_at };
}

function safeControlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function capabilityArgumentReview(args: Readonly<Record<string, unknown>>): { text: string; confirmable: boolean } {
  const text = safeControlText(JSON.stringify(args, null, 2));
  if ([...text].length <= MAX_ARGUMENT_DISPLAY) return { text, confirmable: true };
  return { text: `인수가 ${MAX_ARGUMENT_DISPLAY}자 표시 한도를 초과해 이 터미널에서 확인할 수 없습니다. 요청을 거부합니다.`,
    confirmable: false };
}

export function capabilityArgumentText(args: Readonly<Record<string, unknown>>): string {
  return capabilityArgumentReview(args).text;
}

async function terminalConfirmation(confirmation: NativeCapabilityConfirmation, signal: AbortSignal): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const review = capabilityArgumentReview(confirmation.args);
    stdout.write(`\n기기 기능 실행 요청\nAgent Session: ${confirmation.agentSessionId}\n`
      + `Server: ${safeControlText(confirmation.server)}\nTool: ${safeControlText(confirmation.tool)}\n`);
    stdout.write(`Arguments:\n${review.text}\nSHA-256: ${confirmation.argsSha256}\n`);
    if (!review.confirmable) return false;
    const answer = await rl.question('이 요청 한 번만 허용하시겠습니까? [y/N] ', { signal });
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } catch { return false; }
  finally { rl.close(); }
}

function defaultTools(): TrustedCliCapabilityTools {
  const provider = getLocalToolProvider();
  return { catalog: () => provider.catalog(), call: (tool, args, signal, context) => provider.callTool(tool, args,
    { interactionId: context.agentSessionId, remote: true, originName: 'XGEN Agent Session', signal }) };
}

function advertisedTools(port: TrustedCliCapabilityTools) {
  return port.catalog().map((tool) => {
    const schema = tool.inputSchema;
    if (!schema || schema.type !== 'object') throw new DexError('config_invalid', `로컬 도구 ${tool.name}의 입력 스키마가 올바르지 않습니다.`);
    return { server: LOCAL_SERVER, name: tool.name, ...(tool.description ? { description: Array.from(tool.description).slice(0, 1200).join('') } : {}), inputSchema: schema };
  });
}

async function connect(session: CapabilitySession, userId: string, dependencies: NativeCapabilityCommandDependencies,
  write: (value: string) => void): Promise<void> {
  const tty = dependencies.isTTY?.() ?? (stdin.isTTY === true && stdout.isTTY === true);
  if (!tty) throw new DexError('usage_error', '기기 기능 연결은 사용자가 매 요청을 확인할 수 있는 대화형 TTY에서만 실행할 수 있습니다.');
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  const tools = dependencies.capabilityTools ?? defaultTools();
  const confirm = dependencies.confirmCapability ?? terminalConfirmation;
  const now = dependencies.now ?? Date.now;
  let controller: NativeCapabilityController | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const buffered: NativeCapabilitySnapshot[] = [];
  const handled = new Set<string>();
  let decisions = Promise.resolve();
  let activePrompt: AbortController | undefined;

  const decide = async (confirmation: NativeCapabilityConfirmation): Promise<void> => {
    const remaining = confirmation.expiresAt * 1000 - now();
    if (remaining <= 0) { await controller?.close(); finish(); return; }
    const review = capabilityArgumentReview(confirmation.args);
    if (!review.confirmable) {
      write(`\n${safeControlText(confirmation.server)}.${safeControlText(confirmation.tool)} 요청: ${review.text}\nSHA-256: ${confirmation.argsSha256}\n`);
      if (controller?.snapshot().confirmation?.requestId === confirmation.requestId) {
        await controller.confirm(confirmation.requestId, false);
      }
      return;
    }
    const promptControl = new AbortController();
    activePrompt = promptControl;
    const cancelPrompt = () => promptControl.abort(signal?.reason);
    signal?.addEventListener('abort', cancelPrompt, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => { promptControl.abort(); resolve(false); }, Math.max(0, remaining - 25));
        timer.unref();
      });
      const approved = await Promise.race([confirm(confirmation, promptControl.signal).then((value) => value === true).catch(() => false), timeout]);
      promptControl.abort();
      if (!controller || controller.snapshot().confirmation?.requestId !== confirmation.requestId) return;
      if (now() >= confirmation.expiresAt * 1000) { await controller.close(); finish(); return; }
      await controller.confirm(confirmation.requestId, approved);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancelPrompt);
      if (activePrompt === promptControl) activePrompt = undefined;
    }
  };
  const observe = (snapshot: NativeCapabilitySnapshot): void => {
    if (!controller) { buffered.push(snapshot); return; }
    if (snapshot.state === 'closed' || snapshot.state === 'failed') { activePrompt?.abort(); finish(); return; }
    const confirmation = snapshot.confirmation;
    if (snapshot.state === 'confirmation_required' && confirmation && !handled.has(confirmation.requestId)) {
      handled.add(confirmation.requestId);
      decisions = decisions.then(() => decide(confirmation)).catch(() => { finish(); });
    }
  };
  const abort = (): void => { void controller?.close().finally(finish); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    controller = await session.connectCapabilities(userId, {
      tools: advertisedTools(tools),
      call: (server, tool, args, callSignal, context) => {
        if (server !== LOCAL_SERVER) throw new DexError('usage_error', '허용되지 않은 기기 기능 서버입니다.');
        return tools.call(tool, args, callSignal, context);
      },
      onChange: observe,
    }, signal);
    for (const snapshot of buffered.splice(0)) observe(snapshot);
    write('이 기기의 로컬 기능을 연결했습니다. 각 실행 요청은 이 터미널에서 별도로 확인해야 합니다.\n');
    if (signal?.aborted) abort();
    await finished;
  } finally {
    signal?.removeEventListener('abort', abort);
    activePrompt?.abort();
    await controller?.close().catch(() => undefined);
  }
}

/** Native capability reads and CAS writes. Writes are issued once and never rebased or retried. */
export async function runNativeCapabilityCommand(args: ParsedArgs, configs: ConfigStore,
  dependencies: NativeCapabilityCommandDependencies = {}): Promise<void> {
  const action = args.positionals[1];
  if (!nativeCapabilityActions.some((value) => value === action)) usage();
  closedOptions(args, action);
  const userId = requiredOption(args, 'user-id');
  const profileName = requiredOption(args, 'profile');
  const sessionId = action === 'connect-capabilities' ? undefined : requiredOption(args, 'session-id');
  if (sessionId !== undefined && !UUID.test(sessionId)) usage();
  const expectedScope = action === 'connect-capabilities' ? undefined : authScope(args, action !== 'capabilities');
  const selection = action === 'select-capabilities'
    ? validateSelectCapabilities({ capability_ids: capabilityIds(args), expected_version: expectedVersion(args, true) }) : undefined;
  const approvalId = action === 'adopt-capability-approval' ? positiveInteger(args, 'approval-id') : undefined;
  const adoptionVersion = action === 'adopt-capability-approval' ? expectedVersion(args, false)! : undefined;
  const config = await configs.read();
  const profile = config.profiles[profileName];
  if (!profile) throw new DexError('not_found', '지정한 HTTPS 서버 프로필을 찾을 수 없습니다.');
  const scope = nativeKeyScope({ origin: profile.serverUrl, platform: 'cli', userId });
  const session = dependencies.capabilitySessionFactory?.(scope.origin)
    ?? new NativeCliSession(scope.origin, dependencies.keys, dependencies.fetch, dependencies.socket);
  const write = dependencies.write ?? ((value: string) => { stdout.write(value); });
  if (action === 'connect-capabilities') return connect(session, userId, dependencies, write);
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  let result: unknown;
  if (action === 'capabilities') {
    const value = await session.capabilityCatalog(userId, sessionId!, signal, expectedScope);
    result = { capabilities: value.capabilities, version: value.version, selected_capability_ids: value.selected_capability_ids,
      expires_at: value.expires_at, auth_scope: value.authScope };
  } else if (action === 'select-capabilities') {
    result = selectionOutput(await session.selectCapabilities(userId, sessionId!, selection!, signal, expectedScope));
  } else if (action === 'capability-approvals') {
    const value = await session.capabilityApprovals(userId, sessionId!, signal, expectedScope);
    result = { approvals: value.approvals };
  } else {
    result = adoptionOutput(await session.adoptCapabilityApproval(userId, sessionId!, approvalId!, adoptionVersion!, signal, expectedScope));
  }
  const envelope = { action, profile: profileName, serverUrl: scope.origin, result };
  write(`${JSON.stringify(flag(args, 'json') ? envelope : result, null, 2)}\n`);
}
