/** 로컬 셸 도구 — 카탈로그 광고·게이트·셸 선택·결과 정형·실행·강건성. */
import assert from 'assert';
import { test } from 'node:test';
import { platform, homedir, tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { join, resolve } from 'path';
import {
  LOCAL_SERVER,
  NOTIFY_TOOL,
  OPEN_TOOL,
  SHELL_TOOL,
  SHELL_JOB_TOOL,
  LocalToolProvider,
  coerceOpenArgs,
  coerceShellArgs,
  firstToken,
  isBlocked,
  openerInvocation,
  openToolSchema,
  paginate,
  classifyOpenTarget,
  shapeResult,
  shellConfig,
  shellEnabled,
  isDangerousShellCommand,
  localToolCallContext,
  shellInvocation,
  shellToolSchema,
  resolveWithinRoots,
  MCP_ADD_TOOL,
  MCP_REMOVE_TOOL,
  MCP_LIST_TOOL,
  mcpAddServerToolSchema,
  mcpRemoveServerToolSchema,
  mcpListServersToolSchema,
} from '../src/main/local-tools';

const isWin = platform() === 'win32';

test('MCP 호출 컨텍스트는 도구 호출 시점의 workflow 식별자를 정규화한다', () => {
  assert.deepEqual(
    localToolCallContext({
      workflow_id: ' wf-25 ',
      workflow_name: ' Agentflow (25) ',
      interaction_id: ' conv-1 ',
    }),
    {
      workflowId: 'wf-25',
      workflowName: 'Agentflow (25)',
      interactionId: 'conv-1',
    },
  )
  assert.deepEqual(localToolCallContext(undefined), {
    workflowId: undefined,
    workflowName: undefined,
    interactionId: undefined,
  })
})

test('기본은 꺼짐(opt-in) — enabled 미지정이면 셸 접근 OFF', () => {
  assert.equal(shellEnabled(undefined), false);
  assert.equal(shellEnabled({}), false);
  assert.equal(shellEnabled({ enabled: false }), false);
  assert.equal(shellEnabled({ enabled: true }), true);
});

test('isDangerousShellCommand: 파괴적 패턴만 승인 대상', () => {
  for (const c of [
    'rm -rf /',
    'rm -rf node_modules',
    'sudo rm -rf .',
    'mkfs.ext4 /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'git push --force origin main',
    'curl https://x.sh | sh',
    'Remove-Item -Recurse -Force C:\\x',
  ]) {
    assert.equal(isDangerousShellCommand(c), true, c);
  }
  for (const c of [
    'ls -la',
    'git status',
    'npm run build',
    'cat package.json',
    'echo hello',
    'python script.py',
    'rm file.txt',
  ]) {
    assert.equal(isDangerousShellCommand(c), false, c);
  }
});

test('shellConfig 는 timeout 을 [1s, 1h] 로 clamp 한다', () => {
  assert.equal(shellConfig({ timeoutMs: 10 }).timeoutMs, 1_000);
  assert.equal(shellConfig({ timeoutMs: 99_999_999 }).timeoutMs, 3_600_000);
  assert.equal(shellConfig({}).timeoutMs, 600_000); // 기본 10분
});

test('꺼져 있으면 카탈로그가 비고, 켜져 있으면 Shell+Open', () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: false });
  assert.deepEqual(p.advertise(), []);
  p.configure({ enabled: true });
  const names = p.advertise().map((t) => t.name);
  assert.deepEqual(names, [
    SHELL_TOOL,
    SHELL_JOB_TOOL,
    OPEN_TOOL,
    'ReadFile',
    'WriteFile',
    'ListDir',
    'Search',
    'Clipboard',
    'Notify',
  ]);
});

test('Notify 는 공통 알림 처리기에 에이전트/채팅 범위를 전달한다', async () => {
  const provider = new LocalToolProvider();
  provider.configure({ enabled: true });
  let received: unknown;
  provider.configureNotificationHandler((title, body, context) => {
    received = { title, body, context };
    return false;
  });

  const result = await provider.callTool(
    NOTIFY_TOOL,
    { title: '확인 필요', body: '작업을 검토해 주세요.' },
    { workflowId: 'wf-1', workflowName: 'Agent 1', interactionId: 'chat-7' },
  );

  assert.deepEqual(received, {
    title: '확인 필요',
    body: '작업을 검토해 주세요.',
    context: { workflowId: 'wf-1', workflowName: 'Agent 1', interactionId: 'chat-7' },
  });
  assert.match(result.content[0].text, /설정에 따라/);
});

test('resolveWithinRoots: 스코프 안은 허용, 밖은 거부', () => {
  const home = homedir();
  assert.equal(resolveWithinRoots('~/docs/a.txt', []), join(home, 'docs/a.txt'));
  assert.equal(resolveWithinRoots('foo/bar', []), join(home, 'foo/bar'));
  assert.equal(resolveWithinRoots('/nonexistent-root/x', []), null);
  assert.equal(resolveWithinRoots('~/../escape', []), null);
  // 크로스플랫폼: '/tmp/..' 는 Windows 에서 'D:\\tmp\\..' 로 해석되므로 기대값도
  // 같은 resolve() 로 만든다(리터럴 POSIX 경로 비교는 Windows CI 에서 깨진다).
  const rootX = resolve('/tmp/x');
  assert.equal(resolveWithinRoots('/tmp/x/y', ['/tmp/x']), resolve('/tmp/x/y'));
  assert.equal(resolveWithinRoots('/tmp/other', ['/tmp/x']), null);
  assert.equal(resolveWithinRoots('/tmp/x', ['/tmp/x']), rootX);
});

test('파일 도구 end-to-end: write→read→list→search + 스코프 밖 거부', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xgen-lt-'));
  const p = new LocalToolProvider();
  p.configure({ enabled: true, allowedRoots: [dir] });
  const w = await p.callTool('WriteFile', {
    path: join(dir, 'a.txt'),
    content: 'hello\nNEEDLE here\n',
  });
  assert.equal(w.isError, undefined);
  const r = await p.callTool('ReadFile', { path: join(dir, 'a.txt') });
  assert.ok(r.content[0].text.includes('NEEDLE'));
  const l = await p.callTool('ListDir', { path: dir });
  assert.ok(l.content[0].text.includes('a.txt'));
  const sr = await p.callTool('Search', { query: 'NEEDLE', path: dir });
  assert.ok(sr.content[0].text.includes('a.txt:2'));
  await assert.rejects(() => p.callTool('ReadFile', { path: '/etc/hostname' }));
});

test('Shell 스키마에 background, Open 스키마에 target', () => {
  const shell = shellToolSchema();
  const schema = shell.inputSchema as any;
  assert.ok(schema.properties.background, 'background 옵션이 없다');
  assert.match(String(shell.description), /background/, '설명이 background 를 안내하지 않는다');
  assert.match(String(shell.description), /OWN COMPUTER/i, '로컬 PC 임을 강조하지 않는다');
  const open = openToolSchema().inputSchema as any;
  assert.deepEqual(open.required, ['target']);
});

test('openerInvocation 은 OS 기본 opener 로 매핑된다', () => {
  const inv = openerInvocation('/tmp/x.txt');
  if (isWin) assert.equal(inv.file, 'cmd.exe');
  else assert.ok(inv.file === 'open' || inv.file === 'xdg-open');
  assert.ok(inv.args.includes('/tmp/x.txt'));
});

test('coerceShellArgs 는 background 를 다양한 표기에서 읽는다', () => {
  assert.equal(coerceShellArgs({ command: 'x', background: true }).background, true);
  assert.equal(coerceShellArgs({ command: 'x', background: 'true' }).background, true);
  assert.equal(coerceShellArgs({ command: 'x', detach: true }).background, true);
  assert.equal(coerceShellArgs({ command: 'x' }).background, false);
});

test('coerceOpenArgs 는 target/path/url/file 을 받는다', () => {
  assert.equal(coerceOpenArgs({ target: '/a' }).target, '/a');
  assert.equal(coerceOpenArgs({ path: '/b' }).target, '/b');
  assert.equal(coerceOpenArgs({ url: 'http://x' }).target, 'http://x');
});

test('owns 는 예약 네임스페이스(local)만 소유한다', () => {
  const p = new LocalToolProvider();
  assert.equal(p.owns(LOCAL_SERVER), true);
  assert.equal(p.owns('my-mcp-server'), false);
});

test('Shell 스키마는 command 필수 + shell enum', () => {
  const s = shellToolSchema();
  const schema = s.inputSchema as any;
  assert.deepEqual(schema.required, ['command']);
  assert.ok(schema.properties.command);
  assert.deepEqual(schema.properties.shell.enum, ['default', 'powershell', 'cmd', 'bash', 'sh']);
});

test('shellInvocation: default 는 OS 네이티브, 명시 셸은 강제', () => {
  if (isWin) {
    assert.equal(shellInvocation('notepad', null).file, 'powershell.exe');
  } else {
    // POSIX default 는 $SHELL 바이너리 우선(경로 형태일 때), 없으면 bash
    assert.equal(shellInvocation('ls', '/bin/zsh').file, '/bin/zsh');
    assert.deepEqual(shellInvocation('ls', '/bin/zsh').args, ['-lc', 'ls']);
    assert.equal(shellInvocation('ls', null).file, 'bash');
    assert.equal(shellInvocation('ls', 'not-a-path').file, 'bash', '경로가 아니면 bash 로 폴백');
  }
  // 명시 셸은 플랫폼과 무관하게 강제
  assert.equal(shellInvocation('x', null, 'powershell').file, 'powershell.exe');
  assert.equal(shellInvocation('x', null, 'cmd').file, 'cmd.exe');
  assert.equal(shellInvocation('x', '/bin/zsh', 'bash').file, 'bash');
  assert.equal(shellInvocation('x', null, 'sh').file, 'sh');
});

test('firstToken 은 경로·확장자·따옴표를 벗겨 프로그램 이름만 남긴다', () => {
  assert.equal(firstToken('rm -rf /'), 'rm');
  assert.equal(firstToken('"C:\\\\Windows\\\\System32\\\\rm.exe" x'), 'rm');
  assert.equal(firstToken('/usr/bin/git status'), 'git');
  assert.equal(firstToken("'my prog' arg"), 'my prog');
});

test('blocklist 는 첫 토큰 기준으로 차단한다 (경로 우회 불가)', () => {
  assert.equal(isBlocked('rm -rf /', ['rm']), true);
  assert.equal(isBlocked('/usr/bin/rm x', ['rm']), true);
  assert.equal(isBlocked('ls', ['rm']), false);
  assert.equal(isBlocked('anything', []), false);
});

test('coerceShellArgs 는 느슨한 입력을 정규화한다', () => {
  assert.deepEqual(
    coerceShellArgs({ command: 'ls', cwd: '/tmp', shell: 'bash', timeout_ms: 5000 }),
    {
      command: 'ls',
      cwd: '/tmp',
      shell: 'bash',
      timeoutMs: 5000,
      background: false,
    },
  );
  // 빈 cwd/timeout 은 undefined 로
  assert.equal(coerceShellArgs({ command: 'ls', cwd: '  ' }).cwd, undefined);
  assert.equal(coerceShellArgs({ command: 'ls' }).timeoutMs, undefined);
});

test('shapeResult 는 stdout/stderr 합치고 실패를 표시한다', () => {
  const ok = shapeResult('hello\n', '', 0, null);
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, /hello/);

  const fail = shapeResult('', 'boom', 1, null);
  assert.equal(fail.isError, true);
  assert.match(fail.content[0].text, /STDERR:/);
  assert.match(fail.content[0].text, /exit code 1/);

  const killed = shapeResult('', '', null, 'SIGKILL');
  assert.equal(killed.isError, true);
  assert.match(killed.content[0].text, /SIGKILL/);

  assert.match(shapeResult('', '', 0, null).content[0].text, /no output/);
});

test('꺼진 상태에서 callTool 은 명확한 오류를 던진다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: false });
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: 'ls' }), /꺼져 있습니다/);
});

test('빈 command / 알 수 없는 도구는 거절한다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: '   ' }), /empty/);
  await assert.rejects(() => p.callTool('Nope', {}), /unknown local tool/);
});

test('차단된 명령은 실행 전에 거절한다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true, blocked: ['rm'] });
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: 'rm -rf /' }), /차단 목록/);
});

test('E2E: 실제 셸로 echo 를 실행해 stdout 을 받는다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const cmd = isWin ? 'Write-Output hello-xgen' : 'echo hello-xgen';
  const res = await p.callTool(SHELL_TOOL, { command: cmd });
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.match(res.content[0].text, /hello-xgen/);
});

test('E2E: 0 아닌 종료 코드는 isError 로 표시된다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const cmd = isWin ? 'exit 3' : 'exit 3';
  const res = await p.callTool(SHELL_TOOL, { command: cmd });
  assert.equal(res.isError, true);
});

// ── 강건성: 대화형 hang 방지 · background · 타임아웃 tree-kill ──

test('E2E: stdin 을 읽는 대화형 명령이 타임아웃 없이 즉시 끝난다 (EOF)', async () => {
  // stdin 이 열려 있으면 이 명령은 영원히 매달린다 — stdio ignore 로 EOF 를 받아
  // 곧바로 끝나야 한다. 넉넉한 timeout(8s)을 줘도 훨씬 빨리 반환되면 통과.
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const cmd = isWin ? '$input | Out-String' : 'cat';
  const started = Date.now();
  const res = await p.callTool(SHELL_TOOL, { command: cmd, timeout_ms: 8000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `대화형 명령이 EOF 로 끝나지 않고 ${elapsed}ms 걸렸다`);
  assert.notEqual(res.isError, true, JSON.stringify(res));
});

test('E2E: 짧은 timeout 을 넘기는 포그라운드 명령은 중단되고 안내가 붙는다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const cmd = isWin ? 'Start-Sleep -Seconds 5' : 'sleep 5';
  const started = Date.now();
  const res = await p.callTool(SHELL_TOOL, { command: cmd, timeout_ms: 1200 });
  const elapsed = Date.now() - started;
  assert.equal(res.isError, true);
  assert.ok(elapsed < 4000, `timeout 후에도 ${elapsed}ms 매달렸다`);
  assert.match(res.content[0].text, /background/, '중단 안내가 background 대안을 알려주지 않는다');
});

test('E2E: background 는 즉시 반환하고, 그 프로세스는 타임아웃에 죽지 않는다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true, timeoutMs: 1000 }); // 짧은 기본 타임아웃
  // 3초 자는 프로세스를 백그라운드로 — 1초 타임아웃보다 오래 살아야 한다.
  const cmd = isWin ? 'Start-Sleep -Seconds 3' : 'sleep 3';
  const started = Date.now();
  const res = await p.callTool(SHELL_TOOL, { command: cmd, background: true });
  const elapsed = Date.now() - started;
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.ok(elapsed < 2000, `background 가 즉시 반환하지 않고 ${elapsed}ms 걸렸다`);
  assert.match(res.content[0].text, /백그라운드|pid/);
});

// ── G13 페이징 / G9 Open 검증 / G6 background job 레지스트리 ──

test('paginate: head/tail 라인 + max_bytes 바이트 캡 (tail-bias)', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  assert.equal(paginate(text, { tail: 2 }).text, 'line8\nline9');
  assert.equal(paginate(text, { head: 2 }).text, 'line0\nline1');
  const big = 'x'.repeat(1000);
  const p = paginate(big, { maxBytes: 100 });
  assert.equal(p.text.length, 100);
  assert.equal(p.truncated, true);
  assert.equal(p.totalBytes, 1000);
  assert.equal(paginate('short', {}).text, 'short');
  assert.equal(paginate('short', {}).truncated, false);
});

test('paginate: max_bytes 는 바이트 기준이며 멀티바이트 문자를 깨지 않는다', () => {
  const s = '가'.repeat(100); // 각 3바이트(UTF-8) → 300바이트
  const p = paginate(s, { maxBytes: 10 });
  assert.ok(Buffer.byteLength(p.text) <= 10, `바이트 캡 초과: ${Buffer.byteLength(p.text)}`);
  assert.ok(!p.text.includes('�'), '깨진 문자(U+FFFD)가 남았다');
  assert.equal(p.truncated, true);
  assert.equal(p.totalBytes, 300);
});

test('classifyOpenTarget: 안전 URL 허용 / 위험 스킴 차단 / 경로 통과', () => {
  assert.deepEqual(classifyOpenTarget('https://x.com'), { kind: 'url', value: 'https://x.com' });
  assert.deepEqual(classifyOpenTarget('mailto:a@b.com'), { kind: 'url', value: 'mailto:a@b.com' });
  assert.equal(classifyOpenTarget('javascript:alert(1)').kind, 'blocked');
  assert.equal(classifyOpenTarget('data:text/html,x').kind, 'blocked');
  assert.equal(classifyOpenTarget('vbscript:msgbox').kind, 'blocked');
  assert.equal(classifyOpenTarget('customscheme:foo').kind, 'blocked');
  assert.equal(classifyOpenTarget('/home/u/a.txt').kind, 'path');
  assert.equal(classifyOpenTarget('~/a.txt').kind, 'path');
  assert.equal(classifyOpenTarget('').kind, 'blocked');
  assert.equal(classifyOpenTarget('file:///home/u/a.txt').kind, 'path');
});

test('Open 은 위험 스킴을 throw 없이 거절한다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const res = await p.callTool(OPEN_TOOL, { target: 'javascript:alert(1)' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /스킴|열 수 없습니다/);
});

test('E2E: background job → job_id, ShellJob list/poll/kill 로 관리', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true, timeoutMs: 1000 });
  const cmd = isWin
    ? 'Write-Output started-xgen; Start-Sleep -Seconds 3'
    : 'echo started-xgen; sleep 3';
  const res = await p.callTool(SHELL_TOOL, { command: cmd, background: true });
  const m = res.content[0].text.match(/job_id:\s*(\S+)/);
  assert.ok(m, 'job_id 미반환: ' + res.content[0].text);
  const jobId = m![1];
  const list = await p.callTool(SHELL_JOB_TOOL, { action: 'list' });
  assert.match(list.content[0].text, new RegExp(jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // 셸 기동은 부하에 따라 수백 ms 씩 흔들린다(윈도 PowerShell 이 특히). 고정 대기
  // 뒤 한 번만 들여다보면 느린 날에는 stdout 이 아직 비어 실패한다 — 여기서 지키려는
  // 것은 "언제" 가 아니라 "백그라운드 job 의 출력이 쌓이는가" 이므로, 준비될 때까지
  // 짧게 되묻는다. 명령의 sleep 은 3초라 그 안에는 여전히 running 이다.
  let poll = await p.callTool(SHELL_JOB_TOOL, { action: 'poll', job_id: jobId });
  const deadline = Date.now() + 2500;
  while (!/started-xgen/.test(poll.content[0].text) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    poll = await p.callTool(SHELL_JOB_TOOL, { action: 'poll', job_id: jobId });
  }
  assert.match(poll.content[0].text, /started-xgen/);
  assert.match(poll.content[0].text, /running/);
  const kill = await p.callTool(SHELL_JOB_TOOL, { action: 'kill', job_id: jobId });
  assert.match(kill.content[0].text, /종료/);
  const poll2 = await p.callTool(SHELL_JOB_TOOL, { action: 'poll', job_id: jobId });
  assert.match(poll2.content[0].text, /killed|exited/);
});

test('ShellJob: 없는 job_id 는 오류', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  const r = await p.callTool(SHELL_JOB_TOOL, { action: 'poll', job_id: 'does-not-exist' });
  assert.equal(r.isError, true);
});

test('E2E: Open 은 존재하지 않는 opener 여도 앱 실행 실패를 보고한다 (throw 안 함)', async () => {
  // 실제 GUI 를 띄우지 않기 위해, Open 이 아니라 Shell 로 opener 부재 상황을 검증하기는
  // 어렵다 — 대신 Open 이 빈 target 을 거절하는지, 그리고 정상 target(디렉터리)에서
  // throw 없이 결과를 돌려주는지만 본다 (headless 에서 xdg-open 은 실패할 수 있다).
  const p = new LocalToolProvider();
  p.configure({ enabled: true });
  await assert.rejects(() => p.callTool(OPEN_TOOL, { target: '  ' }), /empty/);
  const res = await p.callTool(OPEN_TOOL, { target: '.' });
  assert.ok(Array.isArray(res.content) && typeof res.content[0].text === 'string');
});

test('MCP 자기관리 delegate — 로컬 셸과 무관하게 노출·라우팅되고, 미배선이면 안 뜬다', async () => {
  const p = new LocalToolProvider();
  p.configure({ enabled: false }); // 로컬 셸 OFF 여도 MCP 관리 도구는 별도 게이트
  assert.deepEqual(p.advertise(), []);

  const seen: Array<[string, unknown]> = [];
  const admin = {
    advertise: () => [
      mcpAddServerToolSchema(),
      mcpRemoveServerToolSchema(),
      mcpListServersToolSchema(),
    ],
    owns: (t: string) => t === MCP_ADD_TOOL || t === MCP_REMOVE_TOOL || t === MCP_LIST_TOOL,
    callTool: async (t: string, a: unknown) => {
      seen.push([t, a]);
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  };
  p.configureMcpAdmin(admin);
  const names = p.advertise().map((t) => t.name);
  assert.ok(
    names.includes(MCP_ADD_TOOL) &&
      names.includes(MCP_REMOVE_TOOL) &&
      names.includes(MCP_LIST_TOOL),
  );
  // 로컬 셸이 꺼져 있어도(cfg.enabled=false) MCP 관리 도구는 호출된다 — 게이트 이전에 라우팅.
  const r = await p.callTool(MCP_ADD_TOOL, { name: 'x' });
  assert.equal(r.content[0].text, 'ok');
  assert.deepEqual(seen, [[MCP_ADD_TOOL, { name: 'x' }]]);

  p.configureMcpAdmin(null);
  assert.deepEqual(p.advertise(), []);
});

test('MCP 관리 도구 스키마 — 이름/필수필드', () => {
  assert.equal(mcpAddServerToolSchema().name, MCP_ADD_TOOL);
  assert.deepEqual(mcpAddServerToolSchema().inputSchema?.required, ['name']);
  assert.equal(mcpRemoveServerToolSchema().name, MCP_REMOVE_TOOL);
  assert.deepEqual(mcpRemoveServerToolSchema().inputSchema?.required, ['name']);
  assert.equal(mcpListServersToolSchema().name, MCP_LIST_TOOL);
});
