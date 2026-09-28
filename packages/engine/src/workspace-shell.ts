/** OS-enforced filesystem scope for commands on the client PC.
 * This is separate from the agent's server sandbox.
 *
 * Whether confinement is used is decided ONCE per process by a probe
 * ({@link workspaceShellSupported}), never per command: a command the
 * confinement rejects is never retried unrestricted. Where the OS offers no
 * usable mechanism (Windows; Linux whose bubblewrap cannot create namespaces,
 * e.g. Ubuntu 24.04's AppArmor default), commands run as the user with the
 * working directory inside a connected folder.
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface WorkspaceShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

// Read-only OS/toolchain paths needed to load shells, interpreters and libraries.
// Do not grant /System as a whole: /System/Volumes/Data also contains user data.
const MAC_RUNTIME_DIRS = [
  '/bin',
  '/sbin',
  '/usr',
  '/System/Library',
  '/System/Volumes/Preboot',
  '/Library/Apple',
  '/Library/Developer',
  '/Library/Frameworks',
  '/opt/homebrew',
  '/opt/local',
  '/private/var/db/timezone',
];
const LINUX_RUNTIME_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
const SYSTEM_FILES = [
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/localtime',
  '/etc/protocols',
  '/etc/services',
  '/etc/ld.so.cache',
];

async function existing(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((p) => realpath(p).catch(() => null)));
  return [...new Set(resolved.filter((p): p is string => p !== null))];
}

const LAUNCHER = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
const PROBE_TIMEOUT_MS = 5_000;
let supportProbe: Promise<boolean> | null = null;

function probeBubblewrap(): Promise<boolean> {
  // The same namespace flags the real launch uses — a bwrap that exists but
  // cannot create user namespaces fails here, not on the user's command.
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(false);
    }, PROBE_TIMEOUT_MS);
    const child = spawn(
      LAUNCHER,
      ['--die-with-parent', '--unshare-all', '--share-net', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', 'true'],
      { stdio: 'ignore' },
    );
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Can commands be confined to the connected folders on this OS?
 * macOS: sandbox-exec present. Linux: bubblewrap present AND able to create
 * its namespaces. Windows: no. Cached for the process lifetime.
 */
export function workspaceShellSupported(): Promise<boolean> {
  if (!supportProbe) {
    supportProbe = (async () => {
      if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
      try {
        await access(LAUNCHER, constants.X_OK);
      } catch {
        return false;
      }
      return process.platform === 'darwin' ? true : probeBubblewrap();
    })();
  }
  return supportProbe;
}

/** Tests only — force the probe result (`null` re-probes). */
export function setWorkspaceShellSupportForTest(value: boolean | null): void {
  supportProbe = value === null ? null : Promise.resolve(value);
}

/**
 * Developer toolchains installed under the user's home. The confined shell
 * does not mount home, so without these `node` from nvm or `python` from
 * pyenv would not start. Read-only; the `env` entries point each manager at
 * its real (read-only) root because HOME is a scratch folder inside the shell.
 */
const HOME_TOOLCHAINS: Array<{ dir: string; bins?: string[]; env?: string }> = [
  { dir: '.local/bin', bins: ['.local/bin'] },
  { dir: '.local/share/uv' },
  { dir: '.local/share/pipx' },
  { dir: '.local/share/pnpm', bins: ['.local/share/pnpm'] },
  { dir: '.local/share/mise', bins: ['.local/share/mise/shims'], env: 'MISE_DATA_DIR' },
  { dir: '.cargo/bin', bins: ['.cargo/bin'] },
  { dir: '.rustup', env: 'RUSTUP_HOME' },
  { dir: '.bun', bins: ['.bun/bin'] },
  { dir: '.deno', bins: ['.deno/bin'] },
  { dir: '.nvm/versions' },
  { dir: '.volta', bins: ['.volta/bin'], env: 'VOLTA_HOME' },
  { dir: '.pyenv', bins: ['.pyenv/shims', '.pyenv/bin'], env: 'PYENV_ROOT' },
  { dir: '.rbenv', bins: ['.rbenv/shims', '.rbenv/bin'], env: 'RBENV_ROOT' },
  { dir: '.nodenv', bins: ['.nodenv/shims', '.nodenv/bin'], env: 'NODENV_ROOT' },
  { dir: '.asdf', bins: ['.asdf/shims', '.asdf/bin'], env: 'ASDF_DATA_DIR' },
  { dir: 'go/bin', bins: ['go/bin'] },
];

/** Newest nvm-installed node's bin directory, if any. */
async function nvmNodeBin(home: string): Promise<string | null> {
  const fromEnv = process.env.NVM_BIN;
  if (fromEnv && fromEnv.startsWith(join(home, '.nvm'))) return fromEnv;
  const versions = join(home, '.nvm', 'versions', 'node');
  const names = await readdir(versions).catch(() => [] as string[]);
  const parse = (name: string) => name.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const newest = names
    .filter((name) => /^v\d+/.test(name))
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    })[0];
  return newest ? join(versions, newest, 'bin') : null;
}

export interface UserToolchains {
  /** Read-only directories to expose inside the confined shell. */
  mounts: string[];
  /** PATH entries (in order) for those toolchains. */
  bins: string[];
  /** Manager roots, e.g. PYENV_ROOT, so shims work with a scratch HOME. */
  env: Record<string, string>;
}

export async function userToolchains(home = homedir()): Promise<UserToolchains> {
  const mounts: string[] = [];
  const bins: string[] = [];
  const env: Record<string, string> = {};
  for (const entry of HOME_TOOLCHAINS) {
    const dir = join(home, entry.dir);
    const real = await realpath(dir).catch(() => null);
    if (!real) continue;
    mounts.push(real);
    for (const bin of entry.bins ?? []) bins.push(join(home, bin));
    if (entry.env) env[entry.env] = dir;
  }
  const nvm = await nvmNodeBin(home);
  if (nvm) bins.unshift(nvm);
  return { mounts: [...new Set(mounts)], bins, env };
}

let gitIdentity: Promise<Record<string, string>> | null = null;

function gitConfigValue(key: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', ['config', '--global', '--get', key], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve('');
    }, 3_000);
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

/**
 * The user's Git identity as environment variables. The confined shell runs
 * with a scratch HOME and no global Git config (credential helpers and
 * includes stay outside), so without this `git commit` in a connected
 * repository fails with "Please tell me who you are". Only name and email
 * cross the boundary. Read once per process.
 */
export function gitIdentityEnv(): Promise<Record<string, string>> {
  if (!gitIdentity) {
    gitIdentity = (async () => {
      const [name, email] = await Promise.all([
        gitConfigValue('user.name'),
        gitConfigValue('user.email'),
      ]);
      const env: Record<string, string> = {};
      if (name) Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name });
      if (email) Object.assign(env, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email });
      return env;
    })();
  }
  return gitIdentity;
}

/** Roots and cwd are already canonicalized and checked by the caller.
 *  `readOnly` adds directories visible but not writable (user toolchains). */
export async function prepareWorkspaceShell(
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  roots: string[],
  readOnly: string[] = [],
): Promise<WorkspaceShellLaunch> {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') {
    throw new Error(
      '[WORKSPACE_SHELL_UNAVAILABLE] 이 운영체제에서는 작업 공간 제한 셸을 아직 지원하지 않습니다. ' +
        '파일 작업에는 ReadFile/WriteFile을 사용할 수 있습니다. 전체 셸 접근 설정은 자동으로 변경하지 않습니다.',
    );
  }
  if (!roots.length || roots.some((root) => !isAbsolute(root))) {
    throw new Error('[WORKSPACE_SHELL_UNAVAILABLE] 유효한 허용 작업 공간이 없습니다.');
  }
  // Never take the restriction launcher from a workspace-controlled PATH.
  const launcher = LAUNCHER;
  try {
    await access(launcher, constants.X_OK);
  } catch {
    throw new Error(
      `[WORKSPACE_SHELL_UNAVAILABLE] 작업 공간 제한 실행기를 사용할 수 없습니다: ${launcher}.` +
        (mac ? '' : ' bubblewrap 설치가 필요합니다.'),
    );
  }
  // Per-command home/temp stay inside the allowed workspace, including jobs.
  const scratch = await mkdtemp(join(cwd, '.xgen-shell-'));
  const cleanup = () => rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  try {
    await writeFile(join(scratch, '.gitignore'), '*\n');
    const childEnv: Record<string, string> = {
      ...env,
      HOME: scratch,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      XDG_CACHE_HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      XDG_DATA_HOME: scratch,
      ZDOTDIR: scratch,
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    // Do not source the user's login startup files for a workspace command.
    delete childEnv.BASH_ENV;
    delete childEnv.ENV;
    // The native restriction launcher itself starts before confinement.
    // Prevent loader environment variables from injecting code into it.
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('LD_') || key.startsWith('DYLD_')) delete childEnv[key];
    }
    const commandArgs = args.map((arg, index) => (index === 0 && arg === '-lc' ? '-c' : arg));
    const runtime = await existing(mac ? MAC_RUNTIME_DIRS : LINUX_RUNTIME_DIRS);
    const systemFiles = await existing(SYSTEM_FILES);
    const certificates = await existing(['/etc/ssl', '/etc/pki']);
    const toolchains = (await existing(readOnly)).filter(
      (dir) => !roots.some((root) => dir === root || dir.startsWith(`${root}/`)),
    );
    if (mac) {
      const subpath = (p: string) => `(subpath ${JSON.stringify(p)})`;
      const literal = (p: string) => `(literal ${JSON.stringify(p)})`;
      const profile = [
        '(version 1)',
        '(deny default)',
        '(allow process-exec)',
        '(allow process-fork)',
        '(allow process-info* (target same-sandbox))',
        '(allow signal (target same-sandbox))',
        '(allow sysctl-read)',
        '(allow ipc-posix-shm)',
        '(allow ipc-posix-sem)',
        '(allow file-read-metadata)',
        '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") ' +
          '(global-name "com.apple.system.opendirectoryd.membership") ' +
          '(global-name "com.apple.logd") (global-name "com.apple.bsd.dirhelper") ' +
          '(global-name "com.apple.system.logger") (global-name "com.apple.trustd.agent") ' +
          '(global-name "com.apple.dnssd.service") ' +
          '(global-name "com.apple.SystemConfiguration.SCNetworkReachability"))',
        // DNS uses the OS resolver's Unix socket. Other host Unix sockets
        // (Docker, app IPC) remain inaccessible.
        '(allow system-socket (socket-domain AF_UNIX))',
        '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))',
        '(allow network-outbound (remote ip))',
        // Local development servers share the PC's network namespace. Permit
        // IP listeners while keeping filesystem scope and Unix socket denial.
        '(allow network-bind (local ip))',
        '(allow network-inbound (local ip))',
        `(allow file-read* (literal "/") ${[...runtime, ...certificates, ...toolchains, ...roots].map(subpath).join(' ')} ${systemFiles.map(literal).join(' ')})`,
        '(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/zero"))',
        '(allow file-read* file-write-data file-ioctl (literal "/dev/null"))',
        `(allow file-write* ${roots.map(subpath).join(' ')})`,
      ].join('\n');
      return {
        file: launcher,
        args: ['-p', profile, file, ...commandArgs],
        env: childEnv,
        cleanup,
      };
    }
    // Start with an empty filesystem. Only runtime files and the allowed
    // folders are mounted; /proc belongs to the new PID namespace.
    const argv = [
      '--die-with-parent',
      '--unshare-all',
      '--share-net',
      '--new-session',
      '--cap-drop',
      'ALL',
    ];
    for (const dir of [...runtime, ...certificates]) argv.push('--ro-bind', dir, dir);
    // Preserve common /bin -> /usr/bin layouts after canonicalizing runtime roots.
    for (const dir of LINUX_RUNTIME_DIRS) {
      const target = await realpath(dir).catch(() => null);
      if (target && target !== dir) argv.push('--symlink', target, dir);
    }
    for (const path of SYSTEM_FILES) {
      if (await realpath(path).catch(() => null)) argv.push('--ro-bind', path, path);
    }
    argv.push('--proc', '/proc', '--dev', '/dev');
    for (const dir of toolchains) argv.push('--ro-bind', dir, dir);
    for (const root of roots) argv.push('--bind', root, root);
    argv.push('--chdir', cwd, '--', file, ...commandArgs);
    return { file: launcher, args: argv, env: childEnv, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
