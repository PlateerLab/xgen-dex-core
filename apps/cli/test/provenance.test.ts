import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provenanceLabel, textVerificationCandidate } from '../src/tui/provenance';

const proof = {
  indication: 'ai_generated' as const,
  proof: 'a.b.c',
  sha256: 'a'.repeat(64),
  content_type: 'text/plain',
  byte_length: 5,
  source_id: '123e4567-e89b-42d3-a456-426614174000',
};

test('검증 입력은 현재 표시 본문과 단 하나의 본문 proof만 사용한다', () => {
  assert.deepEqual(textVerificationCandidate({ text: '현재 답', generatedContent: [proof] }), {
    ok: true,
    proof: 'a.b.c',
    text: '현재 답',
  });
  assert.deepEqual(
    textVerificationCandidate({
      text: '현재 답',
      generatedContent: [{ ...proof, content_type: 'image/png', artifact_path: 'answer.png' }],
    }),
    { ok: false, reason: 'media_only' },
    '실제 미디어 bytes가 없는 UI는 미디어를 검증하지 않는다',
  );
});

test('손상되거나 모호한 metadata는 서버 검증 입력으로 보내지 않는다', () => {
  assert.deepEqual(textVerificationCandidate({ text: '답', malformedGeneratedContent: true }), {
    ok: false,
    reason: 'malformed',
  });
  assert.deepEqual(textVerificationCandidate({ text: '답', generatedContent: [proof, { ...proof, source_id: '223e4567-e89b-42d3-a456-426614174000' }] }), {
    ok: false,
    reason: 'ambiguous',
  });
});

test('AI 생성 표시는 검증 완료와 구분되고 서명 없는 이전 답변은 중립 표시다', () => {
  assert.equal(provenanceLabel({ text: '답', generatedContent: [proof], provenanceFinal: true }), 'AI 생성 표시 · 확인 전');
  assert.equal(provenanceLabel({ text: '답', provenanceFinal: true }), '출처 정보 없음');
  assert.equal(provenanceLabel({ text: '답', provenanceCheck: 'unsigned_legacy' }), '서명 정보 없음');
  assert.equal(provenanceLabel({ text: '답', provenanceCheck: 'verified' }), '본문 출처 확인됨');
});
