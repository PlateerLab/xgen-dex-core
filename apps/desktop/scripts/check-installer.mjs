#!/usr/bin/env node
/**
 * Windows 설치본 확인 — 처음 하는 사용자별 설치 → 다시 설치(업데이트) → 제거, 그리고 **이전 릴리스에서 올라오기**(현장의
 * 사용자가 깔아 둔 판 → 이 설치본 --updated — 새 설치 프로그램이 옛 판의 제거 프로그램을 부른다) → 제거를 조용히(/S) 해 본다.
 *
 * 처음 하는 사용자별 설치는 electron-builder 의 multiUser.nsh 가 기본 위치를 고르는 경로를 탄다 — 26.12 아래의 템플릿은
 * 거기서 힙을 넘겨 읽어 Windows 11 24H2·Server 2025 에서 설치 프로그램이 바로 0xC0000005 로 죽었다(#9769). 실제 사용자가
 * 처음 설치하는 그 경로를 CI 의 windows-latest(Server 2025)에서 그대로 돈다.
 *
 *   node apps/desktop/scripts/check-installer.mjs            (apps/desktop/release/XGen-Dex-Setup-*.exe 를 쓴다)
 *
 * Windows 가 아니면 아무것도 하지 않는다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Windows 설치본 확인은 Windows 에서만 합니다 — 건너뜀');
  process.exit(0);
}

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(DESKTOP, 'release');
const setup = readdirSync(release).find((f) => /^XGen-Dex-Setup-.*\.exe$/.test(f));
if (!setup) throw new Error(`설치본이 없습니다: ${release}`);
const installer = join(release, setup);
// 공백 없는 곳 — NSIS 의 /D= 는 따옴표 없이 마지막 인자여야 한다.
const base = process.env.RUNNER_TEMP && !/\s/.test(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
const dir = /\s/.test(base) ? join(process.env.SystemDrive || 'C:', '\\dex-install-check') : join(base, 'dex-install-check');
rmSync(dir, { recursive: true, force: true });

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const run = (file, args) => {
  try {
    execFileSync(file, args, { stdio: 'inherit', timeout: 600_000 });
  } catch (err) {
    fail(`${[file, ...args].join(' ')} → 종료 코드 ${err.status ?? err.signal}${err.status === 3221225477 ? ' (0xC0000005 — 설치 프로그램이 죽었다)' : ''}`);
  }
};
const exe = (where) => join(where, 'XGen-Dex.exe');
const installed = (where) => {
  if (!existsSync(exe(where))) fail('설치 뒤에 XGen-Dex.exe 가 없습니다');
  if (!existsSync(join(where, 'resources', 'app.asar'))) fail('설치 뒤에 app.asar 가 없습니다');
  // OS 키체인 모듈 — asar 밖에 풀려 있어야 실린다(electron-builder.yml asarUnpack).
  const keytar = join(where, 'resources', 'app.asar.unpacked', 'node_modules', 'keytar', 'build', 'Release', 'keytar.node');
  if (!existsSync(keytar)) fail(`keytar 네이티브 모듈이 없습니다: ${keytar}`);
};
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const uninstall = async (where) => {
  const uninstaller = readdirSync(where).find((f) => /^Uninstall .*\.exe$/i.test(f));
  if (!uninstaller) fail('제거 프로그램이 없습니다');
  // 설치 직후 곧바로 지우면 백신(Defender)이 막 쓴 exe 를 검사하느라 쥐고 있어 지우지 못할 수 있다(사용자는 설치 직후에
  // 지우지 않는다) — 남으면 그 파일이 잠겼는지 남기고 잠시 뒤 다시 지운다. 정말 지우지 못하는 거라면 다시 해도 남는다.
  // 제거 직전 — exe 가 잠겼는지, 설치 폴더 아래에서 도는 프로세스(제거 프로그램이 PowerShell 로 찾아 끄는 것과 같은 조회)
  const state = () => {
    let lock = '잠기지 않음';
    try {
      closeSync(openSync(exe(where), 'r+'));
    } catch (err) {
      lock = err.code;
    }
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance -ClassName Win32_Process | ? { $_.Path -and $_.Path.StartsWith('${where}', 'CurrentCultureIgnoreCase') } | % { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }`],
      { encoding: 'utf8' },
    );
    return `exe ${lock}; 설치 폴더 아래 프로세스: ${(ps.stdout || '').trim().replace(/\r?\n/g, ' | ') || '없음'}`;
  };
  console.log(`  제거 직전: ${state()}`);
  for (let attempt = 1; ; attempt++) {
    // _?= — 제자리에서 돌고 끝날 때까지 기다린다(없으면 임시 폴더로 복사해 띄우고 바로 돌아온다).
    const t0 = Date.now();
    // 둘째 시도는 사용자가 제어판에서 지우는 것과 같이 — _?= 없이(임시 폴더로 복사해 띄우고 바로 돌아온다) 지워지길 기다린다.
    const inPlace = attempt !== 2;
    const r = spawnSync(join(where, uninstaller), inPlace ? ['/S', `_?=${where}`] : ['/S'], { stdio: 'inherit', timeout: 600_000 });
    if (!inPlace) for (let i = 0; i < 60 && existsSync(exe(where)); i++) await new Promise((res) => setTimeout(res, 1000));
    if (!existsSync(exe(where))) {
      if (attempt > 1) console.log(`::warning::${attempt}번째 제거(${inPlace ? '제자리' : '임시 폴더에서'})로 지워졌다`);
      return;
    }
    console.log(`  ${attempt}번째 제거(${inPlace ? '제자리 _?=' : '임시 폴더에서'})`);
    // 왜 남았는지 — 제거 프로그램의 종료 코드·걸린 시간, 남은 것, 제거 정보(레지스트리)
    console.log(`  제거 프로그램 종료 코드 ${r.status ?? r.signal ?? r.error}, ${Date.now() - t0}ms`);
    console.log(`  남은 것: ${readdirSync(where).join(', ')}`);
    console.log(`  제거 직후: ${state()}`);
    const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'XGen', '/d'], { encoding: 'utf8' });
    console.log(`  제거 정보: ${(reg.stdout || reg.stderr || '').split('\n').filter((l) => /HKEY|DisplayName|InstallLocation|UninstallString/.test(l)).join(' | ').slice(0, 800)}`);
    let lock = '잠기지 않음';
    try {
      closeSync(openSync(exe(where), 'r+'));
    } catch (err) {
      lock = err.code;
    }
    if (attempt >= 3) fail(`제거 뒤에도 XGen-Dex.exe 가 남았습니다(${lock})`);
    console.log(`::warning::제거 뒤에도 XGen-Dex.exe 가 남음(${attempt}번째, ${lock}) — 5초 뒤 다시 제거`);
    await new Promise((r) => setTimeout(r, 5000));
  }
};

console.log(`처음 설치(사용자별): ${setup} → ${dir}`);
run(installer, ['/S', `/D=${dir}`]);
installed(dir);
console.log('같은 곳에 다시 설치(업데이트)');
run(installer, ['/S', '--updated', `/D=${dir}`]);
installed(dir);
console.log('제거');
await uninstall(dir);
console.log('✓ 처음 설치·업데이트·제거');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

// ── 이전 릴리스에서 올라오기 ──────────────────────────────────────────────
async function getJson(url) {
  const headers = { 'User-Agent': 'xgen-dex-ci', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}
const latest = await getJson('https://api.github.com/repos/PlateerLab/xgen-dex-core/releases/latest');
const asset = (latest.assets ?? []).find((a) => /^XGen-Dex-Setup-.*\.exe$/.test(a.name));
if (!asset) fail(`이전 릴리스(${latest.tag_name})에 Windows 설치본이 없습니다`);
const previous = join(base, asset.name);
console.log(`이전 릴리스 ${latest.tag_name}: ${asset.name} 내려받기`);
const res = await fetch(asset.browser_download_url);
if (!res.ok) fail(`이전 설치본을 받지 못했습니다: ${res.status}`);
writeFileSync(previous, Buffer.from(await res.arrayBuffer()));
const upgrade = `${dir}-upgrade`;
rmSync(upgrade, { recursive: true, force: true });
console.log(`이전 릴리스 설치 → ${upgrade}`);
try {
  execFileSync(previous, ['/S', `/D=${upgrade}`], { stdio: 'inherit', timeout: 600_000 });
} catch (err) {
  // 이전 판의 설치 프로그램이 이 러너에서 죽으면(26.12 아래 템플릿의 그 버그) 올라오기를 볼 수 없다 — 숨기지 않고 알린다.
  if (err.status === 3221225477) {
    console.log(`::warning::이전 릴리스 설치 프로그램이 이 러너에서 0xC0000005 로 죽어 올라오기는 확인하지 못했습니다(${latest.tag_name})`);
    process.exit(0);
  }
  fail(`이전 릴리스 설치 → 종료 코드 ${err.status ?? err.signal}`);
}
installed(upgrade);
const before = sha(join(upgrade, 'resources', 'app.asar'));
console.log(`이 설치본으로 올라오기(--updated): ${setup}`);
run(installer, ['/S', '--updated', `/D=${upgrade}`]);
installed(upgrade);
const after = sha(join(upgrade, 'resources', 'app.asar'));
const built = sha(join(release, 'win-unpacked', 'resources', 'app.asar'));
if (after !== built) fail(`올라온 뒤의 app.asar 가 이 설치본의 것이 아닙니다(${before === after ? '이전 판 그대로' : '알 수 없는 판'})`);
await uninstall(upgrade);
console.log(`✓ 이전 릴리스(${latest.tag_name})에서 올라오기·제거`);
rmSync(upgrade, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
rmSync(previous, { force: true });
