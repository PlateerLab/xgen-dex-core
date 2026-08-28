import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { DexError } from './errors';
import type { LocalToolsConfig } from './types';

export const LOCAL_TOOL_SERVER = 'local';
export const LOCAL_TOOL_NAMES = ['Shell', 'ReadFile', 'WriteFile', 'ListDir', 'Search', 'Open'] as const;
export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];

export interface LocalToolSchema {
  name: LocalToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LocalToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const OUTPUT_CAP = 200_000;
const WRITE_CAP_BYTES = 2_000_000;
const COMMAND_CAP_CHARS = 32_000;
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bin',
  '.class',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.tar',
  '.wav',
  '.webp',
  '.xlsx',
  '.zip',
]);
const DANGEROUS_COMMANDS = [
  /\brm\s+-[a-z]*[rf]/i,
  /(^|[;&|`(])\s*rm\s+\//i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\b(mkfs|fdisk|format)\b/i,
  /\bdd\b[^\n]*\b(of|if)=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/,
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\bsudo\s+rm\b/i,
];

export function localToolSchemas(): LocalToolSchema[] {
  return [
    {
      name: 'Shell',
      description:
        "Run one non-interactive command on the USER'S LOCAL COMPUTER in the configured working directory. " +
        'Use for builds, tests, git, and project automation. Destructive commands may be refused by policy.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          cwd: { type: 'string', description: 'Working directory inside an allowed root.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
        },
        required: ['command'],
      },
    },
    {
      name: 'ReadFile',
      description: "Read a UTF-8 text file from the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxBytes: { type: 'integer', minimum: 1, maximum: OUTPUT_CAP },
        },
        required: ['path'],
      },
    },
    {
      name: 'WriteFile',
      description: "Create, replace, or append a UTF-8 file on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          mode: { type: 'string', enum: ['overwrite', 'append'] },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'ListDir',
      description: "List a directory on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
    {
      name: 'Search',
      description: "Search UTF-8 project files on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          query: { type: 'string' },
          maxResults: { type: 'integer', minimum: 1, maximum: 500 },
          caseSensitive: { type: 'boolean' },
        },
        required: ['query'],
      },
    },
    {
      name: 'Open',
      description:
        "Open an http(s) URL, file, or folder on the USER'S LOCAL COMPUTER with the operating system default app. " +
        'Filesystem targets must be inside an allowed root.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
    },
  ];
}

export function normalizeLocalToolsConfig(
  value: LocalToolsConfig,
  fallbackCwd = process.cwd(),
): LocalToolsConfig {
  const cwd = expandPath(value.cwd || fallbackCwd, fallbackCwd);
  const roots = (value.allowedRoots.length ? value.allowedRoots : [cwd]).map((root) => expandPath(root, cwd));
  return {
    enabled: value.enabled === true,
    cwd,
    timeoutMs: Math.max(1_000, Math.min(3_600_000, Math.round(value.timeoutMs || 120_000))),
    allowedRoots: [...new Set(roots)],
    blockedCommands: [...new Set(value.blockedCommands.map((item) => firstToken(item)).filter(Boolean))],
    allowDangerous: value.allowDangerous === true,
  };
}

export function firstToken(command: string): string {
  const match = String(command || '')
    .trim()
    .match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const raw = (match && (match[1] || match[2] || match[3])) || '';
  return basename(raw).replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLocaleLowerCase();
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}

export class LocalToolProvider {
  private config: LocalToolsConfig;

  constructor(config: LocalToolsConfig) {
    this.config = normalizeLocalToolsConfig(config);
  }

  configure(config: LocalToolsConfig): void {
    this.config = normalizeLocalToolsConfig(config);
  }

  schemas(): LocalToolSchema[] {
    return this.config.enabled ? localToolSchemas() : [];
  }

  async call(tool: string, args: unknown): Promise<LocalToolResult> {
    if (!this.config.enabled) throw new DexError('local_tools_disabled', '로컬 도구가 꺼져 있습니다.');
    if (!LOCAL_TOOL_NAMES.includes(tool as LocalToolName)) {
      throw new DexError('not_found', `지원하지 않는 로컬 도구입니다: ${tool}`);
    }
    if (tool === 'Shell') return this.shell(args);
    if (tool === 'ReadFile') return this.readFile(args);
    if (tool === 'WriteFile') return this.writeFile(args);
    if (tool === 'ListDir') return this.listDir(args);
    if (tool === 'Search') return this.search(args);
    return this.open(args);
  }

  private objectArgs(args: unknown): Record<string, unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    return args as Record<string, unknown>;
  }

  private async scopedPath(input: unknown, defaultPath = this.config.cwd): Promise<string> {
    const raw = String(input ?? defaultPath).trim();
    if (!raw) throw new DexError('usage_error', '로컬 경로가 필요합니다.');
    const candidate = expandPath(raw, this.config.cwd);
    const roots = await Promise.all(this.config.allowedRoots.map((root) => canonicalCandidate(root)));
    const canonical = await canonicalCandidate(candidate);
    if (!roots.some((root) => inside(root, canonical))) {
      throw new DexError(
        'local_path_denied',
        `허용된 로컬 경로 범위를 벗어났습니다: ${candidate}`,
        { allowedRoots: this.config.allowedRoots },
      );
    }
    return candidate;
  }

  private async readFile(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path);
    const maxBytes = Math.max(1, Math.min(OUTPUT_CAP, Number(input.maxBytes) || OUTPUT_CAP));
    const bytes = await readFile(path);
    const text = bytes.subarray(0, maxBytes).toString('utf8');
    const suffix = bytes.byteLength > maxBytes ? `\n…(truncated, ${bytes.byteLength} bytes total)` : '';
    return result((text || '(empty file)') + suffix);
  }

  private async writeFile(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path);
    const content = typeof input.content === 'string' ? input.content : String(input.content ?? '');
    const contentBytes = Buffer.byteLength(content);
    if (contentBytes > WRITE_CAP_BYTES) {
      throw new DexError('usage_error', `한 번에 저장할 수 있는 크기는 ${WRITE_CAP_BYTES} bytes 이하입니다.`);
    }
    await mkdir(dirname(path), { recursive: true });
    if (input.mode === 'append') await appendFile(path, content, 'utf8');
    else await writeFile(path, content, 'utf8');
    return result(`${input.mode === 'append' ? '이어썼습니다' : '저장했습니다'}: ${path} (${contentBytes} bytes)`);
  }

  private async listDir(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path, this.config.cwd);
    const entries = await readdir(path, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries.slice(0, 1_000)) {
      const fullPath = join(path, entry.name);
      const info = await stat(fullPath).catch(() => undefined);
      rows.push(`${entry.isDirectory() ? 'd' : '-'} ${String(info?.size ?? '?').padStart(10)}  ${entry.name}`);
    }
    if (entries.length > rows.length) rows.push(`…(${entries.length} entries, first ${rows.length} shown)`);
    return result(rows.join('\n') || '(empty directory)');
  }

  private async search(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const rawQuery = String(input.query ?? '');
    if (!rawQuery) throw new DexError('usage_error', 'Search 도구에는 query가 필요합니다.');
    const root = await this.scopedPath(input.path, this.config.cwd);
    const maxResults = Math.max(1, Math.min(500, Number(input.maxResults) || 100));
    const caseSensitive = input.caseSensitive === true;
    const query = caseSensitive ? rawQuery : rawQuery.toLocaleLowerCase();
    const hits: string[] = [];
    const skipped = new Set(['.git', '.next', '.venv', '__pycache__', 'dist', 'node_modules', 'out']);
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (hits.length >= maxResults || depth > 10) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (hits.length >= maxResults) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name) && !entry.name.startsWith('.')) await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile() || BINARY_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) continue;
        const info = await stat(path).catch(() => undefined);
        if (!info || info.size > 2_000_000) continue;
        const content = await readFile(path, 'utf8').catch(() => undefined);
        if (content === undefined) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
          if (haystack.includes(query)) hits.push(`${path}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        }
      }
    };
    await visit(root, 0);
    return result(hits.join('\n') || `'${rawQuery}' 검색 결과가 없습니다 (${root}).`);
  }

  private async shell(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const command = String(input.command ?? '').trim();
    if (!command) throw new DexError('usage_error', 'Shell 도구에는 command가 필요합니다.');
    if (command.length > COMMAND_CAP_CHARS) throw new DexError('usage_error', 'Shell command가 너무 깁니다.');
    const token = firstToken(command);
    if (this.config.blockedCommands.includes(token)) {
      throw new DexError('local_command_denied', `차단된 명령입니다: ${token}`);
    }
    if (!this.config.allowDangerous && isDangerousCommand(command)) {
      throw new DexError(
        'local_command_denied',
        '되돌리기 어려운 명령 패턴이 감지되어 실행하지 않았습니다. 필요하면 allowDangerous 설정을 명시적으로 켜세요.',
      );
    }
    const cwd = await this.scopedPath(input.cwd, this.config.cwd);
    const timeoutMs = Math.max(
      1_000,
      Math.min(3_600_000, Math.round(Number(input.timeoutMs) || this.config.timeoutMs)),
    );
    const invocation = shellInvocation(command);
    const captured = await captureProcess(invocation.file, invocation.args, cwd, timeoutMs);
    if (captured.error) throw new DexError('local_tool_failed', captured.error.message);
    const sections: string[] = [];
    if (captured.stdout.trim()) sections.push(captured.stdout.trimEnd());
    if (captured.stderr.trim()) sections.push(`STDERR:\n${captured.stderr.trimEnd()}`);
    if (captured.timedOut) sections.push(`(${Math.round(timeoutMs / 1000)}초 제한으로 종료됨)`);
    else if (captured.signal) sections.push(`(signal ${captured.signal})`);
    else if (captured.code !== 0) sections.push(`(exit code ${captured.code})`);
    return {
      content: [{ type: 'text', text: sections.join('\n\n') || '(no output)' }],
      ...(captured.timedOut || captured.signal || captured.code !== 0 ? { isError: true } : {}),
    };
  }

  private async open(args: unknown): Promise<LocalToolResult> {
    const input = this.objectArgs(args);
    const target = String(input.target ?? '').trim();
    if (!target) throw new DexError('usage_error', 'Open 도구에는 target이 필요합니다.');
    let resolvedTarget = target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const url = new URL(target);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new DexError('local_open_denied', `허용하지 않는 URL scheme입니다: ${url.protocol}`);
      }
    } else {
      resolvedTarget = await this.scopedPath(target);
    }
    const invocation = openerInvocation(resolvedTarget);
    await spawnDetached(invocation.file, invocation.args);
    return result(`열었습니다: ${resolvedTarget}`);
  }
}

function result(text: string): LocalToolResult {
  return { content: [{ type: 'text', text }] };
}

function expandPath(value: string, base: string): string {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : resolve(base, expanded));
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function canonicalCandidate(path: string): Promise<string> {
  let cursor = path;
  const tail: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return path;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (platform() === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  const configured = String(process.env.SHELL || '').trim();
  return { file: configured.startsWith('/') ? configured : 'bash', args: ['-lc', command] };
}

function openerInvocation(target: string): { file: string; args: string[] } {
  if (platform() === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', target] };
  if (platform() === 'darwin') return { file: 'open', args: [target] };
  return { file: 'xdg-open', args: [target] };
}

interface CapturedProcess {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  error?: Error;
}

function captureProcess(file: string, args: string[], cwd: string, timeoutMs: number): Promise<CapturedProcess> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        detached: platform() !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done({ stdout: '', stderr: '', code: null, signal: null, error: error as Error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: CapturedProcess): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = capped(stdout + String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr = capped(stderr + String(chunk));
    });
    child.once('error', (error) => finish({ stdout, stderr, code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ stdout, stderr, code, signal }));
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ stdout, stderr, code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
  });
}

function capped(value: string): string {
  return value.length > OUTPUT_CAP ? `${value.slice(-OUTPUT_CAP)}\n…(truncated)` : value;
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (platform() === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}
