// 표준 셀렉터의 순수 로직 — xgen-frontend selector 와 동일한 검색 필터 계약.
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOptions, optionText } from '../src/renderer/src/views/selector-filter';

const opts = [
  { value: 'a', label: '테스트' },
  { value: 'b', label: 'Agentflow (25)_copy' },
  { value: 'c', label: 'new-shlee', keywords: '신규 신입 shlee' },
  { value: 'd', label: '보고서 봇' },
];

test('optionText — keywords 우선, 없으면 문자열 label, 그다음 value', () => {
  assert.equal(optionText({ value: 'x', label: '문서' }), '문서');
  assert.equal(optionText({ value: 'x', label: '문서', keywords: 'doc report' }), 'doc report');
  // label 이 문자열이 아니면 value 로 (React 노드는 검색 대상이 못 된다)
  assert.equal(optionText({ value: 'wf-1', label: 42 as unknown as string }), 'wf-1');
});

test('빈 질의는 전체를 그대로 준다', () => {
  assert.equal(filterOptions(opts, '').length, 4);
  assert.equal(filterOptions(opts, '   ').length, 4);
});

test('대소문자 무시 부분일치', () => {
  assert.deepEqual(
    filterOptions(opts, 'agent').map((o) => o.value),
    ['b'],
  );
  assert.deepEqual(
    filterOptions(opts, '테스트').map((o) => o.value),
    ['a'],
  );
});

test('keywords 로도 걸린다 (label 에 없는 말로 검색)', () => {
  // 'new-shlee' label 에는 '신규'가 없지만 keywords 에 있다.
  assert.deepEqual(
    filterOptions(opts, '신규').map((o) => o.value),
    ['c'],
  );
});

test('일치 없으면 빈 배열', () => {
  assert.deepEqual(filterOptions(opts, 'zzzzz'), []);
});

test('앞뒤 공백은 무시하고 필터한다', () => {
  assert.deepEqual(
    filterOptions(opts, '  보고서 ').map((o) => o.value),
    ['d'],
  );
});
