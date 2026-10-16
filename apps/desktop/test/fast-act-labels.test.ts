import assert from 'node:assert/strict';
import test from 'node:test';
import { labelFields, refOrder, withoutLabel } from '../src/main/fast-act-labels';
import type { ElementRefs } from '../src/main/fast-act';

// BO 상품 등록 화면처럼 칸 이름이 입력칸과 떨어진 글자로만 있는 폼 — refs 키 순서는 문서 순서가 아니다.
const SNAPSHOT = [
  '- textbox [ref=e3]',
  '- button "중복확인" [ref=e4]',
  '- textbox [ref=e1]',
  '- textbox "‘,(쉼표)’로 구분하여 입력해 주세요." [ref=e5]',
  '- combobox "전체" [ref=e2]',
  '- textbox [ref=e6]',
  '- combobox "전체" [ref=e8]',
  '- link "상품명" [ref=e7]',
].join('\n');

const REFS: ElementRefs = {
  e1: { role: 'textbox', name: '' },
  e2: { role: 'combobox', name: '전체' },
  e3: { role: 'textbox', name: '' },
  e4: { role: 'button', name: '중복확인' },
  e5: { role: 'textbox', name: '‘,(쉼표)’로 구분하여 입력해 주세요.' },
  e6: { role: 'textbox' },
  e7: { role: 'link', name: '상품명' },
  e8: { role: 'combobox', name: '전체' },
};

const PAGE = [
  { role: 'textbox', hint: '', label: '상품명' },
  { role: 'textbox', hint: '', label: '모델명' },
  { role: 'textbox', hint: '‘,(쉼표)’로  구분하여 입력해 주세요.', label: '검색키워드 내용' },
  { role: 'combobox', hint: '전체', label: '구매연령' },
  { role: 'textbox', hint: '', label: '제조사' },
  { role: 'combobox', hint: '전체', label: '계약형태' },
];

test('요소 번호 순서는 스냅샷 글 순서 그대로, 중복 없이', () => {
  assert.deepEqual(refOrder(SNAPSHOT), ['e3', 'e4', 'e1', 'e5', 'e2', 'e6', 'e8', 'e7']);
  assert.deepEqual(refOrder('- link "a" [ref=e2]\n- link "a" [ref=e2]\n- ref=e10x'), ['e2']);
  assert.deepEqual(refOrder(''), []);
});

test('빈 이름은 칸 이름으로, 안내문·값 이름은 칸 이름을 앞에 붙인다 — 같은 이름끼리 문서 순서로', () => {
  const { refs, labels } = labelFields(REFS, refOrder(SNAPSHOT), PAGE);
  assert.equal(Object.keys(labels).length, 6);
  assert.equal(refs.e3.name, '상품명');
  assert.equal(refs.e1.name, '모델명');
  assert.equal(refs.e6.name, '제조사');
  assert.equal(refs.e5.name, '검색키워드 내용 ‘,(쉼표)’로 구분하여 입력해 주세요.');
  assert.equal(refs.e2.name, '구매연령 전체');
  assert.equal(refs.e8.name, '계약형태 전체');
  assert.equal(labels.e5, '검색키워드 내용');
  // 다른 역할은 그대로, 원본은 바꾸지 않는다
  assert.equal(refs.e7.name, '상품명');
  assert.equal(REFS.e3.name, '');
});

test('칸 이름을 못 찾았거나 안내문에 이미 칸 이름이 있으면 그대로 둔다', () => {
  const { refs, labels } = labelFields(REFS, refOrder(SNAPSHOT), [
    { role: 'textbox', hint: '', label: '상품명' },
    { role: 'textbox', hint: '', label: null },
    { role: 'textbox', hint: '', label: '제조사' },
    { role: 'textbox', hint: '‘,(쉼표)’로 구분하여 입력해 주세요.', label: '구분' },
  ]);
  assert.equal(Object.keys(labels).length, 2);
  assert.equal(refs.e1.name, '');
  assert.equal(refs.e5.name, '‘,(쉼표)’로 구분하여 입력해 주세요.');
});

test('스냅샷과 페이지의 수가 다른 묶음은 붙이지 않는다', () => {
  const { refs, labels } = labelFields(REFS, refOrder(SNAPSHOT), [
    { role: 'textbox', hint: '', label: '상품명' },
    { role: 'textbox', hint: '', label: '모델명' },
    { role: 'combobox', hint: '전체', label: '구매연령' },
    { role: 'combobox', hint: '전체', label: '계약형태' },
  ]);
  assert.equal(Object.keys(labels).length, 2);
  assert.equal(refs.e3.name, '');
  assert.equal(refs.e1.name, '');
  assert.equal(refs.e2.name, '구매연령 전체');
  assert.equal(refs.e8.name, '계약형태 전체');
});

test('스냅샷 글이 없으면 아무것도 붙이지 않는다', () => {
  const { refs, labels } = labelFields(REFS, [], PAGE);
  assert.equal(Object.keys(labels).length, 0);
  assert.deepEqual(refs, REFS);
});

test('검색 의도는 말에서 붙인 칸 이름을 빼고 본다', () => {
  assert.equal(
    withoutLabel('검색키워드에 노트북 넣어줘.', '검색키워드 내용').includes('검색'),
    false,
  );
  assert.equal(withoutLabel('검색어에 노트북 넣고 검색해줘', '검색어').includes('검색'), true);
  assert.equal(withoutLabel('검색에 노트북 넣고 검색해줘', '검색').includes('검색'), true);
  assert.equal(withoutLabel('xgen 검색해줘', undefined), 'xgen 검색해줘');
});
