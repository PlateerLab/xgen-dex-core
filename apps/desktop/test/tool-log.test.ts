/**
 * 전체 도구 로그.
 *
 * 채팅 흐름에는 도구 활동이 한 번에 하나만, 스르륵 지나간다 — 대화를 읽는 데
 * 방해가 되지 않는 유일한 방식이다. 하지만 무언가 잘못됐을 때는 정반대가
 * 필요하다: 전부, 순서대로, 인자와 결과까지. 그리고 그걸 **다른 곳으로
 * 옮길 수 있어야** 한다 (이슈, 동료, 다른 대화).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatToolLog, shortToolName } from '../src/renderer/src/views/ToolLogModal';

const ROOT = join(__dirname, '..');
const CHAT = readFileSync(join(ROOT, 'src/renderer/src/views/Chat.tsx'), 'utf8');
const MODAL = readFileSync(join(ROOT, 'src/renderer/src/views/ToolLogModal.tsx'), 'utf8');

// ── 이름 ──────────────────────────────────────────────────────────────

test('브릿지 접두사를 걷어낸다', () => {
  // 그대로 두면 목록이 접두사로만 채워져 구분되지 않는다 — 실제로 화면에서
  // `mcp__connector__mcp_mcp-atlassi…` 로 잘려 보였다.
  assert.equal(
    shortToolName('mcp__connector__mcp_mcp-atlassian_jira_search'),
    'atlassian_jira_search',
  );
  assert.equal(shortToolName('mcp__connector__Bash'), 'Bash');
  assert.equal(shortToolName('Bash'), 'Bash');
});

test('이름이 없어도 빈 칸을 남기지 않는다', () => {
  assert.equal(shortToolName(undefined), '(이름 없음)');
  assert.equal(shortToolName('  '), '(이름 없음)');
});

// ── 복사용 텍스트 ─────────────────────────────────────────────────────

test('붙여넣을 곳에서 그대로 읽힌다', () => {
  // JSON 덩어리 하나로 주면 이슈에 붙였을 때 아무도 안 읽는다.
  const out = formatToolLog([
    {
      eventType: 'tool_result',
      toolName: 'mcp__connector__Bash',
      toolInput: { command: 'ls' },
      result: 'a.txt',
      durationMs: 12,
    },
  ]);
  assert.match(out, /# 도구 실행 기록 \(1건\)/);
  assert.match(out, /## 1\. Bash — 완료/);
  assert.match(out, /### 입력/);
  assert.match(out, /"command": "ls"/);
  assert.match(out, /### 결과/);
  assert.match(out, /소요: 12ms/);
});

test('짧게 줄인 이름 때문에 원본을 잃지 않는다', () => {
  const out = formatToolLog([
    { eventType: 'tool_result', toolName: 'mcp__connector__mcp_x_y', result: 'ok' },
  ]);
  assert.match(out, /전체 이름: mcp__connector__mcp_x_y/);
});

test('실패는 실패로 적힌다', () => {
  const out = formatToolLog([{ eventType: 'tool_error', toolName: 'Bash', error: '터짐' }]);
  assert.match(out, /— 실패/);
  assert.match(out, /### 오류/);
  assert.match(out, /터짐/);
});

test('순서가 보존된다', () => {
  const out = formatToolLog([
    { eventType: 'tool_result', toolName: 'A' },
    { eventType: 'tool_result', toolName: 'B' },
  ]);
  assert.ok(out.indexOf('## 1. A') < out.indexOf('## 2. B'));
});

test('비어 있어도 터지지 않는다', () => {
  assert.match(formatToolLog([]), /0건/);
});

test('직렬화할 수 없는 인자도 삼키지 않는다', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const out = formatToolLog([{ eventType: 'tool_call', toolName: 'X', toolInput: cyclic }]);
  assert.match(out, /## 1\. X/); // 한 항목이 전체 복사를 깨뜨리지 않는다
});

// ── 배선 ──────────────────────────────────────────────────────────────

test('답변 아래에 작은 버튼으로 붙는다', () => {
  assert.match(CHAT, /className="toollog-open"/);
  assert.match(CHAT, /전체 로그 보기/);
});

test('푸터의 전체 로그 버튼은 끝난 뒤에만 붙는다', () => {
  // 아직 늘어나는 목록의 "전체"를 자처하지 않는다 — 푸터 자체가
  // !m.streaming 게이트 안에 있다.
  assert.match(CHAT, /!m\.streaming &&\s*\n?\s*\(\(!!m\.text/);
});

test('진행 중에는 도구 칩 클릭이 그 시점의 로그를 연다', () => {
  // 칩은 하나씩 빠르게 지나간다 — 누르면 클릭 시점 스냅숏이, 그 도구가
  // 펼쳐진 채(initialOpen) 열린다.
  assert.match(CHAT, /onOpen=\{\(ev\)/);
  assert.match(CHAT, /lastIndexOf\(ev\)/);
  assert.match(MODAL, /initialOpen/);
});

test('푸터는 한 줄이다 — 복사\/공유(좌) · 전체 로그(우)', () => {
  assert.match(CHAT, /className="msg-footer"/);
});

test('복사가 1급이다', () => {
  // 스크롤해서 드래그하게 만들면 이 기능이 없는 것과 같다.
  assert.match(MODAL, /전체 복사/);
  assert.match(MODAL, /이 항목 복사/);
  // 복사는 main 프로세스 clipboard(copyText)를 쓴다 — 렌더러 navigator.clipboard 는
  // Electron 에서 "Write permission denied" 로 조용히 실패한다.
  assert.match(MODAL, /copyText\(/);
  assert.doesNotMatch(MODAL, /navigator\.clipboard\.writeText/);
});

test('복사 실패를 성공이라 하지 않는다', () => {
  // 조용히 넘기면 사용자는 복사됐다고 믿고 엉뚱한 것을 붙여넣는다.
  assert.match(MODAL, /setCopyError/);
  assert.match(MODAL, /복사하지 못했습니다/);
});

test('Esc 로 닫힌다', () => {
  assert.match(MODAL, /key === 'Escape'/);
});
