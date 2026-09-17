/**
 * 작업 과정 타임라인 규칙.
 *
 * 이 화면은 어떤 에이전트의 어떤 도구에도 같은 규칙으로 동작해야 한다 — 특정 시연·고객·서비스 이름을
 * 알아보는 분기가 끼어들면 그 에이전트에서만 그럴듯하고 나머지에서는 거짓 이름표가 붙는다.
 * 그래서 규칙 테스트와 함께 "이름으로 특수 처리하지 않는다" 를 소스 수준에서 지킨다.
 *
 * 이 규칙은 데스크톱 화면에서 태어나 여기(정본)로 올라왔다 — 웹 채팅이 같은 타임라인을 그린다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ToolEvent } from '../src/types';
import {
  buildSteps,
  describeTool,
  resultView,
  splitFirstParagraph,
  summarizeCommand,
  trimAnswer,
  type TimelineFlowItem,
} from '../src/process-timeline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const text = (t: string, at: number): TimelineFlowItem => ({ kind: 'text', text: t, at });
const tool = (e: Partial<ToolEvent>, at: number): TimelineFlowItem => ({
  kind: 'tool',
  at,
  event: { eventType: 'tool_call', ...e } as ToolEvent,
});

// ── 단계 묶기 ─────────────────────────────────────────────────────────

test('진행 문장 뒤에 부른 도구가 그 단계에 붙고, 도구 뒤의 글은 새 단계를 연다', () => {
  const steps = buildSteps([
    text('자료를 읽', 1),
    text('습니다.', 2),
    tool({ toolName: 'Read', toolUseId: 'a', toolInput: { file_path: 'x.txt' } }, 3),
    tool({ eventType: 'tool_result', toolName: 'Read', toolUseId: 'a', result: 'hello', durationMs: 12 }, 4),
    text('\n\n정리합니다.\n\n## 결과\n본문', 5),
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, '자료를 읽습니다.');
  assert.equal(steps[0].rows.length, 1);
  assert.equal(steps[0].rows[0].phase, 'ok');
  assert.equal(steps[0].rows[0].durationMs, 12);
  assert.equal(steps[0].rows[0].startedAt, 3);
  assert.deepEqual(splitFirstParagraph(steps[1].text), { title: '정리합니다.', body: '## 결과\n본문' });
});

test('id 로 호출을 맞춘다 — 같은 이름의 동시 호출이 섞여도 결과가 제 호출에 붙는다', () => {
  const steps = buildSteps([
    tool({ toolName: 'lookup', toolUseId: '1', toolInput: { id: 'A' } }, 1),
    tool({ toolName: 'lookup', toolUseId: '2', toolInput: { id: 'B' } }, 2),
    tool({ eventType: 'tool_result', toolName: 'lookup', toolUseId: '2', result: 'b' }, 3),
    tool({ eventType: 'tool_error', toolName: 'lookup', toolUseId: '1', error: 'boom' }, 4),
  ]);
  const [first, second] = steps[0].rows;
  assert.equal(first.phase, 'err');
  assert.equal(first.error, 'boom');
  assert.equal(second.phase, 'ok');
  assert.equal(second.result, 'b');
});

test('최종 답 앞뒤의 가로줄·빈 줄은 걷고 본문 중간과 표 구분 행은 그대로 둔다', () => {
  assert.equal(trimAnswer('\n---\n\n## 결과\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n끝\n\n***\n'), '## 결과\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n끝');
  assert.equal(trimAnswer('그냥 답'), '그냥 답');
});

// ── 이름표 ────────────────────────────────────────────────────────────

test('셸 스크립트는 목적을 짐작하지 않고 언어·줄 수·모듈만 적는다', () => {
  const cmd = "cd /w && python3 << 'EOF'\nimport json, re\nfrom urllib.parse import quote\nimport requests as rq\nprint(1)\nEOF";
  assert.equal(summarizeCommand(cmd), '파이썬 스크립트 6줄 · json, re, urllib, requests');
  assert.equal(summarizeCommand('ls -la uploads/'), 'ls -la uploads/');
  assert.equal(describeTool('Bash', { command: 'echo hi' }).icon, 'terminal');
});

test('기본 도구가 아니면 등록된 설명 첫 마디, 없으면 이름에 인자를 붙인다', () => {
  assert.deepEqual(describeTool('lookup_order', { order_id: 'O-1', verbose: true }), {
    icon: 'external',
    text: 'lookup_order · order_id O-1',
  });
  assert.deepEqual(describeTool('lookup_order', '{"order_id":"O-1"}', '주문 한 건을 조회합니다. 상태와 금액을 돌려줍니다.'), {
    icon: 'external',
    text: '주문 한 건을 조회합니다 · order_id O-1',
  });
  assert.equal(describeTool('mcp__connector__Read', { file_path: '/x/workspace/uploads/a.json' }).text, '파일 읽기 · uploads/a.json');
});

// ── 결과 모양 ─────────────────────────────────────────────────────────

test('안쪽 객체에 이름이 있으면 카드로, 바깥의 참/거짓은 함께 보인다', () => {
  const v = resultView(JSON.stringify({ found: true, item: { id: 'X1', name: '샘플 항목', price: '1,000', archived: false } }));
  assert.equal(v?.title, '샘플 항목');
  assert.deepEqual(v?.fields, [['id', 'X1'], ['price', '1,000']]);
  assert.deepEqual(v?.flags, [['archived', false], ['found', true]]);
});

test('객체 목록은 작은 표로, 이름 열을 앞에 두고 넘치면 건수만 적는다', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i, name: `n${i}`, ok: true, note: 'x' }));
  const v = resultView(JSON.stringify({ total: 7, items: rows }));
  assert.deepEqual(v?.table?.columns, ['name', 'id', 'note']);
  assert.equal(v?.table?.rows.length, 5);
  assert.equal(v?.table?.more, 2);
  assert.deepEqual(v?.fields, [['total', '7']]);
});

test('JSON 이 아니거나 잘렸으면 첫 줄과 줄 수', () => {
  assert.deepEqual(resultView('총 페이지 수: 85\n\n===\n[페이지 1]'), { fields: [], flags: [], line: '총 페이지 수: 85 · 4줄' });
  assert.equal(resultView('{"items": [{"name": "a"')?.line, '{"items": [{"name": "a"');
  assert.equal(resultView(''), null);
});

// ── 범용성 ────────────────────────────────────────────────────────────

test('특정 시연·서비스·도구 이름으로 분기하지 않는다', () => {
  // 화면에 새 규칙이 붙을 때마다 여기에 그 파일을 추가한다 — 한 곳이라도 빠지면
  // 그 파일에서만 특정 고객·시연 이름을 알아보는 분기가 조용히 살아남는다.
  const sources = ['src/process-timeline.ts', 'src/tool-activity.ts'];
  for (const rel of sources) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /롯데|lotte|check_goods|search_products|goods_no|위해상품/i, rel);
  }
});
