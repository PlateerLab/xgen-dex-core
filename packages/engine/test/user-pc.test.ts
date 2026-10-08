/** 사용자 PC 접속(UserPc)의 기기 쪽 — 셸 고르기·실행·작업·취소·내장 해석기·감시 시한. */
import assert from 'assert';
import { test } from 'node:test';
import { platform, tmpdir } from 'os';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'fs/promises';
import { join } from 'path';
import { normalizeLocalFolders } from '@dex/engine/local-folders';
import { setWorkspaceShellSupportForTest } from '@dex/engine/workspace-shell';
import { LocalToolProvider, NO_FOLDER_MESSAGE } from '@dex/engine/local-tools';
import {
  USER_PC_JOB_TOOL,
  USER_PC_RUN_TOOL,
  detectUserPcShell,
  findGitBash,
  runUserPcCommand,
  setUserPcShellForTest,
  stopUserPcJobsOutside,
  userPcJob,
  userPcToolSchemas,
} from '@dex/engine/user-pc';
import { mountNames, pathMaps } from '@dex/engine/user-pc-builtin';
import { LocalDeadlineError, localDeadlineMs } from '@dex/engine/mcp-bridge';
import { bindTestHost, recordingInteraction } from './_host';

const host = recordingInteraction('deny');
bindTestHost({ interaction: host.port });
setWorkspaceShellSupportForTest(false);
const isWin = platform() === 'win32';

async function folder(prefix = 'xgen-pc-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

// ── 셸 고르기 ──────────────────────────────────────────────────────

test('Windows 는 Git Bash 가 있으면 그것, WSL 의 bash 는 쓰지 않는다', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const found = (paths: string[]) => (p: string) => paths.includes(p);
  const git = join('C:\\Program Files', 'Git', 'bin', 'bash.exe');
  assert.equal(findGitBash(env, found([git])), git);
  assert.equal(findGitBash(env, found(['C:\\Windows\\System32\\bash.exe'])), null);
  const shell = detectUserPcShell('win32', env, found([git]));
  assert.deepEqual([shell.kind, shell.label], ['git-bash', 'Git Bash']);
});

test('Git Bash 가 없는 Windows 는 내장 해석기이고 프로그램을 넘기는 법을 알린다', () => {
  const shell = detectUserPcShell('win32', {}, () => false);
  assert.equal(shell.kind, 'builtin');
  assert.match(shell.note, /powershell -NoProfile -Command/);
  assert.match(shell.note, /\/<folder name>/);
});

test('macOS·Linux 는 bash, 가두는 macOS 는 그 사실을 알린다', () => {
  const mac = detectUserPcShell('darwin', { SHELL: '/bin/zsh' }, (p) => p === '/bin/bash' || p === '/usr/bin/sandbox-exec');
  assert.deepEqual([mac.kind, mac.file, mac.label], ['posix', '/bin/bash', 'bash']);
  assert.match(mac.note, /only inside the connected folders/);
  const linux = detectUserPcShell('linux', { SHELL: '/usr/bin/fish' }, () => false);
  assert.deepEqual([linux.file, linux.label, linux.note], ['/usr/bin/fish', 'fish', '']);
});

test('실행 도구는 셸 이름을 meta 로 서버에 알린다(모델에게는 숨는 _ 도구)', () => {
  const [run, job] = userPcToolSchemas({ kind: 'posix', file: '/bin/bash', label: 'bash', note: 'n' });
  assert.equal(run.name, USER_PC_RUN_TOOL);
  assert.deepEqual(run.meta, { shell: 'bash', shell_note: 'n' });
  assert.equal(job.name, USER_PC_JOB_TOOL);
});

// ── 실행 ───────────────────────────────────────────────────────────

const posix = { kind: 'posix' as const, file: '/bin/bash', label: 'bash', note: '' };

test('명령은 폴더에서 돌고 종료 코드·표준 출력·표준 오류를 따로 돌려준다', { skip: isWin }, async () => {
  const dir = await folder();
  const out = await runUserPcCommand(
    { command: 'pwd; echo 한글 출력; echo oops >&2; exit 3', cwd: dir, roots: [dir], names: ['proj'], key: 'c1', waitMs: 10_000 },
    posix,
  );
  assert.equal(out.exit_code, 3);
  assert.equal(out.running, false);
  assert.equal(out.stdout, `${dir}\n한글 출력\n`);
  assert.equal(out.stderr, 'oops\n');
  assert.equal(out.shell, 'bash');
});

test('기다리는 시간을 넘긴 명령은 작업으로 이어지고 확인·멈춤이 된다', { skip: isWin }, async () => {
  const dir = await folder();
  const started = await runUserPcCommand(
    { command: 'echo start; sleep 2; echo end', cwd: dir, roots: [dir], names: ['p'], key: 'c2', waitMs: 1_000 },
    posix,
  );
  assert.equal(started.running, true);
  assert.ok(started.job_id);
  const done = await userPcJob(started.job_id!, 'c2', 'poll', 5_000);
  assert.equal(done.running, false);
  assert.equal(done.exit_code, 0);
  assert.equal(done.stdout, 'start\nend\n');
  await assert.rejects(userPcJob(started.job_id!, 'other-chat', 'poll'), /No job/);

  const long = await runUserPcCommand(
    { command: 'sleep 30', cwd: dir, roots: [dir], names: ['p'], key: 'c2', waitMs: 1_000 },
    posix,
  );
  const stopped = await userPcJob(long.job_id!, 'c2', 'stop');
  assert.equal(stopped.running, false);
  assert.match(stopped.stderr, /stopped/);
});

test('취소 신호가 오면 기다리지 않고 프로세스를 끝낸다', { skip: isWin }, async () => {
  const dir = await folder();
  const abort = new AbortController();
  const t0 = Date.now();
  setTimeout(() => abort.abort(), 300);
  const out = await runUserPcCommand(
    { command: 'sleep 30', cwd: dir, roots: [dir], names: ['p'], key: 'c3', waitMs: 20_000, signal: abort.signal },
    posix,
  );
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(out.running, false);
});

test('폴더 연결을 끊으면 그 폴더에서 돌던 작업이 멈춘다', { skip: isWin }, async () => {
  const dir = await folder();
  const job = await runUserPcCommand(
    { command: 'sleep 30', cwd: dir, roots: [dir], names: ['p'], key: 'c4', waitMs: 1_000 },
    posix,
  );
  assert.equal(stopUserPcJobsOutside('c4', []), 1);
  const after = await userPcJob(job.job_id!, 'c4', 'poll', 2_000);
  assert.equal(after.running, false);
});

// ── 내장 해석기(Windows, Git Bash 없음) ───────────────────────────────

test('내장 해석기 경로 대응: 폴더는 /<이름>, 겹치면 번호', () => {
  const roots = ['/r/a/docs', '/r/b/docs'];
  const names = mountNames(roots, ['docs', 'docs']);
  assert.deepEqual(names, ['docs', 'docs (2)']);
  const { toVirtual, toReal } = pathMaps(roots, names);
  assert.equal(toVirtual('/r/b/docs/sub/x'), '/docs (2)/sub/x');
  assert.equal(toReal('/docs/sub'), join('/r/a/docs', 'sub'));
  assert.equal(toReal('/elsewhere'), null);
});

test('내장 해석기로 bash 명령이 실제 폴더에서 돈다', async () => {
  const dir = await folder();
  await mkdir(join(dir, 'sub', '깊은폴더'), { recursive: true });
  await writeFile(join(dir, 'notes.txt'), 'hello\nTODO: 제목\n');
  await writeFile(join(dir, 'sub', '깊은폴더', '결과발표_1장.pptx'), Buffer.from([0x50, 0x4b, 3, 4]));
  const builtin = { kind: 'builtin' as const, label: 'bash (built in: file and text commands)', note: '' };
  const run = (command: string) =>
    runUserPcCommand({ command, cwd: dir, roots: [dir], names: ['proj'], key: 'c5', waitMs: 10_000 }, builtin);
  const found = await run("find . -iname '*결과발표*'");
  assert.equal(found.stdout, './sub/깊은폴더/결과발표_1장.pptx\n');
  assert.equal((await run('pwd')).stdout, '/proj\n');
  const edited = await run("sed -i 's/hello/HELLO/' notes.txt && grep -n TODO notes.txt");
  assert.equal(edited.exit_code, 0);
  assert.equal(edited.stdout, '2:TODO: 제목\n');
  assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'HELLO\nTODO: 제목\n');
  // 해석기의 가상 /bin·/usr 말고는 붙인 폴더만 보인다 — 실제 PC 의 다른 폴더는 보이지 않는다.
  const root = (await run('ls ../..')).stdout.split('\n');
  assert.ok(root.includes('proj'));
  assert.ok(!root.includes('etc') && !root.includes('home') && !root.includes('tmp'), root.join(','));
});

// ── 도구 제공자 ─────────────────────────────────────────────────────

function provider(book: Record<string, string[]>) {
  const p = new LocalToolProvider();
  p.configureFolders((context) => normalizeLocalFolders(book[context?.interactionId ?? ''] ?? []));
  return p;
}

test('실행 도구는 그 대화의 연결 폴더 안에서만 돈다', { skip: isWin }, async () => {
  setUserPcShellForTest(posix);
  try {
    const dir = await folder();
    const outside = await folder('xgen-out-');
    const p = provider({ chat: [dir] });
    const ok = await p.callTool(USER_PC_RUN_TOOL, { command: 'echo ok', cwd: dir, wait_ms: 10_000 }, { interactionId: 'chat' });
    assert.equal(ok.isError, undefined);
    assert.equal((ok.structuredContent as any).stdout, 'ok\n');
    await assert.rejects(
      p.callTool(USER_PC_RUN_TOOL, { command: 'ls', cwd: outside }, { interactionId: 'chat' }),
      /PATH_DOMAIN_MISMATCH/,
    );
    await assert.rejects(p.callTool(USER_PC_RUN_TOOL, { command: 'ls' }, { interactionId: 'none' }), (e: Error) =>
      e.message === NO_FOLDER_MESSAGE,
    );
    const denied = await p.callTool(USER_PC_RUN_TOOL, { command: 'rm -rf build', cwd: dir }, { interactionId: 'chat' });
    assert.equal(denied.isError, true);
  } finally {
    setUserPcShellForTest(null);
  }
});

test('카탈로그에 실행 도구가 서고(숨는 이름) 셸 정보가 붙는다', () => {
  const tools = provider({}).advertise();
  const run = tools.find((t) => t.name === USER_PC_RUN_TOOL);
  assert.ok(run?.meta && typeof run.meta.shell === 'string');
  assert.ok(tools.some((t) => t.name === USER_PC_JOB_TOOL));
});

// ── 감시 시한 ───────────────────────────────────────────────────────

test('감시 시한: 서버가 준 시한보다 조금 짧게, 없으면 도구 종류로', () => {
  assert.equal(localDeadlineMs('_UserPcRun', 75_000, true), 74_000);
  assert.equal(localDeadlineMs('ReadFile', undefined, true), 120_000);
  assert.equal(localDeadlineMs('Shell', undefined, true), 595_000);
  assert.equal(localDeadlineMs('search', undefined, false), 130_000);
  assert.match(new LocalDeadlineError('Shell', 15_000).message, /LOCAL_TIMEOUT.*Shell.*15초/);
});
