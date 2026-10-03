#!/usr/bin/env node
/**
 * Windows 설치본 확인 — 처음 하는 사용자별 설치 → 다시 설치(업데이트) → 제거를 조용히(/S) 해 본다.
 *
 * 처음 하는 사용자별 설치는 electron-builder 의 multiUser.nsh 가 기본 위치를 고르는 경로를 탄다 — 26.12 아래의 템플릿은
 * 거기서 힙을 넘겨 읽어 Windows 11 24H2·Server 2025 에서 설치 프로그램이 바로 0xC0000005 로 죽었다(#9769). 실제 사용자가
 * 처음 설치하는 그 경로를 CI 의 windows-latest(Server 2025)에서 그대로 돈다.
 *
 *   node apps/desktop/scripts/check-installer.mjs            (apps/desktop/release/XGen-Dex-Setup-*.exe 를 쓴다)
 *
 * Windows 가 아니면 아무것도 하지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
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
const exe = join(dir, 'XGen-Dex.exe');
const installed = () => {
  if (!existsSync(exe)) fail('설치 뒤에 XGen-Dex.exe 가 없습니다');
  if (!existsSync(join(dir, 'resources', 'app.asar'))) fail('설치 뒤에 app.asar 가 없습니다');
  // OS 키체인 모듈 — asar 밖에 풀려 있어야 실린다(electron-builder.yml asarUnpack).
  const keytar = join(dir, 'resources', 'app.asar.unpacked', 'node_modules', 'keytar', 'build', 'Release', 'keytar.node');
  if (!existsSync(keytar)) fail(`keytar 네이티브 모듈이 없습니다: ${keytar}`);
};

console.log(`처음 설치(사용자별): ${setup} → ${dir}`);
run(installer, ['/S', `/D=${dir}`]);
installed();

console.log('같은 곳에 다시 설치(업데이트)');
run(installer, ['/S', '--updated', `/D=${dir}`]);
installed();

console.log('제거');
const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
if (!uninstaller) fail('제거 프로그램이 없습니다');
// _?= — 제자리에서 돌고 끝날 때까지 기다린다(없으면 임시 폴더로 복사해 띄우고 바로 돌아온다).
run(join(dir, uninstaller), ['/S', `_?=${dir}`]);
if (existsSync(exe)) fail('제거 뒤에도 XGen-Dex.exe 가 남았습니다');
console.log('✓ 처음 설치·업데이트·제거');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
