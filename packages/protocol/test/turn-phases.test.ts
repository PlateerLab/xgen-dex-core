/**
 * 턴 준비 단계. 답의 첫 글자 전에 커서 대신 무엇을 기다리는지 보인다.
 *
 * 워커 파드를 새로 띄우는 턴은 첫 글자까지 수십 초다. 그동안 커서만 깜박이면 사용자는 멈춘 것으로
 * 본다. 반대로 빠른 턴에 줄이 번쩍이면 그것도 잡음이다. 모든 앱이 이 규칙을 쓰므로 여기서 경계를
 * 못박는다(웹과 같은 경계·같은 문구).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AWAITING_ANSWER_LABEL,
  applyTurnPhase,
  awaitingAnswer,
  nextPhaseReveal,
  phaseHeadline,
  phaseLabel,
  startPhaseRows,
  tailPhaseRows,
  visiblePhaseRows,
  type TurnPhaseRow,
  type TurnPhaseSignal,
} from '../src/turn-phases';

const run = (rows: TurnPhaseRow[], ...signals: Array<[number, TurnPhaseSignal]>) =>
  signals.reduce((acc, [at, sig]) => applyTurnPhase(acc, sig, at), rows);

test('빠른 턴은 줄이 서지 않는다. 예전처럼 커서만 보인다', () => {
  const rows = run([],
    [0, { phase: 'sandbox', state: 'start' }],
    [30, { phase: 'sandbox', state: 'done', elapsedMs: 30 }],
    [30, { phase: 'workspace', state: 'start' }],
    [250, { phase: 'workspace', state: 'done', elapsedMs: 220 }],
  );
  assert.deepEqual(visiblePhaseRows(rows, 300), []);
  assert.equal(phaseHeadline(rows, 300), null);
});

test('오래 걸리는 단계는 0.7초가 지나면 선다', () => {
  const rows = run([], [0, { phase: 'sandbox', state: 'start' }]);
  assert.deepEqual(visiblePhaseRows(rows, 500), []);
  assert.equal(nextPhaseReveal(rows, 500), 200, '보이게 될 순간에 한 번 다시 그린다');
  assert.equal(phaseLabel(visiblePhaseRows(rows, 800)[0]), 'Sandbox를 불러오고 있습니다');
  assert.deepEqual(phaseHeadline(rows, 3_000), { label: 'Sandbox를 불러오고 있습니다', sinceMs: 3_000 });
});

test('끝난 느린 단계는 걸린 시간과 함께 남고, 다음 단계가 이어 선다', () => {
  const rows = run([],
    [0, { phase: 'sandbox', state: 'start' }],
    [12_300, { phase: 'sandbox', state: 'done', elapsedMs: 12_300 }],
    [12_300, { phase: 'workspace', state: 'start' }],
  );
  const shown = visiblePhaseRows(rows, 13_500);
  assert.deepEqual(shown.map((r) => [r.phase, r.state, r.durationMs]), [['sandbox', 'ok', 12_300], ['workspace', 'run', undefined]]);
  assert.equal(phaseHeadline(rows, 13_500)?.label, '워크스페이스를 불러오고 있습니다');
});

test('다시 시도는 같은 줄에서 몇 번째인지 말하고, 끝내 못 붙으면 그렇다고 남는다', () => {
  let rows = run([],
    [0, { phase: 'workspace', state: 'start', attempt: 1 }],
    [300, { phase: 'workspace', state: 'retry', attempt: 1, attempts: 3, elapsedMs: 300 }],
  );
  assert.equal(visiblePhaseRows(rows, 310).length, 1, '다시 시도는 짧아도 보인다');
  rows = run(rows, [2_000, { phase: 'workspace', state: 'start', attempt: 2 }]);
  assert.equal(rows.length, 1, '같은 단계는 한 줄이다');
  assert.equal(phaseLabel(rows[0]), '워크스페이스를 불러오고 있습니다 (다시 시도 2/3)');
  rows = run(rows, [2_100, { phase: 'workspace', state: 'error', attempt: 3, attempts: 3, elapsedMs: 100 }]);
  assert.equal(rows[0].state, 'err');
  assert.match(phaseLabel(rows[0]), /도구를 쓸 때 다시 연결합니다/);
});

test('준비가 다 끝났는데 답이 아직이면 답변 준비 줄을 잇는다. 틈에는 번쩍이지 않는다', () => {
  const rows = run([],
    [0, { phase: 'sandbox', state: 'start' }],
    [5_000, { phase: 'sandbox', state: 'done', elapsedMs: 5_000 }],
  );
  assert.equal(awaitingAnswer(rows, 5_300), false, '다음 단계가 곧 시작할 수 있다');
  assert.equal(awaitingAnswer(rows, 5_800), true);
  assert.deepEqual(phaseHeadline(rows, 6_000), { label: AWAITING_ANSWER_LABEL, sinceMs: 1_000 });
  const more = run(rows, [5_100, { phase: 'memory', state: 'start' }]);
  assert.equal(awaitingAnswer(more, 6_000), false, '하는 중인 단계가 있으면 잇지 않는다');
});

test('새 에이전트의 첫 실행(assemble)은 기다리지 않고 바로 머리 줄로 서고, 그동안 답변 준비 줄은 겹치지 않는다', () => {
  let rows = run([], [0, { phase: 'assemble', state: 'start' }]);
  assert.equal(visiblePhaseRows(rows, 10).length, 1, '0.7초를 기다리지 않는다');
  assert.deepEqual(phaseHeadline(rows, 3_000), { label: 'Geny를 조립하고 있어요! 첫 생성에는 시간이 좀 걸려요!', sinceMs: 3_000 });
  rows = run(rows, [100, { phase: 'sandbox', state: 'start' }]);
  assert.equal(phaseHeadline(rows, 3_000)?.label, 'Sandbox를 불러오고 있습니다', '한 줄 화면은 지금 하는 단계를 먼저 말한다');
  rows = run(rows, [9_000, { phase: 'sandbox', state: 'done', elapsedMs: 8_900 }]);
  assert.deepEqual(visiblePhaseRows(rows, 20_000).map((r) => r.phase), ['assemble', 'sandbox']);
  assert.equal(awaitingAnswer(rows, 20_000), false, '조립 줄이 이미 기다리는 중을 말한다');
  assert.equal(phaseHeadline(rows, 20_000)?.label, 'Geny를 조립하고 있어요! 첫 생성에는 시간이 좀 걸려요!');
});

test('답이 다 나온 뒤의 단계는 답 아래 줄로 따로 모이고, 답 전의 카드와 답변 준비 판정을 건드리지 않는다', () => {
  const rows = run([],
    [0, { phase: 'sandbox', state: 'start' }],
    [3_000, { phase: 'sandbox', state: 'done', elapsedMs: 3_000 }],
    [60_000, { phase: 'publish', state: 'start' }],
  );
  assert.deepEqual(startPhaseRows(rows).map((r) => r.phase), ['sandbox']);
  assert.deepEqual(tailPhaseRows(rows).map((r) => r.phase), ['publish']);
  assert.equal(phaseLabel(visiblePhaseRows(tailPhaseRows(rows), 61_000)[0]), '작업 폴더를 저장하고 있습니다');
  assert.equal(awaitingAnswer(rows, 61_000), true, '답 뒤의 단계는 답 전 판정에 섞이지 않는다');
  assert.deepEqual(visiblePhaseRows(tailPhaseRows(rows), 60_300), [], '빨리 끝나는 마무리는 번쩍이지 않는다');
});
