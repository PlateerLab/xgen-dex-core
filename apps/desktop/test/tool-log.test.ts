/**
 * 전체 도구 로그.
 *
 * 채팅 흐름에는 도구 활동이 한 번에 하나만, 스르륵 지나간다 — 대화를 읽는 데
 * 방해가 되지 않는 유일한 방식이다. 하지만 무언가 잘못됐을 때는 정반대가
 * 필요하다: 전부, 순서대로, 인자와 결과까지. 그리고 그걸 **다른 곳으로
 * 옮길 수 있어야** 한다 (이슈, 동료, 다른 대화).
 *
 * 이름 줄이기 · 상태 · 복사용 텍스트의 규칙 테스트는 protocol 로 옮겼다
 * (packages/protocol/test/tool-activity.test.ts). 여기는 화면 배선만 본다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatToolLog, shortToolName } from '@dex/protocol/tool-activity';

const ROOT = join(__dirname, '..');
const CHAT = readFileSync(join(ROOT, 'src/renderer/src/views/Chat.tsx'), 'utf8');
const MODAL = readFileSync(join(ROOT, 'src/renderer/src/views/ToolLogModal.tsx'), 'utf8');

// ── 규칙의 출처 ───────────────────────────────────────────────────────

test('로그 창은 규칙을 protocol 에서 가져오고 사본을 두지 않는다', () => {
  assert.match(MODAL, /from '@dex\/protocol\/tool-activity'/);
  assert.doesNotMatch(MODAL, /function (shortToolName|formatToolLog|phaseOf|pretty)\b/);
});

test('데스크톱 경로로 불러도 복사용 텍스트는 예전 모양이다', () => {
  assert.equal(shortToolName('mcp__connector__Bash'), 'Bash');
  const out = formatToolLog([{ eventType: 'tool_result', toolName: 'mcp__connector__Bash', result: 'a.txt' }]);
  assert.match(out, /# 도구 실행 기록 \(1건\)/);
  assert.match(out, /## 1\. Bash — 완료/);
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
