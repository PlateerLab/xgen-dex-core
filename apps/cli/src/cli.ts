#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';
import { parseArgs, flag, option, positiveIntegerOption, requiredOption } from './args';
import { FileConfigStore } from '@dex/engine';
import { SystemCredentialStore, credentialBackend } from '@dex/engine';
import { DexEngine } from '@dex/engine';
import { DexError, publicError } from '@dex/engine';
import { promptLine, promptSecret, readStdin } from './io';
import { isInteractiveTerminal, shouldLaunchTui } from './mode';
import { DexRpcServer } from '@dex/rpc/server';
import type { LocalToolsStatus } from '@dex/engine';
import type { Agent, AgentListQuery, ChatEvent, Conversation, HistoryTurn } from '@dex/engine';
import { bindCliHost } from './dex-host';

/**
 * 배포 버전 — **빌드가 package.json 에서 주입한다** (build.mjs 의 define).
 *
 * 예전에는 여기 문자열로 박혀 있었다. package.json 만 올리고 이 줄을 잊으면
 * `npm view` 는 1.2.0 인데 `dex --version` 은 0.1.0 을 말한다 — 실제로 그랬고,
 * 배포 후 실행해 보는 CI 단계가 그것을 잡았다. 사람이 두 곳을 기억할 일이 아니다.
 *
 * tsx 로 소스를 직접 돌릴 때(개발·테스트)는 define 이 없으므로 'dev' 가 된다.
 */
declare const __DEX_VERSION__: string | undefined;
const VERSION = typeof __DEX_VERSION__ === 'string' ? __DEX_VERSION__ : 'dev';

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
  dex tools enable [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--shell] [--allow-dangerous]
  dex tools configure [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--timeout <ms>]
                      [--shell|--no-shell] [--allow-dangerous|--no-allow-dangerous]
  dex tools disable
  dex tools run <Shell|ShellJob|ReadFile|WriteFile|ListDir|Search|Open|Clipboard|Notify> [--args <json>] [--json]
  dex ssh list [--json]
  dex ssh enable | dex ssh disable
  dex ssh test <name> [--json]
  dex tools serve [--profile <name>]   로컬 도구 브리지만 계속 실행
  dex tool ...                         dex tools ...의 단수형 별칭
  dex serve --stdio
  dex update [--check]    새 버전 확인 · 설치

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
  stdout.write(`Local PC MCP: ${status.config.enabled ? '켜짐' : '꺼짐'}\n`);
  stdout.write(`전체 셸 접근: ${status.config.shellEnabled ? '켜짐' : '꺼짐'}\n`);
  stdout.write(`작업 폴더: ${status.config.cwd || '(미설정)'}\n`);
  stdout.write(`허용 경로: ${status.config.allowedRoots.join(', ') || '(작업 폴더)'}\n`);
  stdout.write(`위험 명령: ${status.config.allowDangerous ? '허용' : '차단'}\n`);
  stdout.write(
    `브리지: ${
      status.bridge.catalogSynced
        ? `연결됨 (도구 ${status.bridge.serverToolCount}개)`
        : status.bridge.connected
          ? '카탈로그 동기화 중'
          : status.bridge.enabled
            ? '연결 대기 중'
            : '중지됨'
    }\n`,
  );
  if (status.bridge.error) stdout.write(`오류: ${status.bridge.error}\n`);
}

/**
 * 새 버전이 있으면 올리고, 아니면 최신이라고 말한다.
 *
 * `--check` 면 확인만 한다 — 스크립트가 "업데이트가 있나" 만 묻고 싶을 때.
 */
async function runUpdate(args: ReturnType<typeof parseArgs>, asJson: boolean): Promise<void> {
  const { checkForUpdate, globalInstallRoot, runCommand, explainNpmFailure } = await import('./update');

  let check;
  try {
    check = await checkForUpdate(VERSION);
  } catch (error) {
    // 확인 자체가 실패한 것을 "최신입니다" 로 덮지 않는다 — 그러면 사용자는
    // 업데이트가 없는 줄 알고 옛 버전에 남는다.
    throw new DexError(
      'network_error',
      `새 버전을 확인하지 못했습니다: ${publicError(error).message}`,
    );
  }

  if (!check.outdated) {
    if (asJson) writeJson({ ...check, action: 'none' });
    else stdout.write(`최신 버전입니다 (v${check.current})\n`);
    return;
  }

  if (flag(args, 'check')) {
    if (asJson) writeJson({ ...check, action: 'available' });
    else stdout.write(`새 버전이 있습니다: v${check.current} → v${check.latest}\n`);
    return;
  }

  // 전역 설치가 아니면 npm 명령을 쏘지 않는다 — 엉뚱한 곳을 건드리거나 아무 일도
  // 일어나지 않고, 사용자는 업데이트한 줄 안다.
  const globalRoot = await globalInstallRoot();
  if (!globalRoot) {
    if (asJson) writeJson({ ...check, action: 'manual' });
    else {
      stdout.write(`새 버전이 있습니다: v${check.current} → v${check.latest}\n`);
      stdout.write('이 dex 는 전역 npm 설치가 아니라 자동으로 올릴 수 없습니다.\n');
      stdout.write('  npm i -g xgen-dex-cli@latest\n');
    }
    return;
  }

  if (!asJson) stdout.write(`업데이트: v${check.current} → v${check.latest}\n`);
  const result = await runCommand('npm', ['i', '-g', `xgen-dex-cli@${check.latest}`], {
    // npm 진행 상황을 그대로 흘려 보낸다 — 수십 초 걸릴 수 있고, 아무것도 안 보이면
    // 멈춘 줄 안다.
    stream: asJson ? undefined : (chunk) => stderr.write(chunk),
  });

  if (result.code !== 0) {
    const reason = explainNpmFailure(`${result.stdout}\n${result.stderr}`);
    if (asJson) writeJson({ ...check, action: 'failed', error: reason });
    else stdout.write(`\n업데이트에 실패했습니다.\n${reason}\n`);
    process.exitCode = 1;
    return;
  }

  if (asJson) writeJson({ ...check, action: 'updated' });
  else stdout.write(`\nv${check.latest} 로 업데이트했습니다. 새 터미널에서 dex 를 다시 실행하세요.\n`);
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

  // 엔진에 이 호스트를 붙인다 — **엔진을 만들기 전에**. 로컬 도구와 MCP 가 전부
  // 이 포트들 위에서 돌고, 붙기 전에 건드리면 엔진이 명확히 던진다.
  const configStore = new FileConfigStore();
  bindCliHost(configStore);
  const engine = new DexEngine(configStore, new SystemCredentialStore());
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
    // 어디에 저장하는지는 authStatus 를 부른 **뒤에** 물어야 안다 — 그때 실제로
    // 저장소를 한 번 건드리기 때문이다.
    const backend = credentialBackend();
    if (asJson) writeJson({ ...status, credentialBackend: backend });
    else {
      if (status.authenticated) {
        stdout.write(`로그인됨: ${status.user?.username ?? 'unknown'} @ ${status.serverUrl}\n`);
      } else {
        stdout.write(`로그아웃됨: ${status.profile} (${status.reason ?? 'unknown'})\n`);
      }
      stdout.write(
        backend === 'keychain'
          ? '자격증명: OS 키체인\n'
          : '자격증명: 파일 (OS 키체인을 쓸 수 없어 소유자 전용 파일에 저장합니다)\n',
      );
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
    // 전체 카탈로그를 보여 주되 **지금 노출 중인지**를 함께 말한다. 노출 목록만
    // 보여 주면 꺼 둔 사용자에게는 빈 화면이라 "뭘 할 수 있는지" 알 수 없고,
    // 카탈로그만 보여 주면 꺼 둔 줄 모르고 "왜 안 되지"를 묻게 된다.
    const status = await engine.localToolsStatus();
    const exposed = new Set(status.tools.map((t) => t.name));
    if (asJson) writeJson({ enabled: status.config.enabled, catalog: status.catalog, exposed: [...exposed] });
    else {
      if (!status.config.enabled) {
        stdout.write('로컬 도구가 꺼져 있습니다 — 아래는 켰을 때 쓸 수 있는 목록입니다.\n');
        stdout.write('켜기: dex tools enable\n\n');
      }
      stdout.write(`${cell('TOOL', 14)}  ${cell('노출', 5)}  DESCRIPTION\n`);
      for (const tool of status.catalog) {
        // 설명 첫 줄만 — 이 도구들의 description 은 모델을 위한 것이라 수십 줄이다.
        // 전문은 --json 으로 본다.
        const summary = String(tool.description ?? '').split('\n')[0] ?? '';
        stdout.write(
          `${cell(tool.name, 14)}  ${cell(exposed.has(tool.name) ? '●' : '·', 5)}  ${summary.slice(0, 96)}\n`,
        );
      }
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
    const shellEnabled = flag(args, 'shell')
      ? true
      : flag(args, 'no-shell')
        ? false
        : current.shellEnabled;
    const status = await engine.configureLocalTools({
      enabled: action === 'enable' ? true : current.enabled,
      shellEnabled,
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
    // 멀티 디바이스 — 같은 계정에 붙은 커넥터 기기 전부 (이 CLI 포함).
    let devices: Awaited<ReturnType<typeof engine.listConnectorDevices>> = [];
    try {
      devices = await engine.listConnectorDevices(option(args, 'profile'));
    } catch {
      /* 서버 미지원(구버전)·미인증 — 기기 목록 없이 상태만 */
    }
    if (asJson) writeJson({ ...status, devices });
    else {
      printLocalToolsStatus(status);
      if (devices.length > 0) {
        stdout.write(`연결된 기기 (${devices.length}):\n`);
        for (const d of devices) {
          stdout.write(`  · ${d.name} [${d.platform || '?'}] — 도구 ${d.toolCount}개\n`);
        }
      }
    }
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
  // ── 업데이트 ──
  if (command === 'update') {
    await runUpdate(args, asJson);
    return;
  }

  // ── SSH ──
  // 목록·켜고 끄기·연결 테스트만 연다. 서버 등록/편집은 자격증명 입력이라
  // 마이페이지나 데스크톱에서 하는 편이 안전하고, 그쪽 화면이 이미 있다.
  if (command === 'ssh' && (action === 'list' || action === undefined)) {
    const config = await engine.sshConfig(option(args, 'profile'));
    if (asJson) writeJson(config);
    else {
      stdout.write(`SSH 연동: ${config.enabled ? '켜짐' : '꺼짐'}\n`);
      if (config.servers.length === 0) stdout.write('등록된 서버가 없습니다.\n');
      for (const srv of config.servers) {
        const via = srv.jump_via.length ? ` (경유 ${srv.jump_via.join(' → ')})` : '';
        const off = srv.enabled ? '' : ' [사용 안 함]';
        stdout.write(`${cell(srv.name, 18)}  ${srv.username}@${srv.host}:${srv.port}  ${srv.auth}${via}${off}\n`);
      }
    }
    return;
  }
  if (command === 'ssh' && (action === 'enable' || action === 'disable')) {
    const config = await engine.setSshEnabled(action === 'enable', option(args, 'profile'));
    if (asJson) writeJson(config);
    else stdout.write(`SSH 연동을 ${config.enabled ? '켰습니다' : '껐습니다'}.\n`);
    return;
  }
  if (command === 'ssh' && action === 'test') {
    const name = args.positionals[2];
    if (!name) throw new DexError('usage_error', '서버 이름이 필요합니다: dex ssh test <name>');
    const result = await engine.testSshServer(name, option(args, 'profile'));
    if (asJson) writeJson(result);
    else {
      stdout.write(
        result.success
          ? `접속 성공 (${Math.round(result.latency_ms ?? 0)}ms)\n`
          : `접속 실패 — ${result.error ?? ''}\n`,
      );
      // 3단 경로에서 "실패"만 알면 어디를 고쳐야 할지 알 수 없다.
      if (result.hops && result.hops.length > 1) {
        stdout.write(`경로: ${result.hops.join(' → ')}\n`);
      }
    }
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
