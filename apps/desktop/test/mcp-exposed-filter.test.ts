/** 내부 도구(_ 접두)는 "에이전트에 노출된 도구" 목록에서 제외된다 — 서버가 LLM 노출에서
 *  거르는 실행 브리지 라우트(_Exec/_WorkspaceInfo 등)라 모델이 부를 수 없고, 사용자에게
 *  불필요·혼란만 준다(자동 관리되는 로컬/서버 실행 환경의 내부 배관). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '..', 'src', 'renderer', 'src', 'views', 'McpSettings.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');

test('노출 도구 패널이 _ 접두 내부 도구를 거른다', () => {
  // isExposed 로 _-접두를 제외하고, 그 결과로 total/목록을 만든다.
  assert.match(
    SRC,
    /const isExposed = \(name: string\): boolean => !String\(name \|\| ''\)\.startsWith\('_'\)/,
  );
  assert.match(SRC, /\.filter\(\(t\) => isExposed\(t\.name\)\)/);
  // total 은 필터된 servers 에서 계산한다(내부 도구가 개수에 안 잡힘).
  assert.match(SRC, /const total = externals\.reduce/);
});

test('복사는 main clipboard(copyText)를 쓴다 — navigator.clipboard 직접 사용 없음', () => {
  assert.match(SRC, /copyText\(/);
  assert.doesNotMatch(SRC, /navigator\.clipboard\.writeText/);
});

test('MCP 탭 패널은 외부 MCP 서버만 — 내장(local) 도구는 제외', () => {
  // 기본 로컬 실행 경로에서 에이전트는 런타임 자체 도구를 쓰고, 커넥터 내장 도구는 로컬 턴에
  // 주입되지 않는다. MCP 탭 패널은 내가 등록한 외부 MCP 서버만 보여준다('local' 제외).
  assert.match(SRC, /\.filter\(\(s\) => s\.name !== 'local'\)/);
  assert.doesNotMatch(SRC, /const builtin = /);
  assert.doesNotMatch(SRC, /builtinOpen/);
  assert.match(SRC, /MCP 서버 도구/); // 헤더
  assert.match(SRC, /PC 컨트롤·브라우저 탭에서 관리/); // 내장은 MCP 서버 아님 안내
});
