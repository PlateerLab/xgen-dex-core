import assert from 'node:assert/strict';
import test from 'node:test';
import { briefResults } from '../src/main/fast-act-batch';
import { formLines } from '../src/main/fast-act-labels';

test('BrowserFill 결과는 성공한 줄을 번호와 칸만 남기고, 못 한 줄은 근거를 모두 남긴다', () => {
  const rows = briefResults([
    { step: '상품명에 「A」 입력해줘', status: 'done', note: '"상품명" 입력칸에 "A"를 입력했어요.', ms: 1400, target: '"상품명" 입력칸', requested: 'A', observed: 'A' },
    { step: '판매기간에 「2026.10.16. – 2026.12.31.」 입력해줘', status: 'failed', note: '알림을 닫았어요.', ms: 1700, target: '"판매기간" 입력칸', requested: '2026.10.16. – 2026.12.31.', observed: '', notices: ['익일 이후로 판매기간을 선택해 주세요.'] },
    { step: '정상가에 「29900」 입력해줘', status: 'done', note: '…', ms: 1300, target: '"정상가" 입력칸', notices: ['구간 내 마진율을 입력해 주세요.'] },
    { step: '모델명에 「X」 입력해줘', status: 'skipped', note: '시간 한도 도달', ms: 0 },
  ]);
  assert.deepEqual(rows[0], { i: 1, status: 'done', target: '"상품명" 입력칸' });
  assert.deepEqual(rows[1], {
    i: 2, status: 'failed', step: '판매기간에 「2026.10.16. – 2026.12.31.」 입력해줘', note: '알림을 닫았어요.', target: '"판매기간" 입력칸',
    requested: '2026.10.16. – 2026.12.31.', observed: '', notices: ['익일 이후로 판매기간을 선택해 주세요.'],
  });
  // 성공했어도 화면 알림은 남긴다.
  assert.deepEqual(rows[2], { i: 3, status: 'done', target: '"정상가" 입력칸', notices: ['구간 내 마진율을 입력해 주세요.'] });
  assert.deepEqual(rows[3], { i: 4, status: 'skipped', step: '모델명에 「X」 입력해줘', note: '시간 한도 도달' });
});

test('폼 값은 칸마다 한 줄 — 기본 type(text)·활성은 생략, 값은 따옴표로 감싼다', () => {
  const text = formLines([
    { field: '상품명', type: 'text', value: '[시연] 파우치', disabled: false },
    { field: '공급원가', type: 'text', value: '17430', disabled: true },
    { field: '상품유형', type: 'radio', value: '일반상품', disabled: false },
    { field: '판매기간', type: 'text', value: '', disabled: false, placeholder: 'YYYY.MM.DD. – YYYY.MM.DD.' },
    { field: '상품상세 내용', type: 'editor', value: 'a\nb "c"', disabled: false },
  ]);
  assert.equal(text, [
    '상품명: "[시연] 파우치"',
    '공급원가 [비활성]: "17430"',
    '상품유형 [radio]: "일반상품"',
    '판매기간 [형식 "YYYY.MM.DD. – YYYY.MM.DD."]: ""',
    '상품상세 내용 [editor]: "a\\nb \\"c\\""',
  ].join('\n'));
  assert.equal(formLines('not a list'), 'not a list');
});
