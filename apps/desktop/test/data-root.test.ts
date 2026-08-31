// 통합 데이터 루트 — 해석/정착/인스톨러 옵션 1회 소비를 검증한다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  cloudDirOf,
  consumeInstallOptions,
  decodeInstallerLogLine,
  INSTALL_OPTIONS_FILE,
  readInstallLogText,
  resolveDataRoot,
  runtimeDirOf,
  settleDataRoot,
  workspaceDirOf,
} from '../src/main/data-root';
import type { ConnectorConfig } from '../src/main/config';

const HOME = '/home/tester';

test('resolveDataRoot: 기본 ~/xgen-dex, 명시값 존중', () => {
  assert.equal(resolveDataRoot({}, HOME), join(HOME, 'xgen-dex'));
  // resolve() 는 윈도우에서 드라이브를 붙인다 — 기대값도 같은 규칙으로.
  assert.equal(resolveDataRoot({ dataRoot: '/custom/place' }, HOME), resolve('/custom/place'));
});

test('settleDataRoot: 트리 생성 + 미설정 기본 채움, 명시 설정은 안 덮음', () => {
  const home = mkdtempSync(join(tmpdir(), 'dr-'));
  try {
    const cfg = { serverUrl: '' } as unknown as ConnectorConfig;
    const { root, patch } = settleDataRoot(cfg, home);
    assert.equal(root, join(home, 'xgen-dex'));
    // 트리가 실제로 만들어졌다.
    for (const d of [root, workspaceDirOf(root), cloudDirOf(root), runtimeDirOf(root)])
      assert.ok(existsSync(d), d);
    // 미설정 → dataRoot 파생 기본이 패치로.
    assert.equal(patch.dataRoot, root);
    assert.equal(patch.localShell?.cwd, workspaceDirOf(root));
    assert.equal(patch.workspace?.root, cloudDirOf(root));

    // 명시 설정은 절대 덮지 않는다.
    const explicit = {
      dataRoot: join(home, 'else'),
      localShell: { cwd: '/my/ws' },
      workspace: { root: '/my/cloud', agents: [] },
    } as unknown as ConnectorConfig;
    const r2 = settleDataRoot(explicit, home);
    assert.equal(r2.root, join(home, 'else'));
    assert.equal(r2.patch.localShell, undefined);
    assert.equal(r2.patch.workspace, undefined);
    assert.equal(r2.patch.dataRoot, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumeInstallOptions: 1회 소비(파일 삭제) + 패치 매핑, 없으면 null', () => {
  const ud = mkdtempSync(join(tmpdir(), 'ud-'));
  try {
    assert.equal(consumeInstallOptions(ud), null);
    writeFileSync(
      join(ud, INSTALL_OPTIONS_FILE),
      // 구버전 인스톨러가 남긴 로컬 실행 옵션이 섞여 있어도 무시한다 —
      // 그 스위치는 없어졌고(에이전트는 서버에서 돈다) dataRoot 만 의미가 있다.
      JSON.stringify({
        dataRoot: 'D:\\xgen-dex',
        autoRuntime: true,
        autoCodex: false,
        autoClaude: true,
      }),
    );
    const patch = consumeInstallOptions(ud);
    assert.deepEqual(patch, { dataRoot: 'D:\\xgen-dex' });
    // 소비됐다 — 파일 삭제 + 재호출 null.
    assert.equal(existsSync(join(ud, INSTALL_OPTIONS_FILE)), false);
    assert.equal(consumeInstallOptions(ud), null);
    // 손상 JSON → null(그리고 삭제).
    writeFileSync(join(ud, INSTALL_OPTIONS_FILE), '{broken');
    assert.equal(consumeInstallOptions(ud), null);
    assert.equal(existsSync(join(ud, INSTALL_OPTIONS_FILE)), false);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('readInstallerText: UTF-16LE(BOM)/UTF-8(BOM)/ANSI-ASCII 를 모두 읽는다 (한글 경로 안전)', async () => {
  const { readInstallerText } = await import('../src/main/data-root');
  const json = '{"dataRoot":"C:\\\\Users\\\\홍길동\\\\xgen-dex","autoRuntime":true}';
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
  assert.equal(JSON.parse(readInstallerText(u16)).dataRoot, 'C:\\Users\\홍길동\\xgen-dex');
  const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]);
  assert.equal(JSON.parse(readInstallerText(u8)).autoRuntime, true);
  assert.equal(JSON.parse(readInstallerText(Buffer.from('{"a":1}'))).a, 1);
});

// ── 설치 로그 디코드 — 인스톨러(CP949 ANSI) + 앱(UTF-8) 이 한 파일에 섞여 있다 ──

test('decodeInstallerLogLine: CP949 바이트(가 → ; —) 는 EUC-KR 로, UTF-8 한글은 그대로, BOM UTF-16LE 도 읽는다', () => {
  // '가' = B0 A1, '→' = A1 E6, '—' = A1 AA (CP949/EUC-KR)
  assert.equal(decodeInstallerLogLine(Buffer.from([0xb0, 0xa1])), '가');
  assert.equal(
    decodeInstallerLogLine(
      Buffer.concat([Buffer.from('copy done ', 'latin1'), Buffer.from([0xa1, 0xe6]), Buffer.from(' C:\\x', 'latin1')]),
    ),
    'copy done → C:\\x',
  );
  // CP949 A1AA(전각 대시)는 WHATWG euc-kr 표에서 U+2015 — U+FFFD 로 깨지지 않고 끝의 \r 도 떨어진다.
  assert.equal(
    decodeInstallerLogLine(Buffer.concat([Buffer.from('update install ', 'latin1'), Buffer.from([0xa1, 0xaa]), Buffer.from(' ok\r', 'latin1')])),
    'update install \u2015 ok',
  );
  assert.equal(decodeInstallerLogLine(Buffer.from('[app] ensure: 설치 폴더 런타임 준비됨 (3.8.0)\r', 'utf8')), '[app] ensure: 설치 폴더 런타임 준비됨 (3.8.0)');
  assert.equal(decodeInstallerLogLine(Buffer.from('\uFEFFabc', 'utf8')), 'abc'); // UTF-8 BOM
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글 경로\r', 'utf16le')]);
  assert.equal(decodeInstallerLogLine(u16), '한글 경로');
  // 한글 Windows 프로필 경로(CP949) — 인스톨러가 $XgenDataRoot 를 ANSI 로 썼을 때
  assert.equal(
    decodeInstallerLogLine(Buffer.concat([Buffer.from('dataRoot=C:\\Users\\', 'latin1'), Buffer.from([0xc8, 0xab, 0xb1, 0xe6])])),
    'dataRoot=C:\\Users\\홍길',
  );
});

test('readInstallLogText: 줄마다 인코딩을 따로 판별한다(CP949 줄 + UTF-8 줄 혼재), 전체 UTF-16LE(BOM) 파일도', () => {
  const mixed = Buffer.concat([
    Buffer.from('==== install start ====\r\n', 'latin1'),
    Buffer.from('copy done ', 'latin1'),
    Buffer.from([0xa1, 0xe6]),
    Buffer.from(' C:\\u\\local-runtime\\python\r\n', 'latin1'),
    Buffer.from('2026-08-23T00:00:00.000Z [app] boot v1.70.0 — 설치 폴더 사용\n', 'utf8'),
  ]);
  assert.deepEqual(readInstallLogText(mixed), [
    '==== install start ====',
    'copy done → C:\\u\\local-runtime\\python',
    '2026-08-23T00:00:00.000Z [app] boot v1.70.0 — 설치 폴더 사용',
    '',
  ]);
  const whole16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\n나\r\n', 'utf16le')]);
  assert.deepEqual(readInstallLogText(whole16), ['a', '나', '']);
  // 깨진 바이트(어느 인코딩도 아님)도 예외 없이 문자열을 돌려준다
  assert.equal(typeof readInstallLogText(Buffer.from([0xff, 0x41, 0x0a, 0x80]))[0], 'string');
});
