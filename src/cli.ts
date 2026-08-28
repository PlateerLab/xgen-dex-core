#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';
import { parseArgs, flag, option, positiveIntegerOption, requiredOption } from './args';
import { FileConfigStore } from './config-store';
import { KeytarCredentialStore } from './credential-store';
import { DexEngine } from './engine';
import { DexError, publicError } from './errors';
import { promptLine, promptSecret, readStdin } from './io';
import { isInteractiveTerminal, shouldLaunchTui } from './mode';
import { DexRpcServer } from './rpc-server';
import { localToolSchemas } from './local-tools';
import type { LocalToolsStatus } from './engine';
import type { Agent, AgentListQuery, ChatEvent, Conversation, HistoryTurn } from './types';

const VERSION = '0.1.0';

const HELP = `XGEN Dex CLI ${VERSION}

Usage:
  dex                     대화형 터미널 UI
  dex ui                  대화형 터미널 UI
  dex profile set [name] --server <url>
  dex profile use <name>
  dex profile list [--json]
  dex login --email <email> [--profile <name>] [--password-stdin]
  dex status [--profile <name>] [--json]
  dex logout [--profile <name>]
  dex agents list [--search <text>] [--owner personal|shared] [--json]
  dex chat --agent <workflow-id> [--name <workflow-name>] [--interaction <id>] [--jsonl]
  dex history list [--json]
  dex history turns --workflow <id> --interaction <id> [--json]
  dex tools list [--json]
  dex tools status [--profile <name>] [--json]
  dex tools enable [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--allow-dangerous]
  dex tools configure [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--timeout <ms>]
                      [--allow-dangerous|--no-allow-dangerous]
  dex tools disable
  dex tools run <Shell|ReadFile|WriteFile|ListDir|Search|Open> [--args <json>] [--json]
  dex tools serve [--profile <name>]   로컬 도구 브리지만 계속 실행
  dex tool ...                         dex tools ...의 단수형 별칭
  dex serve --stdio

Global options:
  --profile <name>  사용할 서버 프로필
  --json            단일 JSON 결과
  --jsonl           채팅 이벤트를 NDJSON으로 출력
  -h, --help        도움말
  -v, --version     버전

Examples:
  dex profile set corp --server https://xgen.example.com
  dex login --email me@corp.com
  dex agents list
  dex tools enable --cwd . --allow . --block sudo
  echo '이 저장소를 설명해줘' | dex chat --agent wf_abc
`;

function writeJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cell(value: unknown, width: number): string {
  const text = String(value ?? '');
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function printAgents(agents: Agent[]): void {
  if (agents.length === 0) {
    stdout.write('Agent가 없습니다.\n');
    return;
  }
  stdout.write(`${cell('WORKFLOW ID', 28)}  ${cell('NAME', 30)}  OWNER\n`);
  for (const agent of agents) {
    stdout.write(
      `${cell(agent.workflowId, 28)}  ${cell(agent.workflowName, 30)}  ${agent.isShared ? 'shared' : 'personal'}\n`,
    );
  }
}

function printConversations(items: Conversation[]): void {
  if (items.length === 0) {
    stdout.write('대화 기록이 없습니다.\n');
    return;
  }
  stdout.write(`${cell('INTERACTION ID', 38)}  ${cell('AGENT', 28)}  UPDATED\n`);
  for (const item of items) {
    stdout.write(`${cell(item.interactionId, 38)}  ${cell(item.workflowName, 28)}  ${item.updatedAt}\n`);
  }
}

function printTurns(items: HistoryTurn[]): void {
  for (const item of items) {
    stdout.write(`\n[You]\n${item.input}\n\n[${item.workflowName}]\n${item.output}\n`);
  }
  if (items.length === 0) stdout.write('대화 turn이 없습니다.\n');
}

function describeEvent(event: ChatEvent): string | null {
  if (event.kind === 'status') return `${event.surface}: ${event.detail ?? event.reason ?? '상태 변경'}`;
  if (event.kind === 'tool') return `tool: ${event.event.toolName ?? event.event.eventType}`;
  if (event.kind === 'node_status') return `node: ${event.event.nodeId} ${event.event.status}`;
  if (event.kind === 'quota') return `quota: ${event.level}`;
  if (event.kind === 'error') return `error: ${event.detail}`;
  return null;
}

function printLocalToolsStatus(status: LocalToolsStatus): void {
  stdout.write(`로컬 도구: ${status.config.enabled ? '켜짐' : '꺼짐'}\n`);
  stdout.write(`작업 폴더: ${status.config.cwd || '(미설정)'}\n`);
  stdout.write(`허용 경로: ${status.config.allowedRoots.join(', ') || '(작업 폴더)'}\n`);
  stdout.write(`위험 명령: ${status.config.allowDangerous ? '허용' : '차단'}\n`);
  stdout.write(
    `브리지: ${status.bridge.catalogSynced ? `연결됨 (${status.bridge.serverTools} tools)` : status.bridge.connected ? '카탈로그 동기화 중' : status.bridge.running ? '연결 대기 중' : '중지됨'}\n`,
  );
  if (status.bridge.error) stdout.write(`오류: ${status.bridge.error}\n`);
}

function csvOption(args: ReturnType<typeof parseArgs>, name: string): string[] | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function jsonObjectOption(args: ReturnType<typeof parseArgs>, name: string): Record<string, unknown> {
  const value = option(args, name);
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DexError('usage_error', `--${name}은 JSON 객체여야 합니다.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DexError('usage_error', `--${name}은 JSON 객체여야 합니다.`);
  }
  return parsed as Record<string, unknown>;
}

async function waitForStopSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function exitCode(error: unknown): number {
  if (!(error instanceof DexError)) return 1;
  if (error.code === 'usage_error' || error.code === 'config_invalid') return 2;
  if (error.code === 'auth_required' || error.code === 'auth_invalid') return 3;
  if (error.code === 'network_error') return 4;
  return 1;
}

async function runChat(engine: DexEngine, args: ReturnType<typeof parseArgs>): Promise<void> {
  const workflowId = requiredOption(args, 'agent');
  const input = flag(args, 'stdin') || !stdin.isTTY ? await readStdin() : await promptLine('Message: ');
  if (!input.trim()) throw new DexError('usage_error', '보낼 메시지가 비어 있습니다.');
  const resolved = await engine.resolveChatInput({
    profile: option(args, 'profile'),
    workflowId,
    workflowName: option(args, 'name'),
    interactionId: option(args, 'interaction'),
    input,
  });
  const jsonl = flag(args, 'jsonl');
  if (jsonl) writeJson({ kind: 'start', ...resolved, input: undefined });
  else stderr.write(`interaction: ${resolved.interactionId}\n`);

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    for await (const event of engine.chat(resolved, controller.signal)) {
      if (jsonl) {
        stdout.write(`${JSON.stringify(event)}\n`);
      } else if (event.kind === 'text') {
        stdout.write(event.content);
      } else if (event.kind === 'summary') {
        stdout.write(event.text);
      } else {
        const description = describeEvent(event);
        if (description) stderr.write(`[${description}]\n`);
      }
    }
    if (!jsonl) stdout.write('\n');
  } finally {
    process.off('SIGINT', onInterrupt);
    engine.stopLocalTools();
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (flag(args, 'version')) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (flag(args, 'help')) {
    stdout.write(HELP);
    return;
  }

  const engine = new DexEngine(new FileConfigStore(), new KeytarCredentialStore());
  const terminal = {
    stdinIsTty: !!stdin.isTTY,
    stdoutIsTty: !!stdout.isTTY,
    term: process.env.TERM,
    ci: process.env.CI,
  };
  if (shouldLaunchTui(args.positionals, terminal)) {
    const { runTui } = await import('./tui/index');
    try {
      await runTui(engine);
    } finally {
      engine.stopLocalTools();
    }
    return;
  }
  if (args.positionals.length === 0) {
    stdout.write(HELP);
    return;
  }
  if (args.positionals[0] === 'ui' && !isInteractiveTerminal(terminal)) {
    throw new DexError('usage_error', '터미널 UI는 대화형 TTY에서만 실행할 수 있습니다.');
  }
  const [rawCommand, action] = args.positionals;
  const command = rawCommand === 'tool' ? 'tools' : rawCommand;
  const asJson = flag(args, 'json');

  if (command === 'profile' && action === 'set') {
    const profile = await engine.setProfile(args.positionals[2] ?? 'default', requiredOption(args, 'server'));
    if (asJson) writeJson(profile);
    else stdout.write(`프로필 저장: ${profile.name} → ${profile.serverUrl}\n`);
    return;
  }
  if (command === 'profile' && action === 'use') {
    const name = args.positionals[2];
    if (!name) throw new DexError('usage_error', '사용할 프로필 이름이 필요합니다.');
    const profile = await engine.useProfile(name);
    if (asJson) writeJson(profile);
    else stdout.write(`현재 프로필: ${profile.name}\n`);
    return;
  }
  if (command === 'profile' && action === 'list') {
    const profiles = await engine.listProfiles();
    if (asJson) writeJson(profiles);
    else if (profiles.length === 0) stdout.write('프로필이 없습니다.\n');
    else {
      for (const profile of profiles) {
        stdout.write(`${profile.current ? '*' : ' '} ${profile.name.padEnd(16)} ${profile.serverUrl}\n`);
      }
    }
    return;
  }
  if (command === 'login') {
    const password =
      flag(args, 'password-stdin') || !stdin.isTTY ? await readStdin() : await promptSecret('Password: ');
    const status = await engine.login(requiredOption(args, 'email'), password, option(args, 'profile'));
    if (asJson) writeJson(status);
    else stdout.write(`로그인됨: ${status.user?.username ?? 'unknown'} (${status.profile})\n`);
    return;
  }
  if (command === 'status') {
    const status = await engine.authStatus(option(args, 'profile'));
    if (asJson) writeJson(status);
    else if (status.authenticated) {
      stdout.write(`로그인됨: ${status.user?.username ?? 'unknown'} @ ${status.serverUrl}\n`);
    } else {
      stdout.write(`로그아웃됨: ${status.profile} (${status.reason ?? 'unknown'})\n`);
    }
    return;
  }
  if (command === 'logout') {
    await engine.logout(option(args, 'profile'));
    if (asJson) writeJson({ ok: true });
    else stdout.write('로그아웃했습니다.\n');
    return;
  }
  if (command === 'tools' && action === 'list') {
    const tools = localToolSchemas();
    if (asJson) writeJson(tools);
    else {
      stdout.write(`${cell('TOOL', 14)}  DESCRIPTION\n`);
      for (const tool of tools) stdout.write(`${cell(tool.name, 14)}  ${tool.description}\n`);
    }
    return;
  }
  if (command === 'tools' && (action === 'enable' || action === 'configure')) {
    const current = (await engine.localToolsStatus()).config;
    const cwd = option(args, 'cwd') || current.cwd || process.cwd();
    const timeoutRaw = option(args, 'timeout');
    const timeoutMs = timeoutRaw === undefined ? current.timeoutMs : Number(timeoutRaw);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      throw new DexError('usage_error', '--timeout은 1000~3600000 사이의 밀리초여야 합니다.');
    }
    const allowedRoots = csvOption(args, 'allow') ?? (current.allowedRoots.length ? current.allowedRoots : [cwd]);
    const blockedCommands = csvOption(args, 'block') ?? current.blockedCommands;
    const allowDangerous = flag(args, 'allow-dangerous')
      ? true
      : flag(args, 'no-allow-dangerous')
        ? false
        : current.allowDangerous;
    const status = await engine.configureLocalTools({
      enabled: action === 'enable' ? true : current.enabled,
      cwd,
      timeoutMs,
      allowedRoots,
      blockedCommands,
      allowDangerous,
    });
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    return;
  }
  if (command === 'tools' && action === 'disable') {
    const status = await engine.configureLocalTools({ enabled: false });
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    return;
  }
  if (command === 'tools' && action === 'run') {
    const tool = args.positionals[2];
    if (!tool) throw new DexError('usage_error', '실행할 로컬 도구 이름이 필요합니다.');
    const result = await engine.runLocalTool(tool, jsonObjectOption(args, 'args'));
    if (asJson) writeJson(result);
    else for (const content of result.content) stdout.write(`${content.text}\n`);
    if (result.isError) process.exitCode = 1;
    return;
  }
  if (command === 'tools' && (action === 'status' || action === 'serve')) {
    let status = await engine.localToolsStatus();
    if (status.config.enabled) {
      try {
        status = await engine.startLocalTools(option(args, 'profile'), action === 'serve' ? 5_000 : 2_000);
      } catch (error) {
        if (action === 'serve') throw error;
        status = {
          ...status,
          bridge: { ...status.bridge, error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    if (action === 'serve') {
      if (!status.config.enabled) throw new DexError('local_tools_disabled', '먼저 dex tools enable을 실행하세요.');
      if (!asJson) stderr.write('로컬 도구 브리지가 실행 중입니다. 종료하려면 Ctrl+C를 누르세요.\n');
      try {
        await waitForStopSignal();
      } finally {
        engine.stopLocalTools();
      }
    } else {
      engine.stopLocalTools();
    }
    return;
  }
  if (command === 'agents' && action === 'list') {
    const owner = option(args, 'owner');
    if (owner && owner !== 'personal' && owner !== 'shared') {
      throw new DexError('usage_error', '--owner는 personal 또는 shared여야 합니다.');
    }
    const query: AgentListQuery = {
      page: positiveIntegerOption(args, 'page'),
      pageSize: positiveIntegerOption(args, 'page-size'),
      search: option(args, 'search'),
      owner: owner as AgentListQuery['owner'],
      status: option(args, 'status'),
      includeHarness: flag(args, 'include-harness'),
    };
    const result = await engine.listAgents(query, option(args, 'profile'));
    if (asJson) writeJson(result);
    else printAgents(result.items);
    return;
  }
  if (command === 'chat') {
    await runChat(engine, args);
    return;
  }
  if (command === 'history' && action === 'list') {
    const conversations = await engine.listConversations(option(args, 'profile'));
    if (asJson) writeJson(conversations);
    else printConversations(conversations);
    return;
  }
  if (command === 'history' && action === 'turns') {
    const turns = await engine.historyTurns(
      requiredOption(args, 'workflow'),
      requiredOption(args, 'interaction'),
      option(args, 'name'),
      option(args, 'profile'),
    );
    if (asJson) writeJson(turns);
    else printTurns(turns);
    return;
  }
  if (command === 'serve') {
    if (!flag(args, 'stdio')) throw new DexError('usage_error', '현재는 serve --stdio만 지원합니다.');
    const server = new DexRpcServer(engine, { version: VERSION });
    server.start();
    return;
  }
  throw new DexError('usage_error', `알 수 없는 명령입니다: ${args.positionals.join(' ')}`);
}

run().catch((error: unknown) => {
  const exposed = publicError(error);
  const machine = process.argv.includes('--json') || process.argv.includes('--jsonl');
  if (machine) stderr.write(`${JSON.stringify({ error: exposed })}\n`);
  else stderr.write(`dex: ${exposed.message}\n`);
  process.exitCode = exitCode(error);
});
