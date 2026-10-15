/**
 * 호출어 — 인식기가 호출어를 조금씩 다르게 적어도 찾고, 사람에게 하는 말에는 걸리지 않아야 한다.
 * 예시 글은 10/16 XGEN 실시간 STT 가 "헤이 엑스젠 …" 녹음을 받아 적은 그대로다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { afterWake, DEFAULT_WAKE_WORDS, findWake, parseWakeWords } from '../src/main/voice-wake';

const words = parseWakeWords(DEFAULT_WAKE_WORDS);

test('인식기가 다르게 적은 호출어도 찾는다', () => {
  for (const heard of [
    '헤이 엑스젠.',
    '헤이 엑젠.',
    '해이 엑스젠.',
    '헤이엑스젠',
    'Hey XGEN.',
    'Hey Gen',
  ]) {
    assert.ok(findWake(heard, words), heard);
  }
});

test('호출어 뒤의 말만 남긴다 — 뒷말과 붙어 적혀도', () => {
  assert.equal(afterWake('헤이 엑스젠 뒤로 가져.', words), '뒤로 가져.');
  assert.equal(afterWake('헤이 엑스젠. 검색 눌러', words), '검색 눌러');
  assert.equal(
    afterWake('헤이 엑스젠이 폴더의 신상품 자료를 읽고', words),
    '이 폴더의 신상품 자료를 읽고',
  );
  assert.equal(
    afterWake('Hey Gen 검색창에 날씨 입력하고 검색해.', words),
    '검색창에 날씨 입력하고 검색해.',
  );
  assert.equal(afterWake('자 그럼 헤이 엑스젠, 뉴스 눌러', words), '뉴스 눌러');
  assert.equal(afterWake('헤이 엑스젠.', words), '');
});

test('호출어가 없는 말에는 걸리지 않는다', () => {
  for (const heard of [
    '오늘은 엑스젠의 새로운 기능을 소개해드리겠습니다.',
    '엑스젠 에이전트를 배포하면 다른 시스템에서도 부를 수 있습니다',
    '헤이 여러분 안녕하세요',
    '에이 그건 아니고요',
    '이 폴더의 신상품 자료를 읽고 상품 소개문을 써줘',
    '뒤로 가기 눌러',
  ]) {
    assert.equal(findWake(heard, words), null, heard);
  }
});

test('설정 글은 쉼표·줄바꿈으로 나누고 너무 짧은 호출어는 뺀다', () => {
  assert.deepEqual(parseWakeWords('헤이 엑스젠, Hey XGEN\n자비스, 야'), [
    '헤이 엑스젠',
    'Hey XGEN',
    '자비스',
  ]);
  assert.deepEqual(parseWakeWords(undefined), ['헤이 엑스젠', 'Hey XGEN']);
  assert.deepEqual(parseWakeWords(''), []);
});
