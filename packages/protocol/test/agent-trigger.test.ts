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

test('지시문 노출 금지 — 구형 본문의 LLM 지시문을 걷어낸다', () => {
  // v1.29 이전 서버가 저장한 턴 — 안내 괄호 블록이 본문 선두에 있었다.
  const legacyAgent = parseAgentTrigger(
    '<agent_trigger:agent source="worker-1">\n' +
      '(당신이 위임했던 sub-agent 작업이 완료되었습니다. 아래 결과를 사용자에게\n' +
      ' 자연스럽게 보고하세요. 이 턴에서는 새로운 위임을 하지 마세요.)\n\n' +
      "- sub-agent 'w1' — 완료\n  [결과]\n실제 결과\n</agent_trigger:agent>",
  );
  assert.ok(legacyAgent);
  assert.ok(!legacyAgent.body.includes('보고하세요'), legacyAgent.body);
  assert.ok(legacyAgent.body.includes('실제 결과'));

  const legacySchedule = parseAgentTrigger(
    '<agent_trigger:schedule source="야간">\n' +
      "작업 '야간' 이 방금 실행되었다. 아래 실행 결과를 사용자에게 간결하게 전달하라 — 새 작업을 걸거나 다른 행동을 하지 마라.\n\n" +
      '결과 텍스트\n</agent_trigger:schedule>',
  );
  assert.ok(legacySchedule);
  assert.equal(legacySchedule.body, '결과 텍스트');
});

test('태그 이전 세대의 [영구 작업 결과 보고] 평문도 트리거로 정리한다', () => {
  const t = parseAgentTrigger(
    "[영구 작업 결과 보고] 작업 '야간 리포트' 이 방금 실행되었다. 아래 실행 결과를 사용자에게 간결하게 전달하라 — 새 작업을 걸거나 다른 행동을 하지 마라.\n\n결과 A",
  );
  assert.ok(t);
  assert.equal(t.kind, 'schedule');
  assert.equal(t.source, '야간 리포트');
  assert.equal(t.body, '결과 A');
});

test('현행 서버의 최소 영어 본문은 그대로 통과한다', () => {
  const t = parseAgentTrigger(
    '<agent_trigger:schedule source="nightly">\nJob \'nightly\' ended. Output:\n\nhello\n</agent_trigger:schedule>',
  );
  assert.ok(t);
  assert.equal(t.body, "Job 'nightly' ended. Output:\n\nhello");
});
