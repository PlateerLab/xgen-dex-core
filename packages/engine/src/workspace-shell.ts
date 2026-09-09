/** OS-enforced filesystem scope for commands on the client PC.
 * This is separate from the agent's server sandbox. Never retry unrestricted
 * when a local restriction mechanism is unavailable or rejects a command.
 */
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
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

/** Roots and cwd are already canonicalized and checked by the caller. */
export async function prepareWorkspaceShell(
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  roots: string[],
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
  const launcher = mac ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
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
        `(allow file-read* (literal "/") ${[...runtime, ...certificates, ...roots].map(subpath).join(' ')} ${systemFiles.map(literal).join(' ')})`,
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
    for (const root of roots) argv.push('--bind', root, root);
    argv.push('--chdir', cwd, '--', file, ...commandArgs);
    return { file: launcher, args: argv, env: childEnv, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
