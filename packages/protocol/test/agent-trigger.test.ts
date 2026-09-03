// 공통 트리거 파서 — 서버 wrap_trigger 산출물과의 왕복 계약.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentTrigger, triggerRowLabel } from '../src/agent-trigger';

test('schedule 태그 — kind/source/body 추출 + 속성 언이스케이프', () => {
  const t = parseAgentTrigger(
    '<agent_trigger:schedule source="야간 &quot;리포트&quot;">\n지시문\n결과 본문\n</agent_trigger:schedule>',
  );
  assert.ok(t);
  assert.equal(t.kind, 'schedule');
  assert.equal(t.source, '야간 "리포트"');
  assert.equal(t.body, '지시문\n결과 본문');
  assert.equal(triggerRowLabel(t), 'Trigger · 작업 · 야간 "리포트"');
});

test('agent 태그 + 앞 공백 허용', () => {
  const t = parseAgentTrigger('  \n<agent_trigger:agent source="worker-1">보고</agent_trigger:agent>');
  assert.ok(t);
  assert.equal(t.kind, 'agent');
  assert.equal(triggerRowLabel(t), 'Trigger · 서브에이전트 · worker-1');
});

test('구형 [SUB_AGENT_RESULT] — agent 트리거로 인식(과거 대화 호환)', () => {
  const t = parseAgentTrigger('[SUB_AGENT_RESULT]\n완료 보고 본문');
  assert.ok(t);
  assert.equal(t.kind, 'agent');
  assert.equal(t.body, '완료 보고 본문');
});

test('닫는 태그가 없어도(스트리밍/절단) 본문을 살린다', () => {
  const t = parseAgentTrigger('<agent_trigger:schedule source="x">잘린 본문');
  assert.ok(t);
  assert.equal(t.body, '잘린 본문');
});

test('사용자 발화는 오탐하지 않는다', () => {
  for (const s of ['안녕', '<b>굵게</b>', '<agent_trigger 아님>', '', null, undefined]) {
    assert.equal(parseAgentTrigger(s as string), null);
  }
});
