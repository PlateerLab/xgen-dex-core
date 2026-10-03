#!/usr/bin/env node
/**
 * Windows 설치본 확인 — 설치 → (같은 곳에 다시 설치 = 업데이트) → 제거를 조용히(/S) 해 보고, 그동안 **설치 폴더(= XD 루트)의
 * workspace·.xd 가 남는지** 본다(build/installer.nsh 의 customRemoveFiles). 앱이 깐 것은 지워져야 한다.
 *
 *   node apps/xd/scripts/check-installer.mjs            (apps/xd/release/XD-Setup-*.exe 를 쓴다)
 *
 * Windows 가 아니면 아무것도 하지 않는다. CI(xd-package)와 릴리스가 같은 확인을 한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

console.log('제거');
const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
if (!uninstaller) fail('제거 프로그램이 없습니다');
// _?= — 제자리에서 돌고 끝날 때까지 기다린다(없으면 임시 폴더로 복사해 띄우고 바로 돌아온다).
execFileSync(join(dir, uninstaller), ['/S', `_?=${dir}`], { stdio: 'inherit' });
kept();
for (const gone of ['XD.exe', 'resources', 'locales']) {
  if (existsSync(join(dir, gone))) fail(`제거 뒤에도 ${gone} 이(가) 남았습니다`);
}
console.log('✓ 설치·업데이트·제거 — 루트의 workspace·.xd 와 사용자 파일은 남고, 앱이 깐 것만 지워졌습니다');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
