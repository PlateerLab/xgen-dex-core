import assert from 'node:assert/strict';
import test from 'node:test';
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
});

test('숫자만이거나 숫자 말이 아니면 null', () => {
  assert.equal(plainNumber('20000'), null);
  assert.equal(plainNumber('3.5'), null);
  assert.equal(plainNumber('아이폰 15'), null);
  assert.equal(plainNumber('10 20'), null);
  assert.equal(plainNumber('15일 이내 배송'), null);
  assert.equal(plainNumber('만 원'), null);
  assert.equal(plainNumber(''), null);
  assert.equal(plainNumber('1만만'), null);
});
