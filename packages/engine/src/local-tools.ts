/**
 * LocalTools — built-in tools the connector hosts ITSELF, advertised into the
 * SAME per-user MCP catalog as the user's configured MCP servers.
 *
 * Why not "just add an MCP server": the point is out-of-the-box local control.
 * Asking every user to wire an external shell-MCP server is exactly the friction
 * this removes. These tools ride the existing bridge rails (`hello` advertises
 * them, `mcp_call` dispatches to them), so the XGEN backend + agents need ZERO
 * changes — a built-in tool is indistinguishable from an MCP-server tool in the
 * catalog. The reserved server namespace is {@link LOCAL_SERVER}.
 *
 * Two tools, both operating the USER'S OWN PHYSICAL COMPUTER (not the cloud
 * workspace / sandbox):
 *   · {@link SHELL_TOOL} `Shell` — run ONE command in the native shell
 *     (PowerShell on Windows, the user's `$SHELL`/bash elsewhere). Robustness
 *     is the whole game here (2026-08 field report — the tool "worked then
 *     stopped"): stdin is CLOSED so interactive programs get EOF instead of
 *     hanging to the timeout; `background:true` launches GUI apps / long-running
 *     processes detached and returns immediately (so they aren't SIGKILLed at
 *     the timeout); a foreground timeout kills the whole process TREE.
 *   · {@link OPEN_TOOL} `Open` — open a file / URL / folder with the OS default
 *     app (Windows `start`, macOS `open`, Linux `xdg-open`), non-blocking. This
 *     is the unambiguous "열어줘" primitive so the agent doesn't have to guess
 *     xdg-open vs gedit vs kate.
 *
 * Every file and terminal tool is SCOPED to the folders the user connected to
 * the conversation that made the call (see local-folders.ts). A conversation
 * with no connected folder cannot touch this computer's files or terminal at
 * all; disconnecting a folder takes effect on the next call. The tools stay in
 * the catalog — the server decides per turn what the agent sees, this provider
 * decides per call what actually runs. Lives in the MAIN process (only main may
 * spawn subprocesses). Pure helpers are exported for unit tests that never spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, platform } from 'node:os';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  appendFile as fsAppendFile,
  readdir,
  stat,
  lstat,
  realpath,
  mkdir,
} from 'node:fs/promises';
import {
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute,
  join as pathJoin,
  dirname,
  extname,
  delimiter,
} from 'node:path';
import { augmentedPath, buildChildEnv, commonBinDirs } from './exec-resolve';
import { interaction } from './host';
import type { LocalFolder } from './local-folders';
import {
  gitIdentityEnv,
  prepareWorkspaceShell,
  userToolchains,
  workspaceShellSupported,
} from './workspace-shell';

/** Reserved MCP "server" name for connector-hosted built-ins. Agents see the
 *  tool as `mcp_local_<Tool>` after backend sanitization — keep it stable. */
export const LOCAL_SERVER = 'local';
/** First-turn gateway recognized by the runtime's hierarchical tool exposure. */
export const LOCAL_CONTROL_TOOL = 'LocalControl';
export const SHELL_TOOL = 'Shell';
/** 로컬 MCP 서버 자기관리 도구 — 로컬 MCP(cfg.mcp) 가 켜져 있을 때만 노출된다.
 *  에이전트가 이 PC(커넥터 로컬)에서 도는 MCP 서버를 스스로 추가/제거/조회한다. */
export const MCP_ADD_TOOL = 'McpAddServer';
export const MCP_REMOVE_TOOL = 'McpRemoveServer';
export const MCP_LIST_TOOL = 'McpListServers';
export const OPEN_TOOL = 'Open';
// 반구조화 1급 로컬 도구 — 셸 문자열 우회 없이 파일/클립보드/알림을 다룬다.
// 파일 계열은 allowedRoots 경로 스코프 안에서만 동작한다(방어적 가드).
export const READ_FILE_TOOL = 'ReadFile';
export const WRITE_FILE_TOOL = 'WriteFile';
export const LIST_DIR_TOOL = 'ListDir';
export const SEARCH_TOOL = 'Search';
export const CLIPBOARD_TOOL = 'Clipboard';
export const NOTIFY_TOOL = 'Notify';
/** Manage long-running background jobs started with Shell(background:true):
 *  list / poll (status + captured output, paginated) / kill. */
export const SHELL_JOB_TOOL = 'ShellJob';

/** Tools that work inside the folders connected to a conversation. */
export const FOLDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  SHELL_TOOL,
  SHELL_JOB_TOOL,
  OPEN_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIR_TOOL,
  SEARCH_TOOL,
  CLIPBOARD_TOOL,
  NOTIFY_TOOL,
]);

/** A folder tool was called from a conversation with no connected folder. */
export const NO_FOLDER_MESSAGE =
  '[NO_FOLDER] 이 대화에는 연결된 폴더가 없어 이 PC의 파일과 터미널을 쓸 수 없습니다. ' +
  '사용자에게 채팅 위 [폴더]로 작업할 폴더를 연결해 달라고 요청하세요.';

export interface LocalToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface LocalToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Machine-readable result metadata for routers that must preserve path/job domains. */
  structuredContent?: Record<string, unknown>;
}

/** Server-attested identity of the workflow that initiated a local tool call. */
export interface LocalToolCallContext {
  workflowId?: string;
  workflowName?: string;
  interactionId?: string;
}

/** Normalize snake/camel-case caller identity from an authenticated bridge frame. */
export function localToolCallContext(raw: unknown): LocalToolCallContext {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (input: unknown): string | undefined => {
    const normalized = String(input ?? '').trim();
    return normalized || undefined;
  };
  return {
    workflowId: text(value.workflow_id ?? value.workflowId),
    workflowName: text(value.workflow_name ?? value.workflowName),
    interactionId: text(value.interaction_id ?? value.interactionId),
  };
}

/** Conversation → the folders the user connected to it. Empty = no access. */
export type LocalFolderResolver = (context?: LocalToolCallContext) => LocalFolder[];

export interface LocalToolDelegate {
  advertise(): LocalToolSchema[];
  owns(tool: string): boolean;
  callTool(
    tool: string,
    args: unknown,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult>;
}

export type LocalNotificationHandler = (
  title: string,
  body: string,
  context?: LocalToolCallContext,
) => Promise<boolean> | boolean;

/** 포그라운드 명령 하나의 기본 시간 제한 — 서버 MCP_CALL_TIMEOUT_S 와 같은 값이어야 한다. */
export const LOCAL_COMMAND_TIMEOUT_MS = 600_000; // 10분 — 긴 설치/빌드/스크립트 기본 허용
const DEFAULT_TIMEOUT_MS = LOCAL_COMMAND_TIMEOUT_MS;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const OUTPUT_CAP = 200_000; // chars kept from stdout+stderr
/** Grace we wait for a background launch to fail (ENOENT) before reporting success. */
const BG_SETTLE_MS = 350;
/** Foreground commands still running after this grace become pollable jobs. */
const AUTO_BACKGROUND_AFTER_MS = 15_000;
/** Per-stream ring-buffer cap for a background job (chars). */
const JOB_STREAM_CAP = 262_144; // 256KB stdout + 256KB stderr per job
/** Max background jobs retained; oldest FINISHED jobs are evicted past this. */
const MAX_JOBS = 50;
/** Max concurrently-RUNNING background jobs (finished ones don't count). */
const MAX_RUNNING_JOBS = 25;

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

/** Human label for the OS's native shell (shown in the tool description). */
export function nativeShellLabel(): string {
  if (IS_WIN) return 'PowerShell';
  if (IS_MAC) return 'zsh/bash';
  return 'bash/sh';
}

/**
 * Build the argv that runs `command` through the native shell.
 *
 * Windows → PowerShell (`-NoProfile -NonInteractive -Command <cmd>`): it is the
 * shell users expect on Windows and handles GUI-launch (`notepad`) and pipes.
 * POSIX → the user's `$SHELL` binary if given, else bash, with `-lc <cmd>` so
 * PATH/rc are loaded (GUI-launched apps otherwise miss `open`, `xdg-open`,
 * brew paths, …).
 *
 * `userShellBin` is the shell EXECUTABLE (e.g. `/bin/zsh` from `$SHELL`), NOT a
 * PATH string. `explicitShell` overrides detection: 'powershell'|'cmd'|'bash'|'sh'.
 */
export function shellInvocation(
  command: string,
  userShellBin: string | null,
  explicitShell?: string,
): { file: string; args: string[] } {
  const want = (explicitShell || 'default').toLowerCase();
  if (want === 'powershell' || (want === 'default' && IS_WIN)) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  if (want === 'cmd') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (want === 'bash') return { file: 'bash', args: ['-lc', command] };
  if (want === 'sh') return { file: 'sh', args: ['-lc', command] };
  // POSIX default: the user's own shell ($SHELL) if it looks like a path, else bash.
  const bin = (userShellBin || '').trim();
  const file = bin.startsWith('/') ? bin : 'bash';
  return { file, args: ['-lc', command] };
}

/** Argv that opens a file / URL / folder with the OS default handler. Returns
 *  fast — the opener forks the real app and exits. */
export function openerInvocation(target: string): { file: string; args: string[] } {
  const t = String(target || '').trim();
  if (IS_WIN) return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', t] };
  if (IS_MAC) return { file: 'open', args: [t] };
  return { file: 'xdg-open', args: [t] };
}

/** How long the opener gets to report an immediate failure before we declare
 *  success. Some environments' openers do not exit until the launched app
 *  closes (an xdg-open that execs the editor directly; Electron's
 *  shell.openPath) — by then the launch has already happened, and awaiting the
 *  exit turned into the 2026-09 real incident: the editor visibly opened but
 *  the tool call sat until the 120s MCP timeout and reported failure. */
export const OPENER_ERROR_WINDOW_MS = 1_500;

/** Open 도구가 호스트의 openPath/openExternal 응답을 기다려 주는 상한.
 *  오프너 오류 창(1.5s)보다 넉넉히 길게 — 정상 호스트는 그 안에 답한다. */
const OPEN_HOST_TIMEOUT_MS = 8_000;

/** 호스트 open 호출을 시간 상한으로 감싼다 — 상한이 지나면 성공('')으로
 *  확정한다 (launch 는 이미 일어났고, 기다리던 것은 앱의 "종료"였다). */
function boundedOpen(p: Promise<string>, timeoutMs = OPEN_HOST_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => resolve(''), timeoutMs);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Open a file/folder with the OS default app via a DETACHED child, resolving
 * '' on success or an error message — never waiting for the launched app to
 * exit, and never doing a synchronous path check on this process's event loop
 * (Electron's shell.openPath does, which deadlocks against our own workspace
 * mount served by the same loop). Shared by the desktop and CLI hosts.
 */
export function openWithDefaultApp(
  target: string,
  spawnImpl: typeof spawn = spawn,
  errorWindowMs = OPENER_ERROR_WINDOW_MS,
): Promise<string> {
  const { file, args } = openerInvocation(target);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (msg: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(msg);
    };
    let child: ChildProcess;
    try {
      child = spawnImpl(file, args, {
        detached: !IS_WIN,
        windowsHide: true,
        // stderr 만 잠깐 본다 — 즉시 실패("no application found" 류)의 사유를
        // 사용자에게 돌려주기 위해서다.
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      resolve(`열지 못했습니다: ${(e as Error).message}`);
      return;
    }
    let err = '';
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => finish(`열지 못했습니다: ${e.message} (${file} 필요)`));
    child.on('exit', (code) => {
      // Windows explorer 는 성공해도 종료코드 1 을 준다 — 오류가 아니다.
      if (code && !(IS_WIN && code === 1)) {
        finish(err.trim() || `${file} exited with code ${code}`);
      } else {
        finish('');
      }
    });
    timer = setTimeout(() => {
      try {
        child.unref();
      } catch {
        /* noop */
      }
      finish(''); // 창이 지나도록 안 죽었으면 앱은 떴다 — 성공으로 확정
    }, errorWindowMs);
    timer.unref?.();
  });
}

/**
 * 되돌리기 어려운(파괴적) 명령 패턴. 일반 명령은 승인 없이 실행하되, 이 패턴에
 * 걸리는 명령만 사용자 확인을 받는다 — 마찰을 최소화하면서 사고를 막는다.
 * 보안 경계가 아니라 "실수 방지 게이트"다 (에이전트는 어차피 로그인 사용자 권한).
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / -r / -f
  /(^|[;&|`(])\s*rm\s+\//i, // rm on an absolute path
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[a-z]*[sf]/i,
  // Only in command position: `git log --format=…` / `docker ps --format` are not `format C:`.
  /(^|[;&|`(])\s*(sudo\s+)?(mkfs(\.\w+)?|fdisk|format(\.com)?)\b/i,
  /\bdd\b[^\n]*\b(of|if)=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, // fork bomb
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bsudo\s+rm\b/i,
];

/** True if the command matches a destructive pattern that warrants confirmation. */
export function isDangerousShellCommand(command: string): boolean {
  const c = String(command || '');
  return DANGEROUS_PATTERNS.some((re) => re.test(c));
}

// "이 대화에서 계속 허용"을 고른 대화 — 그 대화에서는 다시 묻지 않는다.
// 대화마다 가르는 이유: 한 대화에서 준 승인이 폴더가 다른 대화로 번지면 안 된다.
const approvedDangerousScopes = new Set<string>();

/** 위험 명령을 사용자가 거부했을 때 돌려주는 문구 — Shell 과 워크스페이스 브리지(_Exec)가 같이 쓴다.
 *  서버 런타임은 이 문구를 사용자 거부로 인식한다(xgen-agent-runtime host/tools.py). 바꾸면 거기도 바꿀 것. */
export const DANGEROUS_COMMAND_DENIED = '사용자가 이 명령의 실행을 거부했습니다 (위험할 수 있는 명령).';

/** 위험 패턴이면 사용자에게 확인. false = 거부. dialog 는 main 프로세스에서만.
 *  사용자 PC 에서 명령을 실행하는 경로가 모두 이 한 곳을 거친다. `scope` 는
 *  승인을 기억하는 단위(대화 id)다. */
export async function ensureDangerousApproval(command: string, scope = ''): Promise<boolean> {
  if (!isDangerousShellCommand(command)) return true;
  if (approvedDangerousScopes.has(scope)) return true;
  const ask = interaction().confirmDangerous;
  // 물을 방법이 없으면 **거부**한다. "물을 필요가 없다"가 아니라 "동의를 받을 수
  // 없다"이고, 그때 실행하면 사용자가 모르는 사이에 파괴적인 명령이 돈다.
  if (!ask) return false;
  try {
    const answer = await ask(command);
    if (answer === 'session') {
      approvedDangerousScopes.add(scope);
      return true;
    }
    return answer === 'once';
  } catch {
    // 물다가 실패하면(창이 없다거나) 안전하게 거부한다.
    return false;
  }
}

/** 확인 창에 쓸 문구 — 호스트가 어떤 UI 로 묻든 **같은 말**을 하도록 여기 둔다.
 *  데스크톱은 다이얼로그로, 터미널은 프롬프트로 묻지만 사용자가 읽는 경고는 하나여야 한다. */
export const DANGEROUS_COMMAND_PROMPT = {
  title: '위험할 수 있는 명령 실행 확인',
  message: 'XGEN 에이전트가 이 PC 에서 되돌리기 어려운 명령을 실행하려 합니다.',
  detail: (command: string) => command,
} as const;

/** Clamp + label combined stdout/stderr into an MCP text result. */
export function shapeResult(
  stdout: string,
  stderr: string,
  code: number | null,
  signal: string | null,
): LocalToolResult {
  const parts: string[] = [];
  const out = stdout.length > OUTPUT_CAP ? stdout.slice(0, OUTPUT_CAP) + '\n…(truncated)' : stdout;
  const err = stderr.length > OUTPUT_CAP ? stderr.slice(0, OUTPUT_CAP) + '\n…(truncated)' : stderr;
  if (out.trim()) parts.push(out.replace(/\s+$/, ''));
  if (err.trim()) parts.push(`STDERR:\n${err.replace(/\s+$/, '')}`);
  const failed = signal != null || (code != null && code !== 0);
  if (signal) parts.push(`(terminated by signal ${signal})`);
  else if (code != null && code !== 0) parts.push(`(exit code ${code})`);
  return {
    content: [{ type: 'text', text: parts.join('\n\n') || '(no output)' }],
    isError: failed,
    structuredContent: {
      execution_surface: 'connector_local',
      path_domain: 'physical_local',
      exit_code: code,
      signal,
    },
  };
}

/**
 * 로컬 PC 도구의 실행 위치 안내. 서버 작업 공간의 도구(Bash/Read/Write)와 사용자
 * PC 의 물리 경로를 구분한다.
 */
export const SYNCED_WORKSPACE_NOTE =
  `\nEXECUTION SURFACE: the user's own computer running this app. Paths belong to that ` +
  `computer and are limited to the folders the user connected to this conversation. ` +
  `It does not share files, processes or network ports with your server sandbox.`;

export function localControlToolSchema(): LocalToolSchema {
  return {
    name: LOCAL_CONTROL_TOOL,
    description:
      `List the tools the user's own computer provides to this conversation and the ` +
      `folders the user connected to it. This is a read-only capability inventory; it ` +
      `does not execute commands or change settings.`,
    inputSchema: { type: 'object', properties: {} },
  };
}

/** The Shell tool schema advertised to the agent. */
/** McpAddServer — 이 PC(커넥터 로컬)에 MCP 서버를 등록/갱신하고 그 도구를 지금 세션
 *  에이전트들에 붙인다. 표준 mcp.json 서버 항목과 같은 필드를 받는다. */
export function mcpAddServerToolSchema(): LocalToolSchema {
  return {
    name: MCP_ADD_TOOL,
    description:
      "Register (or update) a local MCP server ON THE USER'S OWN COMPUTER (this connector) and attach " +
      'its tools to the current session agents. Same fields as a standard mcp.json server entry. ' +
      'stdio: give `command` (+ optional `args`, `env`); http/sse: give `url` (+ optional `headers`, ' +
      "`auth`). If a server with the same `name` exists it is replaced. Runs in the connector's local " +
      'environment only — NOT the cloud. Example (Atlassian, local uvx): {name:"atlassian", ' +
      'command:"uvx", args:["mcp-atlassian"], env:{ATLASSIAN_BASE_URL:"https://your-site.atlassian.net", ' +
      'ATLASSIAN_USERNAME:"you@example.com", ATLASSIAN_API_TOKEN:"..."}}. Example (remote proxy): ' +
      '{name:"atlassian", command:"npx", args:["-y","mcp-remote","https://mcp.atlassian.com/v1/mcp/authv2"]}. ' +
      'auth:"oauth" servers need a one-time browser authorization by the user before tools connect. ' +
      'Returns the connection result and the discovered tool names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique server id (namespaces its tools).' },
        transport: {
          type: 'string',
          enum: ['stdio', 'http', 'sse'],
          description: 'Optional. Inferred from url (http) / command (stdio) when omitted.',
        },
        command: { type: 'string', description: 'stdio: launch command (e.g. "uvx", "npx").' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'stdio: argv for the command.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'stdio: extra env (API tokens etc.) merged over the connector env.',
        },
        url: { type: 'string', description: 'http/sse: the MCP endpoint URL.' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'http/sse: extra request headers (e.g. Authorization).',
        },
        auth: {
          type: 'string',
          enum: ['none', 'oauth'],
          description: "http/sse auth. Default 'none'.",
        },
      },
      required: ['name'],
    },
  };
}

/** McpRemoveServer — 로컬 MCP 서버를 해제하고(프로세스 종료) 그 도구를 뗀다. */
export function mcpRemoveServerToolSchema(): LocalToolSchema {
  return {
    name: MCP_REMOVE_TOOL,
    description:
      'Remove a local MCP server (by name) from this connector: stop its process/connection and detach ' +
      'its tools from the session agents. Also clears its stored secrets. No-op if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The server id to remove.' } },
      required: ['name'],
    },
  };
}

/** McpListServers — 이 PC 에 등록된 로컬 MCP 서버와 연결 상태·도구 수를 조회한다. */
export function mcpListServersToolSchema(): LocalToolSchema {
  return {
    name: MCP_LIST_TOOL,
    description:
      'List the local MCP servers registered on this connector with their transport, enabled/connected ' +
      'state, and the tools each exposes. Secret values are never returned. Use before add/remove.',
    inputSchema: { type: 'object', properties: {} },
  };
}

export function shellToolSchema(): LocalToolSchema {
  return {
    name: SHELL_TOOL,
    description:
      `Run ONE command in a terminal on the USER'S OWN COMPUTER (the device running this app), ` +
      `through its native shell (${nativeShellLabel()}), as the logged-in user. It works only ` +
      `inside the folders the user connected to THIS conversation: the working directory must be ` +
      `one of them (default: the first connected folder). On macOS and Linux the command and ` +
      `its child processes can only write inside those folders when the OS supports it; HOME and ` +
      `temporary files then live in a scratch folder removed after the command. This is the ` +
      `user's physical machine, NOT your server sandbox: never pass these paths to the server's ` +
      `Read/Write/Bash tools.` +
      SYNCED_WORKSPACE_NOTE +
      `\n` +
      `IMPORTANT for reliability:\n` +
      `• Non-interactive only — stdin is closed, so REPLs/prompts (bash, python with no args, ` +
      `\`read\`, pagers) return immediately instead of hanging. Pass the full command each call.\n` +
      `• To launch a GUI app or a long-running/never-exiting process (editors like notepad/gedit, ` +
      `servers, watchers) — or ANY job that may run longer than a couple of minutes — set ` +
      `background:true. It starts detached, returns a job_id at once, and is NOT killed at the ` +
      `timeout; its output is captured. Poll it later with the ShellJob tool (action:'poll', job_id).\n` +
      `• A foreground command that is still running after a short grace is automatically converted ` +
      `to a ShellJob. Poll the returned job_id; do not switch to sandbox tools to inspect local output.\n` +
      `• Jobs stop when the user disconnects the folder they run in.\n` +
      `• To just open a file/URL/folder with its default app, prefer the Open tool.\n` +
      `Returns combined stdout/stderr and the exit code (foreground); a job_id (background). For huge ` +
      `output, pass head/tail (lines) or max_bytes to page it.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command line to execute.' },
        background: {
          type: 'boolean',
          description:
            'Launch detached and return a job_id immediately (output captured, pollable via ShellJob). ' +
            'Use for GUI apps and long-running jobs so they keep running and are not killed at the timeout.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory on the user\'s computer. Must be inside a folder connected to this ' +
            'conversation; relative paths start from the first connected folder (the default).',
        },
        shell: {
          type: 'string',
          enum: ['default', 'powershell', 'cmd', 'bash', 'sh'],
          description: "Shell to use. 'default' picks the OS native shell.",
        },
        timeout_ms: {
          type: 'integer',
          description:
            'Optional maximum runtime (ms). Ignored when background=true; retained after automatic job conversion.',
        },
        background_after_ms: {
          type: 'integer',
          description: `Foreground grace before automatic ShellJob conversion (default ${AUTO_BACKGROUND_AFTER_MS}ms).`,
        },
        tail: {
          type: 'integer',
          description: 'Return only the last N lines of output (for chatty commands).',
        },
        head: { type: 'integer', description: 'Return only the first N lines of output.' },
        max_bytes: {
          type: 'integer',
          description: `Cap returned output bytes (default/cap ${OUTPUT_CAP}).`,
        },
      },
      required: ['command'],
    },
  };
}

/** The ShellJob tool schema — manage background jobs (G6/G13). */
export function shellJobToolSchema(): LocalToolSchema {
  return {
    name: SHELL_JOB_TOOL,
    description:
      `Manage long-running background jobs started with Shell(background:true) on the USER'S OWN ` +
      `COMPUTER. This is how you run work that outlives a single tool call: start it in the ` +
      `background, then poll it here until it finishes. Only jobs started in this conversation ` +
      `are visible.\n` +
      `• action:'list' — show this conversation's recent/running jobs (id, status, pid, duration, command).\n` +
      `• action:'poll' (job_id) — status + captured stdout/stderr (paginated: tail default, or head/max_bytes).\n` +
      `• action:'kill' (job_id) — terminate a running job (whole process tree).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'poll', 'kill'], description: "Default 'list'." },
        job_id: {
          type: 'string',
          description: 'The job id returned by Shell(background:true). Required for poll/kill.',
        },
        tail: { type: 'integer', description: 'poll: last N lines (default 200).' },
        head: { type: 'integer', description: 'poll: first N lines.' },
        max_bytes: { type: 'integer', description: 'poll: cap returned output bytes.' },
      },
    },
  };
}

/** The Open tool schema. */
export function openToolSchema(): LocalToolSchema {
  return {
    name: OPEN_TOOL,
    description:
      `Open a file, folder, or URL on the USER'S OWN COMPUTER with its default application. ` +
      `Non-blocking — the app launches and this returns immediately. Use this for "open <file>", ` +
      `"show me <folder>", "open <url>". Safe by construction: only http/https/mailto/tel/ftp URLs ` +
      `and paths inside the folders connected to this conversation are opened (javascript:/data: ` +
      `and unknown schemes are refused). To launch an app by name or run a command, use ` +
      `Shell(background:true).`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'A file/folder path (inside a connected folder) or an http/https/mailto/tel/ftp URL.',
        },
      },
      required: ['target'],
    },
  };
}

/** Coerce loose MCP args (agents send strings/objects) into a shell request. */
export function coerceShellArgs(args: unknown): {
  command: string;
  cwd?: string;
  shell?: string;
  timeoutMs?: number;
  backgroundAfterMs?: number;
  background: boolean;
} {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const command = typeof a.command === 'string' ? a.command : String(a.command ?? '');
  const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? a.cwd.trim() : undefined;
  const shell = typeof a.shell === 'string' ? a.shell : undefined;
  const t = a.timeout_ms ?? a.timeoutMs;
  const timeoutMs = typeof t === 'number' && t > 0 ? t : undefined;
  const auto = Number(a.background_after_ms ?? a.backgroundAfterMs);
  const backgroundAfterMs =
    Number.isFinite(auto) && auto > 0
      ? Math.max(100, Math.min(60_000, Math.round(auto)))
      : undefined;
  const bg = a.background ?? a.detach ?? a.detached;
  const background = bg === true || bg === 'true' || bg === 1;
  return { command, cwd, shell, timeoutMs, backgroundAfterMs, background };
}

export function coerceOpenArgs(args: unknown): { target: string } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const raw = a.target ?? a.path ?? a.url ?? a.file;
  return { target: typeof raw === 'string' ? raw : String(raw ?? '') };
}

interface SpawnCaptured {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
}

/** Kill a child and, on POSIX, its whole process group (so a shell's children —
 *  a foreground GUI, a subprocess tree — go with it and don't orphan). */
function killTree(child: ChildProcess, detachedGroup: boolean): void {
  try {
    if (IS_WIN) {
      if (child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    } else if (detachedGroup && child.pid) {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the process group
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// ── Background job registry (G6/G13) ────────────────────────────────
// Shell(background:true) registers a job here so the agent can later poll its
// output / status and kill it — decoupling long jobs from any single tool-call
// timeout (the connector allows up to 1h; the backend tool call is ~125s).

type JobStatus = 'running' | 'exited' | 'killed' | 'error';

interface BgJob {
  id: string;
  /** The conversation that started it — list/poll/kill see only their own. */
  owner: string;
  /** The connected folders at launch. Disconnecting any of them stops the job. */
  roots: string[];
  command: string;
  pid?: number;
  child: ChildProcess;
  detachedGroup: boolean;
  status: JobStatus;
  code: number | null;
  signal: string | null;
  startedAt: number;
  endedAt?: number;
  stdout: string;
  stderr: string;
  errorMsg?: string;
}

const bgJobs = new Map<string, BgJob>();
let bgJobSeq = 0;

function newJobId(): string {
  bgJobSeq += 1;
  return `job-${Date.now().toString(36)}-${bgJobSeq}`;
}

/** Drop the oldest FINISHED jobs once the registry exceeds MAX_JOBS. Running
 *  jobs are never evicted. */
function evictFinishedJobs(): void {
  if (bgJobs.size <= MAX_JOBS) return;
  const finished = [...bgJobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const j of finished) {
    if (bgJobs.size <= MAX_JOBS) break;
    bgJobs.delete(j.id);
  }
}

/** Stop a conversation's running jobs launched with a folder it no longer has. */
function stopJobsOutside(owner: string, roots: string[]): number {
  const kept = new Set(roots);
  let stopped = 0;
  for (const job of bgJobs.values()) {
    if (job.owner !== owner || job.status !== 'running') continue;
    if (job.roots.every((root) => kept.has(root))) continue;
    killTree(job.child, job.detachedGroup);
    job.status = 'killed';
    job.errorMsg = '연결이 해제된 폴더에서 실행 중이던 작업이라 중지했습니다.';
    job.endedAt = Date.now();
    stopped += 1;
  }
  return stopped;
}

/** Append to a job stream buffer, keeping only the last JOB_STREAM_CAP chars. */
function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > JOB_STREAM_CAP ? next.slice(-JOB_STREAM_CAP) : next;
}

/** Paginate text by lines (head/tail) then clamp to a byte cap. Tail-biased so
 *  logs show their most recent output when clamped. Returns the shaped text plus
 *  whether it was truncated and the full byte length. */
export function paginate(
  text: string,
  opts: { head?: number; tail?: number; maxBytes?: number },
): { text: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text);
  let out = text;
  let truncated = false;
  const head = Number(opts.head) > 0 ? Math.floor(Number(opts.head)) : 0;
  const tail = Number(opts.tail) > 0 ? Math.floor(Number(opts.tail)) : 0;
  if (head || tail) {
    const lines = text.split('\n');
    if (head) out = lines.slice(0, head).join('\n');
    else out = lines.slice(-tail).join('\n');
    if (out.length < text.length) truncated = true;
  }
  const cap = Math.max(
    1,
    Math.min(
      OUTPUT_CAP,
      Number(opts.maxBytes) > 0 ? Math.floor(Number(opts.maxBytes)) : OUTPUT_CAP,
    ),
  );
  if (Buffer.byteLength(out) > cap) {
    // Cap on BYTES (not UTF-16 units), snapping to a UTF-8 character boundary so
    // we never split a multibyte char (no U+FFFD) and never exceed `cap` bytes.
    // Continuation bytes are 0b10xxxxxx (0x80–0xBF).
    const buf = Buffer.from(out, 'utf8');
    if (head) {
      let end = cap;
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back up before a partial char
      out = buf.subarray(0, end).toString('utf8');
    } else {
      let start = buf.length - cap;
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // advance to a lead byte
      out = buf.subarray(start).toString('utf8');
    }
    truncated = true;
  }
  return { text: out, truncated, totalBytes };
}

/** Allowed URL schemes for the Open tool. Everything else (javascript:, data:,
 *  vbscript:, unknown app schemes) is refused. `file:` is treated as a path. */
const SAFE_OPEN_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'ftps']);

/** Classify an Open target into a safe URL, a filesystem path, or blocked. Pure
 *  (unit-tested) — the actual open uses Electron's shell API (no shell string). */
export function classifyOpenTarget(
  target: string,
):
  | { kind: 'url'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'blocked'; reason: string } {
  const t = String(target || '').trim();
  if (!t) return { kind: 'blocked', reason: 'target 이 비어 있습니다.' };
  const m = t.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'file')
      return { kind: 'path', value: t.replace(/^file:\/\//i, '').replace(/^file:/i, '') };
    if (SAFE_OPEN_SCHEMES.has(scheme)) return { kind: 'url', value: t };
    // Windows drive letters ("C:\…") look like a scheme — treat as a path.
    if (IS_WIN && /^[a-zA-Z]:[\\/]/.test(t)) return { kind: 'path', value: t };
    return {
      kind: 'blocked',
      reason: `허용되지 않은 스킴 '${scheme}:' (javascript/data 등은 차단).`,
    };
  }
  return { kind: 'path', value: t };
}

/** Extensions we never text-search (binary/asset). */
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.ogg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.so',
  '.dll',
  '.dylib',
  '.exe',
  '.bin',
  '.class',
  '.o',
]);

function resolveOne(p: string, base: string): string {
  const home = homedir();
  const expanded = p.startsWith('~') ? home + p.slice(1) : p;
  return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(base, expanded);
}

/**
 * Resolve a user-supplied path and confirm it stays within an allowed root.
 * Empty roots → the user's home directory. Returns the absolute path, or null
 * when it escapes every root. `~` expands to home; relative paths resolve
 * against home.
 */
export function resolveWithinRoots(input: string, roots: string[]): string | null {
  const home = homedir();
  const effective = (roots && roots.length ? roots : [home]).map((r) => resolveOne(r, home));
  const abs = resolveOne(String(input || ''), home);
  for (const root of effective) {
    const rel = pathRelative(root, abs);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs;
  }
  return null;
}

function pathInside(root: string, target: string): boolean {
  const rel = pathRelative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Symlink-aware variant used at the actual filesystem boundary.
 *
 * `resolveWithinRoots` remains a synchronous lexical helper for forms/tests, but
 * lexical checks alone allow `<allowed>/link -> /outside` escapes. For missing
 * write targets we canonicalize the nearest existing ancestor and append only
 * its missing suffix.
 */
export async function resolveWithinRootsReal(
  input: string,
  roots: string[],
): Promise<string | null> {
  const home = homedir();
  const effective = (roots && roots.length ? roots : [home]).map((r) => resolveOne(r, home));
  const canonicalRoots = (
    await Promise.all(effective.map((root) => realpath(root).catch(() => null)))
  ).filter((root): root is string => typeof root === 'string');
  if (!canonicalRoots.length) return null;

  const abs = resolveOne(String(input || ''), home);
  let cursor = abs;
  let canonical: string | null = null;
  while (true) {
    try {
      const existing = await realpath(cursor);
      canonical = pathResolve(existing, pathRelative(cursor, abs));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
  return canonicalRoots.some((root) => pathInside(root, canonical!)) ? canonical : null;
}

export function readFileToolSchema(): LocalToolSchema {
  return {
    name: READ_FILE_TOOL,
    description:
      "Read a text file on the USER'S OWN COMPUTER, inside the folders connected to this " +
      'conversation. Prefer this over `Shell cat` — it distinguishes “not found” ' +
      'from “no permission” cleanly. This is the only Read tool for physical local paths; ' +
      'never send those paths to sandbox Read. Returns UTF-8 text (truncated at maxBytes).' +
      SYNCED_WORKSPACE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path on the user\'s computer: absolute, or relative to the first connected folder.',
        },
        maxBytes: {
          type: 'number',
          description: `Max bytes to return (default/cap ${OUTPUT_CAP}).`,
        },
      },
      required: ['path'],
    },
  };
}

export function writeFileToolSchema(): LocalToolSchema {
  return {
    name: WRITE_FILE_TOOL,
    description:
      "Write (or append to) a text file on the USER'S OWN COMPUTER, inside the folders " +
      'connected to this conversation. Creates parent directories as needed. Prefer this over ' +
      'shell redirection.' +
      SYNCED_WORKSPACE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path on the user\'s computer: absolute, or relative to the first connected folder.',
        },
        content: { type: 'string', description: 'Text to write.' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default overwrite.' },
      },
      required: ['path', 'content'],
    },
  };
}

export function listDirToolSchema(): LocalToolSchema {
  return {
    name: LIST_DIR_TOOL,
    description:
      "List a directory on the USER'S OWN COMPUTER (inside the folders connected to this " +
      'conversation). Shows type/size/name.' +
      SYNCED_WORKSPACE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory on the user\'s computer (default: the first connected folder).' },
      },
    },
  };
}

export function searchToolSchema(): LocalToolSchema {
  return {
    name: SEARCH_TOOL,
    description:
      "Recursively search text files under a folder on the USER'S OWN COMPUTER (inside the " +
      'folders connected to this conversation) for a literal substring. Skips ' +
      'node_modules/.git/binaries. Returns path:line: match.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal substring to find.' },
        path: { type: 'string', description: 'Folder to search (default: the first connected folder).' },
        maxResults: { type: 'number', description: 'Max matches (default 100, cap 500).' },
      },
      required: ['query'],
    },
  };
}

export function clipboardToolSchema(): LocalToolSchema {
  return {
    name: CLIPBOARD_TOOL,
    description:
      "Read or write the USER'S system clipboard (plain text). Available while a folder is " +
      'connected to this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'read (default) or write.',
        },
        text: { type: 'string', description: 'Text to put on the clipboard when action=write.' },
      },
    },
  };
}

export function notifyToolSchema(): LocalToolSchema {
  return {
    name: NOTIFY_TOOL,
    description:
      "Show a desktop notification on the USER'S OWN COMPUTER. Available while a folder is " +
      'connected to this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title.' },
        body: { type: 'string', description: 'Notification body.' },
      },
      required: ['title'],
    },
  };
}

/** The folder tools, in catalog order. */
export function folderToolSchemas(): LocalToolSchema[] {
  return [
    shellToolSchema(),
    shellJobToolSchema(),
    openToolSchema(),
    readFileToolSchema(),
    writeFileToolSchema(),
    listDirToolSchema(),
    searchToolSchema(),
    clipboardToolSchema(),
    notifyToolSchema(),
  ];
}

/** What one call may touch — the folders connected to its conversation. */
interface FolderScope {
  /** The conversation id: approvals and jobs are kept per conversation. */
  key: string;
  roots: string[];
  /** Default working directory and base for relative paths: the first folder. */
  cwd: string;
}

export class LocalToolProvider {
  /** Browser tools — gated by their own setting, not by folders. */
  private delegate: LocalToolDelegate | null = null;
  /** main 의 공통 NotificationCenter. 주입해 Node 단위 테스트는 Electron 을 요구하지 않는다. */
  private notificationHandler: LocalNotificationHandler | null = null;
  /** 로컬 MCP 자기관리(McpAddServer/McpRemoveServer/McpListServers). 로컬 MCP 가 켜져
   *  있을 때만 도구를 광고한다 — 이 delegate 자신이 게이트를 판단한다. */
  private mcpAdmin: LocalToolDelegate | null = null;
  /** 대화 → 연결된 폴더. 호스트가 자기 장부로 답한다. 기본은 "없음". */
  private resolveFolders: LocalFolderResolver = () => [];
  private missingFolderMessage = NO_FOLDER_MESSAGE;

  /**
   * 대화별 폴더 장부를 붙인다. 폴더 도구는 호출마다 이것으로 그 대화의 폴더를
   * 찾고, 없으면 거부한다. `missingMessage` 는 폴더가 없을 때 에이전트가 받는
   * 문장 — 호스트마다 폴더를 붙이는 방법이 다르다(앱은 버튼, CLI 는 옵션).
   */
  configureFolders(
    resolver: LocalFolderResolver | null,
    options: { missingMessage?: string } = {},
  ): void {
    this.resolveFolders = resolver ?? (() => []);
    this.missingFolderMessage = options.missingMessage || NO_FOLDER_MESSAGE;
  }

  /** 폴더와 무관한 이 PC 도구(브라우저). 자기 설정으로 스스로 게이트한다. */
  configureDelegate(delegate: LocalToolDelegate | null): void {
    this.delegate = delegate;
  }

  configureNotificationHandler(handler: LocalNotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  /** 로컬 MCP 자기관리 delegate 배선(syncMcp 에서). null 이면 미노출. */
  configureMcpAdmin(admin: LocalToolDelegate | null): void {
    this.mcpAdmin = admin;
  }

  /** True iff this call frame belongs to a built-in tool (server === LOCAL_SERVER). */
  owns(server: string): boolean {
    return server === LOCAL_SERVER;
  }

  /**
   * 이 기기가 제공하는 폴더 도구의 **전체 목록**.
   *
   * 도구는 늘 카탈로그에 있다. 이번 턴에 에이전트가 무엇을 보는지는 서버가 그
   * 대화의 폴더 연결로 정하고, 호출을 실제로 허락할지는 이 제공자가 호출마다
   * 그 대화의 폴더로 다시 정한다.
   */
  catalog(): LocalToolSchema[] {
    return [localControlToolSchema(), ...folderToolSchemas()];
  }

  /** Tools advertised into the bridge catalog. */
  advertise(): LocalToolSchema[] {
    return [
      ...this.catalog(),
      ...(this.delegate?.advertise() ?? []),
      // MCP 자기관리 도구는 로컬 MCP 스위치로 게이트된다(delegate 가 스스로 판단).
      ...(this.mcpAdmin?.advertise() ?? []),
    ];
  }

  /**
   * 한 대화의 폴더 목록이 바뀌었다. 빠진 폴더에서 돌던 백그라운드 작업을 멈춘다 —
   * 연결을 끊은 폴더에서 서버나 감시 프로세스가 계속 돌면 끊은 것이 아니다.
   * 멈춘 작업 수를 돌려준다.
   */
  foldersChanged(interactionId: string): number {
    const key = String(interactionId ?? '').trim();
    if (!key) return 0;
    const roots = this.resolveFolders({ interactionId: key }).map((folder) => folder.path);
    return stopJobsOutside(key, roots);
  }

  async callTool(
    tool: string,
    args: unknown,
    context?: LocalToolCallContext,
  ): Promise<LocalToolResult> {
    if (tool === LOCAL_CONTROL_TOOL) return this.localControl(context);
    if (this.delegate?.owns(tool)) return this.delegate.callTool(tool, args, context);
    if (this.mcpAdmin?.owns(tool)) return this.mcpAdmin.callTool(tool, args);
    if (!FOLDER_TOOL_NAMES.has(tool)) throw new Error(`unknown local tool: ${tool}`);
    const scope = this.scopeFor(context);
    if (tool === SHELL_TOOL) return this.shell(args, scope);
    if (tool === SHELL_JOB_TOOL) return this.shellJob(args, scope);
    if (tool === OPEN_TOOL) return this.open(args, scope);
    if (tool === READ_FILE_TOOL) return this.readFile(args, scope);
    if (tool === WRITE_FILE_TOOL) return this.writeFile(args, scope);
    if (tool === LIST_DIR_TOOL) return this.listDir(args, scope);
    if (tool === SEARCH_TOOL) return this.search(args, scope);
    if (tool === CLIPBOARD_TOOL) return this.clipboard(args);
    return this.notify(args, context);
  }

  /** 이 호출의 대화에 연결된 폴더. 없으면 던진다 — 폴더 밖의 기본값은 없다. */
  private scopeFor(context?: LocalToolCallContext): FolderScope {
    const folders = this.resolveFolders(context);
    if (!folders.length) throw new Error(this.missingFolderMessage);
    return {
      key: context?.interactionId ?? '',
      roots: folders.map((folder) => folder.path),
      cwd: folders[0].path,
    };
  }

  /** Return what this conversation can use, including through text-only server bridges. */
  private localControl(context?: LocalToolCallContext): LocalToolResult {
    const folders = this.resolveFolders(context);
    const tools = [
      ...(folders.length ? folderToolSchemas() : []),
      ...(this.delegate?.advertise() ?? []),
      ...(this.mcpAdmin?.advertise() ?? []),
    ].filter((tool) => !tool.name.startsWith('_'));
    const inventory = {
      execution_surface: 'connector_local',
      connected_folders: folders.map((folder) => ({ name: folder.name, path: folder.path })),
      ...(folders.length
        ? { working_directory: folders[0].path }
        : {
            note:
              'No folder is connected to this conversation, so file and terminal tools are ' +
              'unavailable until the user connects one.',
          }),
      tools: tools.map((tool) => ({
        name: `mcp_local_${tool.name}`,
        description: tool.description || '',
      })),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(inventory) }],
      structuredContent: inventory,
    };
  }

  /** Resolve + symlink-aware scope-check a path against the conversation's folders. */
  private async guardPath(p: unknown, scope: FolderScope): Promise<string> {
    const abs = await resolveWithinRootsReal(resolveOne(String(p ?? ''), scope.cwd), scope.roots);
    if (!abs) {
      throw new Error(
        `[PATH_DOMAIN_MISMATCH] 이 대화에 연결된 폴더 밖의 경로입니다: ${String(p ?? '')} ` +
          `(연결된 폴더: ${scope.roots.join(', ')}).`,
      );
    }
    return abs;
  }

  private async readFile(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = await this.guardPath(a.path, scope);
    const maxBytes = Math.max(1, Math.min(OUTPUT_CAP, Number(a.maxBytes) || OUTPUT_CAP));
    try {
      const buf = await fsReadFile(abs);
      const text = buf.subarray(0, maxBytes).toString('utf8');
      const suffix =
        buf.byteLength > maxBytes ? `\n…(truncated, ${buf.byteLength} bytes total)` : '';
      return { content: [{ type: 'text', text: (text || '(empty file)') + suffix }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `읽기 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async writeFile(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = await this.guardPath(a.path, scope);
    const content = typeof a.content === 'string' ? a.content : String(a.content ?? '');
    const append = a.mode === 'append' || a.append === true;
    try {
      await mkdir(dirname(abs), { recursive: true });
      // Re-check after mkdir so an existing parent symlink cannot carry the
      // write outside an allowed root.
      if (!(await resolveWithinRootsReal(dirname(abs), scope.roots))) {
        throw new Error('[PATH_DOMAIN_MISMATCH] 생성된 상위 폴더가 허용 범위 밖입니다.');
      }
      if (append) await fsAppendFile(abs, content, 'utf8');
      else await fsWriteFile(abs, content, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: `${append ? '이어썼습니다' : '저장했습니다'}: ${abs} (${Buffer.byteLength(content)} bytes)`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `쓰기 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async listDir(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = await this.guardPath(a.path ?? '', scope);
    try {
      const names = await readdir(abs);
      const rows: string[] = [];
      for (const name of names.slice(0, 1000)) {
        try {
          const s = await stat(pathJoin(abs, name));
          rows.push(`${s.isDirectory() ? 'd' : '-'} ${String(s.size).padStart(10)}  ${name}`);
        } catch {
          rows.push(`?          ?  ${name}`);
        }
      }
      const more = names.length > 1000 ? `\n…(${names.length} entries, first 1000 shown)` : '';
      return { content: [{ type: 'text', text: rows.join('\n') + more || '(empty directory)' }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `목록 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async search(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const query = String(a.query ?? '');
    if (!query) throw new Error('query must not be empty');
    const abs = await this.guardPath(a.path ?? '', scope);
    const maxResults = Math.max(1, Math.min(500, Number(a.maxResults) || 100));
    const hits: string[] = [];
    const skipDirs = new Set([
      'node_modules',
      '.git',
      '.venv',
      'dist',
      'out',
      '.next',
      '__pycache__',
    ]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (hits.length >= maxResults || depth > 8) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= maxResults) return;
        const full = pathJoin(dir, name);
        let s;
        try {
          s = await lstat(full);
        } catch {
          continue;
        }
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          if (!skipDirs.has(name) && !name.startsWith('.')) await walk(full, depth + 1);
        } else if (s.size <= 2_000_000 && !BINARY_EXT.has(extname(name).toLowerCase())) {
          try {
            const text = await fsReadFile(full, 'utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= maxResults) return;
              }
            }
          } catch {
            /* unreadable/binary — skip */
          }
        }
      }
    };
    await walk(abs, 0);
    return {
      content: [
        {
          type: 'text',
          text: hits.length ? hits.join('\n') : `'${query}' 를 찾지 못했습니다 (${abs}).`,
        },
      ],
    };
  }

  private async clipboard(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const action = String(a.action ?? 'read');
    const clip = interaction().clipboard;
    if (!clip) {
      return {
        content: [{ type: 'text', text: '이 호스트에서는 클립보드를 쓸 수 없습니다.' }],
        isError: true,
      };
    }
    try {
      if (action === 'write') {
        await clip.write(String(a.text ?? ''));
        return { content: [{ type: 'text', text: '클립보드에 복사했습니다.' }] };
      }
      const text = await clip.read();
      return { content: [{ type: 'text', text: text || '(클립보드가 비어 있습니다)' }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `클립보드 접근 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async notify(args: unknown, context?: LocalToolCallContext): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const title = String(a.title ?? 'XGEN');
    const body = String(a.body ?? '');
    try {
      if (this.notificationHandler) {
        const shown = await this.notificationHandler(title, body, context);
        return {
          content: [
            {
              type: 'text',
              text: shown
                ? '알림을 표시했습니다.'
                : '사용자의 알림 설정에 따라 표시하지 않았습니다.',
            },
          ],
        };
      }
      const notify = interaction().notify;
      if (!notify) {
        return {
          content: [{ type: 'text', text: '이 호스트에서는 알림을 표시할 수 없습니다.' }],
          isError: true,
        };
      }
      const shown = await notify(title, body);
      return {
        content: [
          { type: 'text', text: shown ? '알림을 표시했습니다.' : '알림이 표시되지 않았습니다.' },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `알림 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async shell(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const { command, cwd, shell, timeoutMs, backgroundAfterMs, background } = coerceShellArgs(args);
    if (!command.trim()) throw new Error('command must not be empty');
    const runCwd = await resolveWithinRootsReal(resolveOne(cwd || scope.cwd, scope.cwd), scope.roots);
    if (!runCwd) {
      throw new Error(
        `[PATH_DOMAIN_MISMATCH] 작업 폴더가 이 대화에 연결된 폴더 밖입니다: ${cwd}. ` +
          `연결된 폴더 안에서 실행하세요 (${scope.roots.join(', ')}).`,
      );
    }
    // 되돌리기 어려운 명령은 사용자 승인을 받는다 (위험 패턴만 — 일반 명령은 확인 없이).
    if (!(await ensureDangerousApproval(command, scope.key))) {
      return {
        content: [
          { type: 'text', text: DANGEROUS_COMMAND_DENIED },
        ],
        isError: true,
      };
    }
    const userShellBin = IS_WIN ? null : process.env.SHELL || null;
    const { file, args: argv } = shellInvocation(command, userShellBin, shell);
    const launch = (await workspaceShellSupported())
      ? await this.confinedLaunch(file, argv, runCwd, scope)
      : // 이 OS 에는 쓸 수 있는 가두기 수단이 없다(Windows, 네임스페이스를 못 만드는
        // Linux). 사용자 권한으로 돌리되 작업 폴더는 연결된 폴더 안으로 고정한다.
        { file, args: argv, env: buildChildEnv(await augmentedPath()), cleanup: async () => {} };
    const owner = { key: scope.key, roots: scope.roots };

    if (background) {
      return this.spawnBackground(
        command, launch.file, launch.args, launch.env, runCwd, owner, undefined, launch.cleanup,
      );
    }

    const timeout = Math.max(
      MIN_TIMEOUT_MS,
      Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs || DEFAULT_TIMEOUT_MS)),
    );
    const autoBackgroundAfter = backgroundAfterMs ?? AUTO_BACKGROUND_AFTER_MS;
    if (timeout > autoBackgroundAfter) {
      return this.spawnBackground(
        command,
        launch.file,
        launch.args,
        launch.env,
        runCwd,
        owner,
        { autoAfterMs: autoBackgroundAfter, maxRuntimeMs: timeout },
        launch.cleanup,
      );
    }
    const r = await this.spawnCapture(launch.file, launch.args, launch.env, runCwd, timeout).finally(
      launch.cleanup,
    );
    if (r.error)
      return {
        content: [{ type: 'text', text: `셸 실행 실패: ${r.error.message}` }],
        isError: true,
      };
    if (r.timedOut) {
      return {
        content: [
          {
            type: 'text',
            text:
              `명령이 ${Math.round(timeout / 1000)}초 안에 끝나지 않아 중단했습니다. ` +
              `대화형 명령이거나 종료되지 않는 프로그램(에디터·서버 등)이면 background:true 로 실행하세요.` +
              (r.stdout || r.stderr
                ? `\n\n--- 중단 전 출력 ---\n${(r.stdout + '\n' + r.stderr).trim().slice(-2000)}`
                : ''),
          },
        ],
        isError: true,
      };
    }
    // Optional output paging (G13): head/tail lines + max_bytes cap. Tail-biased
    // so a caller asking to "see the end" of a chatty command gets the tail.
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const head = Number(a.head) || 0;
    const tail = Number(a.tail) || 0;
    const maxBytes = Number(a.max_bytes ?? a.maxBytes) || 0;
    if (head || tail || maxBytes) {
      const outP = paginate(r.stdout, { head, tail, maxBytes });
      const errP = paginate(r.stderr, { head, tail, maxBytes });
      return shapeResult(outP.text, errP.text, r.code, r.signal);
    }
    return shapeResult(r.stdout, r.stderr, r.code, r.signal);
  }

  /**
   * Launch confined to the conversation's folders (macOS sandbox-exec / Linux
   * bubblewrap). Login startup files are not run just to discover PATH; common
   * binary folders and the user's toolchains (nvm, pyenv, cargo, …) are added
   * as data, read-only.
   */
  private async confinedLaunch(
    file: string,
    argv: string[],
    runCwd: string,
    scope: FolderScope,
  ): Promise<{ file: string; args: string[]; env: Record<string, string>; cleanup: () => Promise<void> }> {
    const toolchains = await userToolchains();
    const pathStr = [...toolchains.bins, process.env.PATH || '', ...commonBinDirs()]
      .filter(Boolean)
      .join(delimiter);
    const env = { ...buildChildEnv(pathStr), ...toolchains.env, ...(await gitIdentityEnv()) };
    const roots = (
      await Promise.all(scope.roots.map((root) => realpath(root).catch(() => null)))
    ).filter((root): root is string => root !== null);
    return prepareWorkspaceShell(file, argv, env, runCwd, roots, toolchains.mounts);
  }

  private async open(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const { target } = coerceOpenArgs(args);
    if (!target.trim()) throw new Error('target must not be empty');
    // G9: validate scheme (block javascript:/data:/vbscript:/unknown) and use
    // Electron's shell API — no shell string, so no cmd.exe arg-injection.
    const cls = classifyOpenTarget(target);
    if (cls.kind === 'blocked') {
      return { content: [{ type: 'text', text: `열 수 없습니다: ${cls.reason}` }], isError: true };
    }
    const host = interaction();
    if (!host.openExternal && !host.openPath) {
      return {
        content: [{ type: 'text', text: '이 호스트에서는 외부 열기를 지원하지 않습니다.' }],
        isError: true,
      };
    }
    try {
      if (cls.kind === 'url') {
        if (!host.openExternal) {
          return {
            content: [{ type: 'text', text: '이 호스트에서는 링크를 열 수 없습니다.' }],
            isError: true,
          };
        }
        await boundedOpen(host.openExternal(cls.value).then(() => ''));
        return { content: [{ type: 'text', text: `열었습니다: ${cls.value}` }] };
      }
      // Filesystem path — scope to the connected folders (like the file tools), then
      // open with the OS default app. guardPath throws (caught below) if out of scope.
      const abs = await this.guardPath(cls.value, scope);
      if (!host.openPath) {
        return {
          content: [{ type: 'text', text: '이 호스트에서는 파일을 열 수 없습니다.' }],
          isError: true,
        };
      }
      // 안전망: 호스트 구현이 "연 앱의 종료"를 기다리는 부류(과거 shell.openPath,
      // 옛 CLI run)여도 도구 호출이 120s MCP 타임아웃까지 끌려가 실패로 보고되면
      // 안 된다 — 창을 넘기면 앱은 이미 떴다고 보고 성공으로 확정한다.
      const err = await boundedOpen(host.openPath(abs)); // '' on success, else message
      if (err) return { content: [{ type: 'text', text: `열기 실패: ${err}` }], isError: true };
      return { content: [{ type: 'text', text: `열었습니다: ${abs}` }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `열기 실패: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  /** Foreground: capture output, close stdin (no interactive hang), tree-kill on timeout. */
  private spawnCapture(
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
  ): Promise<SpawnCaptured> {
    // POSIX: run in its own process group so the timeout can reap the whole tree.
    const detachedGroup = !IS_WIN;
    return new Promise<SpawnCaptured>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, argv, {
          cwd: cwd || homedir(),
          env,
          windowsHide: true,
          detached: detachedGroup,
          // stdin IGNORED → interactive programs get EOF immediately instead of
          // blocking to the timeout (the "대화형 쉘 타임아웃" report).
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: null, signal: null, stdout: '', stderr: '', error: e as Error });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      const finish = (r: SpawnCaptured) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        killTree(child, detachedGroup);
        finish({ code: null, signal: 'SIGKILL', stdout: out, stderr: err, timedOut: true });
      }, timeoutMs);
      child.stdout?.on('data', (d) => {
        out += String(d);
        if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
        if (err.length > OUTPUT_CAP * 2) err = err.slice(-OUTPUT_CAP * 2);
      });
      child.on('error', (e) =>
        finish({ code: null, signal: null, stdout: out, stderr: err, error: e }),
      );
      child.on('close', (code, signal) => finish({ code, signal, stdout: out, stderr: err }));
    });
  }

  /** Background: detached, output captured into the job registry, returns a
   *  job_id at once. The process keeps running past any tool-call timeout; poll
   *  or kill it later with the ShellJob tool. */
  private spawnBackground(
    command: string,
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    owner: { key: string; roots: string[] },
    options?: { autoAfterMs: number; maxRuntimeMs: number },
    cleanup: () => Promise<void> = async () => {},
  ): Promise<LocalToolResult> {
    const detachedGroup = !IS_WIN;
    return new Promise<LocalToolResult>((resolve) => {
      // Bound concurrent background jobs so a runaway loop can't accumulate live
      // processes/pipe FDs without limit (finished jobs are evicted separately).
      const running = [...bgJobs.values()].filter((j) => j.status === 'running').length;
      if (running >= MAX_RUNNING_JOBS) {
        void cleanup();
        resolve({
          content: [
            {
              type: 'text',
              text: `실행 중인 백그라운드 작업이 너무 많습니다 (${running}/${MAX_RUNNING_JOBS}). ShellJob(action:'list')로 확인하고 kill 로 정리한 뒤 다시 시도하세요.`,
            },
          ],
          isError: true,
        });
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(file, argv, {
          cwd: cwd || homedir(),
          env,
          windowsHide: true,
          detached: detachedGroup,
          // Capture output (so it can be polled) but close stdin so REPLs don't hang.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        void cleanup();
        resolve({
          content: [
            {
              type: 'text',
              text: `백그라운드 실행 실패: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        });
        return;
      }
      const job: BgJob = {
        id: newJobId(),
        owner: owner.key,
        roots: [...owner.roots],
        command,
        pid: child.pid,
        child,
        detachedGroup,
        status: 'running',
        code: null,
        signal: null,
        startedAt: Date.now(),
        stdout: '',
        stderr: '',
      };
      bgJobs.set(job.id, job);
      evictFinishedJobs();

      child.stdout?.on('data', (d) => {
        job.stdout = appendCapped(job.stdout, String(d));
      });
      child.stderr?.on('data', (d) => {
        job.stderr = appendCapped(job.stderr, String(d));
      });

      let settled = false;
      // Exited within the grace: the foreground result is on its way.
      let finishing = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: LocalToolResult) => {
        if (settled) return;
        settled = true;
        if (settleTimer) clearTimeout(settleTimer);
        resolve(r);
      };
      child.on('error', (e) => {
        void cleanup();
        if (job.status === 'running') {
          job.status = 'error';
          job.errorMsg = e.message;
          job.endedAt = Date.now();
        }
        if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
        if (options && !settled) bgJobs.delete(job.id);
        done({
          content: [{ type: 'text', text: `백그라운드 실행 실패: ${e.message}` }],
          isError: true,
        });
      });
      child.on('close', (code, signal) => {
        const cleaned = cleanup();
        // Always record the real exit code/signal (even for a job we killed, so
        // list/poll can show it); only transition status if still running.
        job.code = code;
        job.signal = signal;
        if (job.status === 'running') {
          job.status = signal ? 'killed' : 'exited';
          job.endedAt = Date.now();
        } else if (!job.endedAt) {
          job.endedAt = Date.now();
        }
        if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
        // Automatic foreground conversion preserves the ordinary foreground
        // result when the command finishes within the grace period. The result
        // waits for the scratch folder to be removed — otherwise it is still
        // sitting in the user's folder when the agent looks.
        if (!settled && (options || code !== 0 || signal)) {
          finishing = true;
          bgJobs.delete(job.id);
          const result = shapeResult(job.stdout, job.stderr, code, signal);
          void cleaned.then(() => done(result));
        }
      });
      // Don't let the piped child keep the connector's event loop alive on quit —
      // unref the process AND its stdout/stderr sockets (the pipes hold the loop).
      child.unref();
      (child.stdout as unknown as { unref?: () => void })?.unref?.();
      (child.stderr as unknown as { unref?: () => void })?.unref?.();
      if (options) {
        maxRuntimeTimer = setTimeout(() => {
          if (job.status !== 'running') return;
          job.status = 'killed';
          job.errorMsg = `maximum runtime ${options.maxRuntimeMs}ms exceeded`;
          job.endedAt = Date.now();
          killTree(child, detachedGroup);
        }, options.maxRuntimeMs);
      }
      // Explicit background returns after a short spawn-settle grace. Automatic
      // mode waits longer, then hands the still-running process to ShellJob.
      const settleMs = options?.autoAfterMs ?? BG_SETTLE_MS;
      settleTimer = setTimeout(() => {
        if (finishing) return;
        const automatic = !!options;
        done({
          content: [
            {
              type: 'text',
              text:
                `${automatic ? '명령이 계속 실행 중이어서 자동으로 백그라운드 작업으로 전환했습니다.' : '백그라운드 작업을 시작했습니다.'}\n` +
                `job_id: ${job.id}  (pid ${job.pid ?? '?'})\n` +
                `계속 실행되며 출력이 캡처됩니다. 상태·출력은 ShellJob(action:'poll', job_id) 로, ` +
                `종료는 ShellJob(action:'kill', job_id) 로 확인/제어하세요.`,
            },
          ],
          structuredContent: {
            status: 'running',
            job_id: job.id,
            pid: job.pid,
            execution_surface: 'connector_local',
            path_domain: 'physical_local',
            automatic,
          },
        });
      }, settleMs);
    });
  }

  /** ShellJob: manage background jobs — list / poll (status+output) / kill. */
  private async shellJob(args: unknown, scope: FolderScope): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const action = String(a.action ?? 'list').toLowerCase();
    const jobId = String(a.job_id ?? a.jobId ?? '').trim();
    // 이 대화가 시작한 작업만 보인다 — 다른 대화의 작업을 엿보거나 끌 수 없다.
    const mine = [...bgJobs.values()].filter((job) => job.owner === scope.key);

    if (action === 'list') {
      if (!mine.length)
        return {
          content: [
            { type: 'text', text: '실행 중이거나 최근 종료된 백그라운드 작업이 없습니다.' },
          ],
        };
      const rows = mine
        .sort((x, y) => y.startedAt - x.startedAt)
        .map((j) => {
          const dur = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
          const exit = j.status === 'running' ? '' : ` exit=${j.signal ? j.signal : j.code}`;
          return `${j.id}  [${j.status}${exit}]  pid=${j.pid ?? '?'}  ${dur}s  ${j.command.slice(0, 80)}`;
        });
      return {
        content: [{ type: 'text', text: rows.join('\n') }],
        structuredContent: {
          execution_surface: 'connector_local',
          path_domain: 'physical_local',
          jobs: mine.map((job) => ({
            id: job.id,
            status: job.status,
          })),
        },
      };
    }

    const job = jobId ? mine.find((candidate) => candidate.id === jobId) : undefined;
    if (!job) {
      return {
        content: [
          {
            type: 'text',
            text: `job_id '${jobId}' 를 찾지 못했습니다. ShellJob(action:'list') 로 확인하세요.`,
          },
        ],
        isError: true,
      };
    }

    if (action === 'kill') {
      if (job.status === 'running') {
        killTree(job.child, job.detachedGroup);
        job.status = 'killed';
        job.endedAt = Date.now();
      }
      return {
        content: [
          { type: 'text', text: `작업 ${job.id} 을(를) 종료했습니다 (상태: ${job.status}).` },
        ],
        structuredContent: {
          execution_surface: 'connector_local',
          path_domain: 'physical_local',
          job_id: job.id,
          status: job.status,
        },
      };
    }

    // poll / logs — status + captured output (paginated).
    if (action === 'poll' || action === 'logs') {
      const head = Number(a.head) || 0;
      const tail = Number(a.tail) || (head ? 0 : 200); // default: last 200 lines
      const maxBytes = Number(a.max_bytes ?? a.maxBytes) || 0;
      const outP = paginate(job.stdout, { head, tail, maxBytes });
      const errP = paginate(job.stderr, { head, tail, maxBytes });
      const dur = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
      const header =
        `job ${job.id} — ${job.status}` +
        (job.status !== 'running' ? ` (exit ${job.signal ? job.signal : job.code})` : '') +
        `  pid=${job.pid ?? '?'}  ${dur}s`;
      const parts = [header];
      if (job.errorMsg) parts.push(`ERROR: ${job.errorMsg}`);
      parts.push(
        `--- stdout${outP.truncated ? ` (last, ${outP.totalBytes}B total)` : ''} ---\n${outP.text || '(none)'}`,
      );
      if (errP.text.trim() || errP.totalBytes) {
        parts.push(
          `--- stderr${errP.truncated ? ` (last, ${errP.totalBytes}B total)` : ''} ---\n${errP.text || '(none)'}`,
        );
      }
      return {
        content: [{ type: 'text', text: parts.join('\n\n') }],
        isError: job.status === 'error',
        structuredContent: {
          execution_surface: 'connector_local',
          path_domain: 'physical_local',
          job_id: job.id,
          status: job.status,
          exit_code: job.code,
          signal: job.signal,
        },
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `알 수 없는 action '${action}'. list | poll | kill 중 하나를 쓰세요.`,
        },
      ],
      isError: true,
    };
  }
}

let _provider: LocalToolProvider | null = null;
export function getLocalToolProvider(): LocalToolProvider {
  if (!_provider) _provider = new LocalToolProvider();
  return _provider;
}
