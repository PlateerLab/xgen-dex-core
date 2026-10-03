#!/usr/bin/env node
/**
 * Windows 설치본 확인 — 설치 → (같은 곳에 다시 설치 = 업데이트) → 제거를 조용히(/S) 해 보고, 그동안 **설치 폴더(= XD 루트)의
 * workspace·.xd 가 남는지** 본다(build/installer.nsh 의 customRemoveFiles). 앱이 깐 것은 지워져야 한다. 엔진 파일이 잠겨
 * 있으면 제거가 아무것도 지우지 않고 멈추는지, 설치 폴더 고르기(xdInstDirPre — 화면에서만 돌아 /S 로는 타지 않는다)가
 * 남의 폴더에 \XD 를 붙이는지도 본다(electron-builder 가 받아 둔 makensis 로 그 함수만 돌리는 작은 설치 프로그램).
 *
 *   node apps/xd/scripts/check-installer.mjs            (apps/xd/release/XD-Setup-*.exe 를 쓴다)
 *
 * Windows 가 아니면 아무것도 하지 않는다. CI(xd-package)와 릴리스가 같은 확인을 한다.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Windows 설치본 확인은 Windows 에서만 합니다 — 건너뜀');
  process.exit(0);
}

const XD = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(XD, 'release');
const setup = readdirSync(release).find((f) => /^XD-Setup-.*\.exe$/.test(f));
if (!setup) throw new Error(`설치본이 없습니다: ${release}`);
const installer = join(release, setup);
// 공백 없는 곳 — NSIS 의 /D= 는 따옴표 없이 마지막 인자여야 한다(공백이 있으면 인자가 따옴표로 싸여 거절된다).
const base = process.env.RUNNER_TEMP && !/\s/.test(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
const dir = /\s/.test(base) ? join(process.env.SystemDrive || 'C:', '\\xd-install-check') : join(base, 'xd-install-check');
rmSync(dir, { recursive: true, force: true });

const install = () => execFileSync(installer, ['/S', `/D=${dir}`], { stdio: 'inherit' });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

console.log(`설치: ${setup} → ${dir}`);
install();
if (!existsSync(join(dir, 'XD.exe'))) fail('설치 뒤에 XD.exe 가 없습니다');
if (!existsSync(join(dir, 'resources', 'engine', 'python', 'python.exe'))) fail('설치본에 동봉 엔진이 없습니다');

// 앱을 쓰던 루트처럼 — 에이전트의 작업 공간과 XD 상태(데이터베이스·키)를 둔다.
mkdirSync(join(dir, 'workspace', '리서치'), { recursive: true });
writeFileSync(join(dir, 'workspace', '리서치', 'report.md'), '# 보고서\n');
mkdirSync(join(dir, '.xd', 'secrets'), { recursive: true });
writeFileSync(join(dir, '.xd', 'xd.db'), 'db');
writeFileSync(join(dir, '.xd', 'secrets', 'k.bin'), 'k');
// 설치본이 깔지 않은 사용자 파일 — 지울 목록에 없으니 남아야 한다(설치 폴더에 사용자가 둔 것).
writeFileSync(join(dir, 'my-notes.txt'), 'mine');
const kept = () => {
  if (readFileSync(join(dir, 'workspace', '리서치', 'report.md'), 'utf8') !== '# 보고서\n') fail('작업 공간이 지워졌습니다');
  if (!existsSync(join(dir, '.xd', 'xd.db')) || !existsSync(join(dir, '.xd', 'secrets', 'k.bin'))) fail('.xd 가 지워졌습니다');
  if (!existsSync(join(dir, 'my-notes.txt'))) fail('설치본이 깔지 않은 사용자 파일이 지워졌습니다');
};

// 옛 판의 것 — 업데이트(옛 판 제거 → 새 판 설치)가 정말 옛 판을 걷는지 본다(앱이 깐 폴더 안의 남은 파일).
writeFileSync(join(dir, 'resources', 'stale-from-old.txt'), 'old');
console.log('같은 곳에 다시 설치(업데이트)');
install();
kept();
if (!existsSync(join(dir, 'XD.exe'))) fail('다시 설치한 뒤에 XD.exe 가 없습니다');
if (existsSync(join(dir, 'resources', 'stale-from-old.txt'))) fail('업데이트가 옛 판의 파일을 걷지 않았습니다');

// 엔진이 아직 돌 때(파일 잠김) — 제거가 아무것도 지우지 않고 2 로 끝나야 한다(업데이트 설치 프로그램은 그것을 보고 옛 판을
// 둔 채 멈춘다). 잠금은 설치 폴더 밖의 PowerShell 이 쥔다 — 설치 폴더 안의 프로세스는 제거 프로그램이 먼저 끝낸다.
const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
if (!uninstaller) fail('제거 프로그램이 없습니다');
const python = join(dir, 'resources', 'engine', 'python', 'python.exe');
console.log('엔진 파일이 잠긴 채 제거 — 지우지 않고 멈춘다');
const holder = spawn(
  'powershell',
  ['-NoProfile', '-Command', `$f = [System.IO.File]::Open('${python}', 'Open', 'Read', 'Read'); Write-Output held; Start-Sleep -Seconds 120`],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let heldOut = '';
holder.stdout.setEncoding('utf8');
while (!heldOut.includes('held')) {
  const [chunk] = await Promise.race([once(holder.stdout, 'data'), once(holder, 'exit').then(() => fail('잠금을 쥐지 못했습니다'))]);
  heldOut += chunk;
}
// _?= — 제자리에서 돌고 끝날 때까지 기다린다(없으면 임시 폴더로 복사해 띄우고 바로 돌아온다).
const busy = spawnSync(join(dir, uninstaller), ['/S', `_?=${dir}`], { stdio: 'inherit' });
holder.kill();
await once(holder, 'exit');
if (busy.status !== 2) fail(`엔진 파일이 잠겼는데 제거가 ${busy.status} 로 끝났습니다(2 여야 한다)`);
kept();
for (const left of ['XD.exe', 'locales', 'resources', uninstaller]) {
  if (!existsSync(join(dir, left))) fail(`멈춘 제거가 ${left} 을(를) 지웠습니다`);
}
if (!existsSync(python)) fail('멈춘 제거가 엔진을 지웠습니다');

console.log('제거');
execFileSync(join(dir, uninstaller), ['/S', `_?=${dir}`], { stdio: 'inherit' });
kept();
for (const gone of ['XD.exe', 'resources', 'locales']) {
  if (existsSync(join(dir, gone))) fail(`제거 뒤에도 ${gone} 이(가) 남았습니다`);
}
console.log('✓ 설치·업데이트·제거 — 루트의 workspace·.xd 와 사용자 파일은 남고, 앱이 깐 것만 지워졌습니다(잠겨 있으면 멈춤)');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

// 설치 폴더 고르기 — "XD" 가 든 경로가 비어 있지 않은 남의 폴더면 \XD 를 붙이고, 비었거나 없거나 XD 의 것이면 그대로
// 둔다. "XD" 가 없는 경로는 손대지 않는다(electron-builder 가 붙인다).
console.log('설치 폴더 고르기');
const require = createRequire(join(XD, 'package.json'));
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const makensis = await getMakeNsisPath('0.0.0');
const pick = /xd/i.test(base) ? join(process.env.SystemDrive || 'C:', '\\dir-pick') : join(base, 'dir-pick');
rmSync(pick, { recursive: true, force: true });
const harness = join(pick, 'harness');
mkdirSync(harness, { recursive: true });
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');
writeFileSync(
  join(harness, 'pick.nsi'),
  [
    'Unicode true',
    '!include LogicLib.nsh',
    '!define APP_FILENAME "XD"',
    '!define APP_EXECUTABLE_FILENAME "XD.exe"',
    'Name "xd-dir-pick"',
    `OutFile "${join(harness, 'pick.exe')}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    `!include "${join(templates, 'include', 'StrContains.nsh')}"`,
    `!include "${join(XD, 'build', 'installer.nsh')}"`,
    '!insertmacro customPageAfterChangeDir',
    'Function .onInit',
    '  Call xdInstDirPre',
    '  FileOpen $0 "$EXEDIR\\result.txt" w',
    '  FileWrite $0 "$INSTDIR"',
    '  FileClose $0',
    '  Quit',
    'FunctionEnd',
    'Section',
    'SectionEnd',
    '',
  ].join('\r\n'),
);
execFileSync(makensis.path, ['-INPUTCHARSET', 'UTF8', join(harness, 'pick.nsi')], {
  env: { ...process.env, ...(makensis.env ?? {}) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const at = (...p) => join(pick, ...p);
const file = (p) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, 'x'));
file(at('alexd', 'proj', 'notes.txt'));
mkdirSync(at('AlexD2', 'empty'), { recursive: true });
file(at('alexd', 'inst', 'XD.exe'));
file(at('alexd', 'root', '.xd', 'xd.db'));
file(at('alexd', 'root', 'other.txt'));
file(at('alexd', 'ws', 'workspace', 'a', 'b.md'));
file(at('plain', 'stuff', 'notes.txt'));
file(at('MYXDATA', 'proj', 'notes.txt'));
const cases = [
  [at('alexd', 'proj'), at('alexd', 'proj', 'XD')],
  [at('MYXDATA', 'proj'), at('MYXDATA', 'proj', 'XD')],
  [at('AlexD2', 'empty'), at('AlexD2', 'empty')],
  [at('alexd', 'new'), at('alexd', 'new')],
  [at('alexd', 'inst'), at('alexd', 'inst')],
  [at('alexd', 'root'), at('alexd', 'root')],
  [at('alexd', 'ws'), at('alexd', 'ws')],
  [at('plain', 'stuff'), at('plain', 'stuff')],
];
for (const [chosen, want] of cases) {
  rmSync(join(harness, 'result.txt'), { force: true });
  execFileSync(join(harness, 'pick.exe'), ['/S', `/D=${chosen}`], { stdio: 'inherit' });
  const got = readFileSync(join(harness, 'result.txt'), 'utf8');
  if (got !== want) fail(`설치 폴더 고르기: ${chosen} → ${got} (기대 ${want})`);
}
console.log(`✓ 설치 폴더 고르기 — ${cases.length}가지 경로`);
rmSync(pick, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
