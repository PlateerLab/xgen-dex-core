// 설치본 설정이 지켜야 하는 것 — 어긋나면 설치·업데이트가 조용히 깨진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const here = join(__dirname, '..');
const builder = readFileSync(join(here, 'electron-builder.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(here, 'package-lock.json'), 'utf8'));
const workflow = (name: string) => readFileSync(join(here, '..', '..', '.github', 'workflows', name), 'utf8');

/** 워크플로의 한 잡(들여쓰기 2칸의 `name:` 부터 다음 잡 전까지). */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `잡이 없다: ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('appId 는 그대로다 — NSIS 의 설치·업데이트 식별자와 macOS 번들 ID 가 여기서 나온다', () => {
  assert.match(builder, /^appId: com\.plateerlab\.xgen\.connector$/m);
});

test('electron-builder 26.12 이상 — 처음 하는 사용자별 설치에서 기본 위치를 범위 밖까지 읽지 않는다', () => {
  // 26.12 아래의 multiUser.nsh 는 기본 설치 위치를 1024자로 읽어 힙을 넘겨 읽는다 — Windows 11 24H2·Server 2025 에서
  // 그 읽기가 매핑되지 않은 쪽에 닿으면 설치 프로그램이 0xC0000005 로 죽는다(electron-builder #9769). 같은 템플릿의 XD
  // 설치본이 CI(Server 2025)에서 그렇게 죽었다.
  const [major, minor] = String(lock.packages['node_modules/app-builder-lib'].version).split('.').map(Number);
  assert.ok(major > 26 || (major === 26 && minor >= 12), `app-builder-lib ${major}.${minor}`);
});

test('설치본을 만드는 잡은 Node 22.12 이상 — electron-builder 26 의 @electron/rebuild 가 요구한다', () => {
  for (const [file, name] of [
    ['release.yml', 'desktop'],
    ['ci.yml', 'desktop-package'],
  ] as const) {
    const m = /node-version:\s*(\d+)/.exec(job(workflow(file), name));
    assert.ok(m, `${file} ${name}: node-version 이 없다`);
    assert.ok(Number(m![1]) >= 22, `${file} ${name}: Node ${m![1]}`);
  }
});

test('리눅스 창이 설치되는 .desktop 항목에 묶인다', () => {
  // electron-builder 26 은 desktop 을 entry 중첩형으로 받는다(24 의 FLAT 맵은 스키마가 거절한다).
  assert.match(builder, /\n {2}desktop:\n {4}entry:\n(?: {6}.*\n)*? {6}StartupWMClass: xgen-dex\n/);
  assert.equal(pkg.name, 'xgen-dex', 'X11 의 WM_CLASS 가 여기서 온다');
  // Wayland 의 app_id(= desktopName 에서 .desktop 을 뗀 것)가 설치되는 xgen-dex.desktop 과 같아야 한다.
  assert.equal(pkg.desktopName, `${pkg.name}.desktop`);
});
