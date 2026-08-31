/**
 * 회귀 가드 — 메인 프로세스 소스에 **런타임 require 로 로컬 모듈**을 부르는 코드가 없어야 한다.
 *
 * electron-vite(rollup)는 정적 import 만 번들에 넣는다. `require('./x')` 는 그대로 남아 패키징본의
 * out/main/index.js 옆에 './x' 가 없으므로 'Cannot find module' 로 죽는다 — v1.68~1.70 의
 * "부팅 오류: wireLocalSync: Error: Cannot find module './workspace-bridge-tools'" 가 정확히 이것.
 * (node 내장/외부 패키지 require 는 번들러가 external 로 두므로 여기서 막지 않는다.)
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// Windows 체크아웃(CRLF)에서도 \n 정규식이 맞도록 줄끝을 정규화해 읽는다 (v1.65 Windows CI 교훈).
const readSrc = (f: string): string => readFileSync(f, 'utf-8').replace(/\r\n/g, '\n');

const MAIN = join(__dirname, '..', 'src', 'main');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** 주석을 벗겨 낸 소스 — 주석 속의 설명용 'require(./x)' 문구는 위반이 아니다. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** 로컬 모듈 런타임 require 찾기 — [파일:줄] 목록. */
export function findLocalRequires(src: string): number[] {
  const lines = stripComments(src).split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (/\brequire\(\s*['"]\.{1,2}\//.test(l)) hits.push(i + 1);
  });
  return hits;
}

test('src/main/**: 로컬 모듈(./ ../) 런타임 require 금지 — 정적 import 만', () => {
  const files = walk(MAIN);
  assert.ok(files.length > 10, '메인 소스가 보인다');
  const violations: string[] = [];
  for (const f of files) {
    for (const line of findLocalRequires(readSrc(f)))
      violations.push(`${f.replace(MAIN, 'src/main')}:${line}`);
  }
  assert.deepEqual(
    violations,
    [],
    `런타임 require('./…') 는 패키징본에서 Cannot find module 로 죽는다 — 정적 import 로 바꿀 것:\n${violations.join('\n')}`,
  );
});

test('가드 자체: 주석 속 문구는 통과, 실제 호출은 잡힌다(따옴표 두 종류, ../ 포함)', () => {
  assert.deepEqual(findLocalRequires("// require('./x') 금지\nconst a = 1;"), []);
  assert.deepEqual(findLocalRequires("/* const y = require('./y') */\nconst b = 2;"), []);
  assert.deepEqual(
    findLocalRequires(
      "const { A } = require('./a');\nconst B = require(\"../b\") as X;\nrequire('node:fs');",
    ),
    [1, 2],
  );
});

test('index.ts 의 WorkspaceBridge 는 정적 import 다(부팅 오류 원인 고정)', () => {
  const src = readSrc(join(MAIN, 'index.ts'));
  assert.match(src, /^import \{ WorkspaceBridge \} from '\.\/workspace-bridge-tools';/m);
});

test('로컬 실행 런타임은 이 앱에 없다 — 에이전트는 서버에서 돈다', () => {
  const src = readSrc(join(MAIN, 'index.ts'));
  for (const gone of [
    'local-chat-route',
    'local-agent-sidecar',
    'local-runtime-install',
    'local-runtime-ensure',
    'local-runtime-converge',
    'cli-provision',
  ]) {
    assert.ok(!src.includes(gone), `index.ts 가 아직 ${gone} 을 참조한다`);
  }
});
