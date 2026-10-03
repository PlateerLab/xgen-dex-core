// XGEN 다운로드 센터 업데이트 패키지 선택 규칙을 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  dexMacDmg,
  linuxRelaunchTarget,
  relaunchAfterExitArgs,
  selectXgenUpdate,
  windowsNsisLauncherCommand,
  windowsNsisUpdateArgs,
} from '../src/main/update-source';

test('버전 앞의 v와 점 구분 숫자를 비교한다', () => {
  assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.5.3', 'v1.5.3'), 0);
});

test('현재 OS와 호환되는 가장 높은 Connector 버전을 고른다', () => {
  const packages = [
    { id: 1, product: 'connector', version: '2.0.0', platform: 'windows', original_name: 'connector.exe' },
    { id: 2, product: 'connector', version: '1.8.0', platform: 'macos', original_name: 'connector.dmg' },
    { id: 3, product: 'connector', version: '1.9.0', platform: 'macos', original_name: 'connector.dmg' },
    { id: 4, product: 'extensions', version: '9.0.0', platform: 'macos', original_name: 'extensions.zip' },
  ];
  assert.equal(selectXgenUpdate(packages, 'darwin', '1.5.3')?.id, 3);
  assert.equal(selectXgenUpdate(packages, 'win32', '1.5.3')?.id, 1);
});

test('플랫폼 표기가 없어도 설치 파일 확장자로 판단하고 이전 버전은 제외한다', () => {
  const packages = [
    { id: 1, product: 'connector', version: '1.4.0', original_name: 'old.AppImage' },
    { id: 2, product: 'connector', version: '1.6.0', original_name: 'new.AppImage' },
  ];
  assert.equal(selectXgenUpdate(packages, 'linux', '1.5.3')?.id, 2);
  assert.equal(selectXgenUpdate(packages, 'linux', '1.6.0'), null);
});

test('Windows 설치는 진행 UI를 표시하는 NSIS update 인자를 사용한다', () => {
  assert.deepEqual(windowsNsisUpdateArgs(), ['--updated', '--force-run']);
  assert.equal(
    windowsNsisLauncherCommand(),
    'ping 127.0.0.1 -n 5 > nul & start "" "%XGEN_UPDATE_INSTALLER%" --updated --force-run',
  );
});

test('맥 수동 업데이트는 Dex 의 dmg 만 고른다 — 같은 릴리스의 XD dmg 를 집지 않는다', () => {
  const assets = [
    { name: 'XD-1.82.0-arm64.dmg' },
    { name: 'XGen-Dex-1.82.0.dmg' },
    { name: 'XGen-Dex-Setup-1.82.0.exe' },
  ];
  assert.equal(dexMacDmg(assets)?.name, 'XGen-Dex-1.82.0.dmg');
  assert.equal(dexMacDmg([{ name: 'XD-1.82.0-x64.dmg' }]), undefined);
  assert.equal(dexMacDmg(undefined), undefined);
});

test('리눅스 업데이트 뒤 다시 띄울 것 — AppImage 는 (새 이름의) AppImage, deb 는 .bin 이 아니라 실행 시임', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  assert.equal(linuxRelaunchTarget('/tmp/.mount_x/xgen-dex.bin', '/home/u/XGen-Dex-1.83.0.AppImage', has()), '/home/u/XGen-Dex-1.83.0.AppImage');
  assert.equal(linuxRelaunchTarget('/opt/XGen-Dex/xgen-dex.bin', undefined, has('/opt/XGen-Dex/xgen-dex')), '/opt/XGen-Dex/xgen-dex');
  // 시임이 없으면(손으로 푼 폴더 등) 그 실행 파일 그대로
  assert.equal(linuxRelaunchTarget('/opt/XGen-Dex/xgen-dex.bin', undefined, has()), '/opt/XGen-Dex/xgen-dex.bin');
  assert.equal(linuxRelaunchTarget('/opt/XGen-Dex/xgen-dex', undefined, has('/opt/XGen-Dex/xgen-dex')), '/opt/XGen-Dex/xgen-dex');
});

test('다시 띄우기는 옛 프로세스가 끝난 뒤에 — 먼저 뜨면 단일 실행 잠금에 걸린다', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dex-relaunch-'));
  try {
    const marker = join(dir, 'launched-at');
    const target = join(dir, 'target.sh');
    writeFileSync(target, `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], String(Date.now()))" "${marker}"\n`, { mode: 0o755 });
    // 옛 프로세스 — 1초 뒤에 끝난다
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
    const exited = new Promise<number>((resolve) => old.on('exit', () => resolve(Date.now())));
    spawn('/bin/sh', relaunchAfterExitArgs(old.pid!, target), { detached: true, stdio: 'ignore' }).unref();
    const oldEnd = await exited;
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(marker), '다시 띄우지 않았다');
    const launchedAt = Number(readFileSync(marker, 'utf8'));
    assert.ok(launchedAt >= oldEnd, `옛 프로세스가 끝나기 전(${oldEnd - launchedAt}ms 앞)에 띄웠다`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
