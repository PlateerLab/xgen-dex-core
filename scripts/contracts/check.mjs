#!/usr/bin/env node
/**
 * 이 저장소가 무너지는 방식은 하나뿐이다 — **누가 코어를 우회하는 것.**
 *
 * 우회는 악의가 아니라 급함에서 나온다. 앱에서 한 줄 fetch 하면 5분이면 되는데
 * 패키지를 고치면 세 앱을 다시 확인해야 하니까. 그렇게 한 줄이 들어가고, 몇 달 뒤
 * 그 한 줄이 다른 앱과 다르게 동작한다는 것을 사용자가 먼저 발견한다. 실제로
 * 그렇게 됐었다 — 커넥터와 CLI 가 같은 WebSocket 프로토콜을 각자 구현했고 재접속
 * 정책이 서로 달랐다.
 *
 * 그래서 사람의 규율 대신 검사를 둔다.
 *
 *   1. 앱이 `/api/...` 를 직접 부르지 않는다        (서버와 말하는 곳은 프로토콜뿐)
 *   2. 앱이 `ws(s)://` 를 직접 열지 않는다          (브릿지는 하나뿐)
 *   3. 패키지가 electron 을 import 하지 않는다      (엔진은 호스트를 모른다)
 *   4. 도메인 타입을 앱에서 다시 선언하지 않는다    (세 번째 사본을 막는다)
 *   5. 확장 번들에 엔진이 들어가지 않는다           (RPC 경계는 물리적이다)
 *
 * 위반은 값으로 보고한다 — "규칙 위반"이 아니라 "어느 파일 몇 번째 줄에 무엇이".
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

const violations = [];
const add = (rule, file, line, detail) =>
  violations.push({ rule, file: relative(ROOT, file), line, detail });

// ── 1·2. 앱은 서버와 직접 말하지 않는다 ─────────────────────────────
//
// 데스크톱 preload/renderer 는 예외가 아니다 — 거기서 호출해도 앱마다 갈라진다.
// 유일한 예외는 프로토콜 자신과, URL 을 조립만 하고 부르지는 않는 곳이다.
for (const app of ['apps/desktop/src', 'apps/cli/src', 'apps/vscode/src']) {
  for (const file of walk(join(ROOT, app))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // 주석은 본다고 부르는 게 아니다
      const api = text.match(/['"`](\/api\/[a-zA-Z0-9/_\-{}$.:]*)/);
      if (api) add('no-direct-api', file, i + 1, api[1]);
      // 로컬 devtools(크롬 디버깅 포트)는 XGEN 서버가 아니다 — 브릿지의 대상이
      // 아니고, 이 앱이 띄운 브라우저와 말하는 자기 일이다.
      const ws = text.match(/['"`]wss?:\/\//);
      if (ws && !/devtools|127\.0\.0\.1|localhost/.test(text)) {
        add('no-direct-ws', file, i + 1, text.trim().slice(0, 70));
      }
    });
  }
}

// ── 3. 패키지는 호스트를 모른다 ─────────────────────────────────────
for (const file of walk(join(ROOT, 'packages'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // 주석에서 electron 을 *언급*하는 건 결합이 아니다
    if (/from ['"]electron['"]|import\(['"]electron['"]\)|require\(['"]electron['"]\)/.test(text)) {
      add('engine-knows-no-host', file, i + 1, text.trim().slice(0, 70));
    }
  });
}

// ── 4. 도메인 타입은 한 번만 선언한다 ───────────────────────────────
//
// 이름 목록이 아니라 **프로토콜이 실제로 export 하는 것**과 대조한다. 목록을
// 손으로 관리하면 새 타입이 추가될 때 이 검사만 조용히 낡는다.
const protoTypes = new Set();
for (const file of walk(join(ROOT, 'packages/protocol/src'))) {
  for (const m of readFileSync(file, 'utf8').matchAll(/^export (?:interface|type) (\w+)/gm)) {
    protoTypes.add(m[1]);
  }
}
for (const app of ['apps/desktop/src', 'apps/cli/src', 'apps/vscode/src']) {
  for (const file of walk(join(ROOT, app))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const m = text.match(/^export (?:interface|type) (\w+)/);
      if (m && protoTypes.has(m[1])) add('no-redeclared-domain-type', file, i + 1, m[1]);
    });
  }
}

// ── 5. 확장은 엔진을 품지 않는다 ────────────────────────────────────
//
// 소스가 아니라 **빌드 산출물**을 본다. import 문은 통과해도 번들러가 끌고 오는
// 경로가 남아 있으면 .vsix 안에 네이티브 모듈이 들어가고, 그건 설치 시점에야
// 터진다.
const vsix = join(ROOT, 'apps/vscode/dist/extension.js');
if (existsSync(vsix)) {
  const bundle = readFileSync(vsix, 'utf8');
  for (const marker of ['keytar', 'LocalToolProvider', 'class McpBridge']) {
    if (bundle.includes(marker)) {
      add('rpc-boundary', vsix, 0, `번들에 엔진 흔적: ${marker}`);
    }
  }
}

// ── 보고 ────────────────────────────────────────────────────────────
const RULES = {
  'no-direct-api': '앱이 서버 경로를 직접 부른다 — @dex/protocol 에 넣고 거기서 부르세요',
  'no-direct-ws': '앱이 WebSocket 을 직접 연다 — @dex/engine 의 브릿지를 쓰세요',
  'engine-knows-no-host': '패키지가 electron 을 안다 — 포트(ports/index.ts)로 받으세요',
  'no-redeclared-domain-type': '도메인 타입을 다시 선언했다 — @dex/protocol 에서 가져오세요',
  'rpc-boundary': '확장 번들에 엔진이 들어갔다 — @dex/rpc/client 만 가져오세요',
};

if (violations.length === 0) {
  console.log('계약 검사 통과 — 앱이 코어를 우회하는 곳이 없습니다.');
  process.exit(0);
}
const byRule = new Map();
for (const v of violations) (byRule.get(v.rule) ?? byRule.set(v.rule, []).get(v.rule)).push(v);
for (const [rule, list] of byRule) {
  console.error(`\n✗ ${rule} — ${RULES[rule]}`);
  for (const v of list) console.error(`    ${v.file}:${v.line}  ${v.detail}`);
}
console.error(`\n위반 ${violations.length}건.`);
process.exit(1);
