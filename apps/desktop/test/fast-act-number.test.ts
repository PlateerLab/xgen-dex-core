import assert from 'node:assert/strict';
import test from 'node:test';
import { textFromWordAnswers } from '../src/main/fast-act';
import { plainNumber } from '../src/main/fast-act-number';

test('단위 붙은 말과 한글 자릿수를 숫자만으로 바꾼다', () => {
  assert.equal(plainNumber('20000원'), '20000');
  assert.equal(plainNumber('2만 원'), '20000');
  assert.equal(plainNumber('2만원'), '20000');
  assert.equal(plainNumber('1만 8천원'), '18000');
  assert.equal(plainNumber('1.5만'), '15000');
  assert.equal(plainNumber('3백만 원'), '3000000');
  assert.equal(plainNumber('20,000'), '20000');
  assert.equal(plainNumber(' 15% '), '15');
  assert.equal(plainNumber('100개'), '100');
  assert.equal(plainNumber('2.5kg'), '2.5');
  assert.equal(plainNumber('5일'), '5');
});

test('한글 숫자는 자릿수와 함께일 때 숫자로 바꾼다', () => {
  assert.equal(plainNumber('이만 원'), '20000');
  assert.equal(plainNumber('만 팔천 원'), '18000');
  assert.equal(plainNumber('만 원'), '10000');
  assert.equal(plainNumber('오천원'), '5000');
  assert.equal(plainNumber('2만 오천'), '25000');
  assert.equal(plainNumber('십만'), '100000');
  assert.equal(plainNumber('1억 2천만'), '120000000');
  assert.equal(plainNumber('삼백 개'), '300');
  assert.equal(plainNumber('삼성'), null);
  assert.equal(plainNumber('삼'), null);
  assert.equal(plainNumber('이삼만'), null);
  assert.equal(plainNumber('구매'), null);
});

test('고유어 수는 셈 단위 말이 뒤따를 때만 숫자로 바꾼다', () => {
  assert.equal(plainNumber('열 개'), '10');
  assert.equal(plainNumber('열개'), '10');
  assert.equal(plainNumber('열두 개'), '12');
  assert.equal(plainNumber('열 두 개'), '12');
  assert.equal(plainNumber('스물다섯 장'), '25');
  assert.equal(plainNumber('스무 개'), '20');
  assert.equal(plainNumber('세 개'), '3');
  assert.equal(plainNumber('한 번'), '1');
  assert.equal(plainNumber('하나'), null);
  assert.equal(plainNumber('네'), null);
  assert.equal(plainNumber('열'), null);
  assert.equal(plainNumber('열한'), null);
  assert.equal(plainNumber('열어'), null);
  assert.equal(plainNumber('세탁기'), null);
  assert.equal(plainNumber('한국 상품'), null);
});

test('숫자만이거나 숫자 말이 아니면 null', () => {
  assert.equal(plainNumber('20000'), null);
  assert.equal(plainNumber('3.5'), null);
  assert.equal(plainNumber('아이폰 15'), null);
  assert.equal(plainNumber('10 20'), null);
  assert.equal(plainNumber('15일 이내 배송'), null);
  assert.equal(plainNumber(''), null);
  assert.equal(plainNumber('1만만'), null);
  assert.equal(plainNumber('1만 2만'), null);
  assert.equal(plainNumber('3천 2천'), null);
});

/** 어절마다 두 질문의 '예' 확률 — textWordQuestions 의 답 꼴. */
const wordAnswers = (ps: number[]) =>
  Object.fromEntries(ps.flatMap((p, i) => [0, 1].map((j) => [`w${i}_${j}`, { choice: p >= 0.5 ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p } }])));

test('넣을 글자는 수 말과 그 단위를 함께 — 단위만 골랐어도 앞의 수 말까지, 조사는 뗀다', () => {
  assert.equal(textFromWordAnswers('정상가 이만 원으로 해줘', wordAnswers([0.01, 0.4, 0.95, 0])), '이만 원');
  assert.equal(textFromWordAnswers('판매가 만 팔천 원으로 해줘', wordAnswers([0.01, 0.3, 0.6, 0.97, 0])), '만 팔천 원');
  assert.equal(textFromWordAnswers('정상가 20000원으로 해줘', wordAnswers([0.01, 0.97, 0])), '20000원');
  assert.equal(textFromWordAnswers('집에서 입력해줘', wordAnswers([0.97, 0])), '집');
  assert.equal(textFromWordAnswers('도로 입력해줘', wordAnswers([0.97, 0])), '도로');
  assert.equal(textFromWordAnswers('아이폰 15 입력해줘', wordAnswers([0.2, 0.97, 0])), '15');
  assert.equal(textFromWordAnswers('안전재고 수량 열 개 입력해줘', wordAnswers([0.01, 0.05, 0.3, 0.9, 0])), '열 개');
  assert.equal(textFromWordAnswers('안전재고 수량 열 개 입력해줘', wordAnswers([0, 0, 0.53, 0.49, 0])), '열 개');
  assert.equal(textFromWordAnswers('정상가 2만 원으로 해줘', wordAnswers([0, 0.97, 0.3, 0])), '2만 원');
  assert.equal(textFromWordAnswers('정상가 15 해줘', wordAnswers([0, 0.97, 0])), '15');
  assert.equal(textFromWordAnswers('안전재고 열 개로 바꿔줘', wordAnswers([0, 0.9, 0.9, 0])), '열 개');
  assert.equal(textFromWordAnswers('안전재고 열 개로 바꿔줘', wordAnswers([0, 0.9, 0.3, 0])), '열 개');
  assert.equal(textFromWordAnswers('재고 백 개로 해줘', wordAnswers([0, 0.97, 0, 0])), '백 개');
  assert.equal(textFromWordAnswers('도로 입력해줘', wordAnswers([0.97, 0])), '도로');
  assert.equal(textFromWordAnswers('통로 입력해줘', wordAnswers([0.97, 0])), '통로');
  assert.equal(textFromWordAnswers('지하 통로 입력해줘', wordAnswers([0.97, 0.97, 0])), '지하 통로');
});
