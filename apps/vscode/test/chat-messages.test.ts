/**
 * 다른 기기의 도구 턴이 이 창에서 결과만 남던 문제(2026-10-01 사용자 보고).
 *
 * VS Code 창은 다른 화면(휴대폰·웹)이 돌린 턴이 끝나면 이력으로 다시 그린다. 이력에는 서버가 실행 기록에서
 * 되살린 작업 과정(process)이 있다 — 그것으로 이 창이 스트림으로 받은 턴과 같은 모양(답 + 도구 줄)을 만든다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryTurn } from '@dex/protocol';
import { historyTurnMessages, messageForView, phaseLines, textVerificationCandidate, verifyMessageProvenance } from '../src/chat-messages';

const turn = (rest: Partial<HistoryTurn>): HistoryTurn => ({
  logId: 1, ioId: 1, interactionId: 'c', workflowId: 'wf', workflowName: 'gitlab',
  input: '', output: '', attachments: [], updatedAt: '', ...rest,
});

test('지난 턴의 작업 과정이 도구 줄과 전체 로그의 원천이 된다', () => {
  const rows = historyTurnMessages(
    [
      turn({
        input: '내 앱 괜찮아?',
        output: '두 앱 모두 정상입니다.',
        ioId: 9,
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'AppList', toolUseId: 'a' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'AppList', toolUseId: 'a', durationMs: 40 } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_call', toolName: 'AppStatus', toolUseId: 'b' } },
          { kind: 'tool', at: 4, event: { eventType: 'tool_error', toolName: 'AppStatus', toolUseId: 'b', error: '중지됨' } },
          { kind: 'text', at: 5, text: '두 앱 모두 정상입니다.' },
        ],
      }),
    ],
    'gitlab',
  );
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant', 'activity', 'activity']);
  assert.deepEqual(rows.slice(2).map((r) => r.text), ['AppList · 완료 · 40ms', 'AppStatus · 실패 · 중지됨'], '호출 하나에 한 줄, 마지막 상태');
  assert.equal(rows[1].tools?.length, 4);
  assert.deepEqual(rows[3].toolRef, { assistantId: rows[1].id, index: 3 }, '줄을 누르면 그 호출의 마지막 사건이 열린다');
});

test('도구를 안 쓴 턴과 옛 서버의 턴은 예전 모양 그대로다', () => {
  const rows = historyTurnMessages([turn({ input: 'ㅎㅇ', output: '안녕하세요' })], 'gitlab');
  assert.deepEqual(rows.map((r) => [r.role, r.text]), [['user', 'ㅎㅇ'], ['assistant', '안녕하세요']]);
  assert.equal(rows[1].tools, undefined);
});

test('이력의 출처 선언은 검증과 분리되고 proof는 webview로 넘어가지 않는다', () => {
  const [_, answer] = historyTurnMessages([
    turn({
      output: '현재 본문',
      generatedContent: [{
        indication: 'ai_generated', proof: 'a.b.c', sha256: 'a'.repeat(64),
        content_type: 'text/plain', byte_length: 13,
        source_id: '123e4567-e89b-42d3-a456-426614174000',
      }],
    }),
  ], 'Agent');
  assert.deepEqual(textVerificationCandidate(answer), { ok: true, proof: 'a.b.c', text: '현재 본문' });
  const visible = messageForView(answer);
  assert.deepEqual(visible.provenance, {
    label: 'AI 생성 표시 · 확인 전', status: 'declared', canVerify: true, verified: false,
  });
  assert.equal('generatedContent' in visible, false);
  assert.equal(JSON.stringify(visible).includes('a.b.c'), false);
});

test('실제 본문 bytes 없는 미디어 선언은 검증할 수 없다', () => {
  const media = historyTurnMessages([
    turn({
      output: '그림을 만들었습니다.',
      generatedContent: [{
        indication: 'ai_generated', proof: 'x.y.z', sha256: 'b'.repeat(64),
        content_type: 'image/png', byte_length: 42,
        source_id: '223e4567-e89b-42d3-a456-426614174000', artifact_path: 'result.png',
      }],
    }),
  ], 'Agent')[1];
  assert.deepEqual(textVerificationCandidate(media), { ok: false, reason: 'media_only' });
  assert.equal(messageForView(media).provenance?.canVerify, false);
});

test('본문과 미디어 선언이 함께 있어도 검증 표시는 본문 범위로 한정한다', () => {
  const answer = historyTurnMessages([
    turn({
      output: '본문',
      generatedContent: [
        {
          indication: 'ai_generated', proof: 'a.b.c', sha256: 'a'.repeat(64), content_type: 'text/plain',
          byte_length: 6, source_id: '123e4567-e89b-42d3-a456-426614174000',
        },
        {
          indication: 'ai_generated', proof: 'x.y.z', sha256: 'b'.repeat(64), content_type: 'image/png',
          byte_length: 42, source_id: '223e4567-e89b-42d3-a456-426614174000', artifact_path: 'result.png',
        },
      ],
    }),
  ], 'Agent')[1];
  answer.provenanceCheck = 'verified';
  assert.equal(messageForView(answer).provenance?.label, '본문 출처 확인됨');
});

test('서명 없는 이전 답변은 AI 생성으로 승격하지 않는다', () => {
  const answer = historyTurnMessages([turn({ output: '이전 답변' })], 'Agent')[1];
  assert.deepEqual(messageForView(answer).provenance, {
    label: '출처 정보 없음', status: 'missing', canVerify: true, verified: false,
  });
});

test('검증 callback은 실제 현재 본문을 쓰고 늦은 성공은 본문 변경 뒤 적용하지 않는다', async () => {
  const answer = historyTurnMessages([turn({ output: '현재 본문' })], 'Agent')[1];
  let resolve!: (value: {
    status: 'verified'; signature_valid: true; content_match: true; actor_match: true; statement: null;
  }) => void;
  const pending = new Promise<{
    status: 'verified'; signature_valid: true; content_match: true; actor_match: true; statement: null;
  }>((done) => { resolve = done; });
  let observed: { proof: string | null; text: string } | undefined;
  const checking = verifyMessageProvenance(answer, (proof, text) => {
    observed = { proof, text };
    return pending;
  }, () => true);
  assert.deepEqual(observed, { proof: null, text: '현재 본문' });
  answer.text = '바뀐 본문';
  answer.provenanceCheck = undefined;
  resolve({ status: 'verified', signature_valid: true, content_match: true, actor_match: true, statement: null });
  assert.equal(await checking, false);
  assert.equal(answer.provenanceCheck, undefined);
});

test('검증 실패는 verified를 남기지 않는다', async () => {
  const answer = historyTurnMessages([turn({ output: '현재 본문' })], 'Agent')[1];
  answer.provenanceCheck = 'verified';
  assert.equal(await verifyMessageProvenance(answer, async () => { throw new Error('offline'); }, () => true), true);
  assert.equal(answer.provenanceCheck, 'failed');
});

test('호출 id 가 없는 도구도 호출 하나에 한 줄 — "실행 중" 이 남지 않는다', () => {
  const rows = historyTurnMessages(
    [
      turn({
        output: '끝',
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'Read' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'Read' } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_call', toolName: 'Read' } },
          { kind: 'tool', at: 4, event: { eventType: 'tool_error', toolName: 'Read', error: '없음' } },
        ],
      }),
    ],
    'gitlab',
  );
  assert.deepEqual(rows.filter((r) => r.role === 'activity').map((r) => r.text), ['Read · 완료', 'Read · 실패 · 없음']);
});

test('준비 단계 줄: 0.7초 넘은 단계만, 다 끝났는데 답이 아직이면 답변 준비 줄을 잇는다', () => {
  // 서버가 Sandbox·워크스페이스를 불러오는 동안 점 대신 무엇을 기다리는지 보인다(turn_phase).
  const rows = [
    { phase: 'sandbox' as const, state: 'ok' as const, startedAt: 0, durationMs: 12_300 },
    { phase: 'memory' as const, state: 'ok' as const, startedAt: 12_300, durationMs: 100 },
  ];
  assert.deepEqual(phaseLines(rows, 12_500), [{ label: 'Sandbox를 불러왔습니다', state: 'ok', time: '12.3초' }]);
  assert.deepEqual(phaseLines(rows, 15_400).at(-1), { label: '답변을 준비하고 있습니다', state: 'run', time: '3초' });
  assert.deepEqual(phaseLines([{ phase: 'workspace', state: 'run', startedAt: 0 }], 300), [], '빠른 단계는 보이지 않는다');
});
