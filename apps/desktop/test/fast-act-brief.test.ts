import assert from 'node:assert/strict';
import test from 'node:test';
import { briefResults, heldValue } from '../src/main/fast-act-batch';
import { formLines } from '../src/main/fast-act-labels';

test('BrowserFill 결과는 성공한 줄을 번호와 칸만 남기고, 못 한 줄은 근거를 모두 남긴다', () => {
  const rows = briefResults([
    { step: '상품명에 「A」 입력해줘', status: 'done', note: '"상품명" 입력칸에 "A"를 입력했어요.', ms: 1400, target: '"상품명" 입력칸', requested: 'A', observed: 'A' },
    { step: '판매기간에 「2026.10.16. – 2026.12.31.」 입력해줘', status: 'failed', note: '알림을 닫았어요.', ms: 1700, target: '"판매기간" 입력칸', requested: '2026.10.16. – 2026.12.31.', observed: '', notices: ['익일 이후로 판매기간을 선택해 주세요.'] },
    { step: '정상가에 「29900」 입력해줘', status: 'done', note: '…', ms: 1300, target: '"정상가" 입력칸', notices: ['구간 내 마진율을 입력해 주세요.'] },
    { step: '모델명에 「X」 입력해줘', status: 'skipped', note: '시간 한도 도달', ms: 0 },
  ]);
  // 성공한 줄도 칸에서 읽은 값을 짧게 남긴다 — 앞선 실패 줄의 값을 최종 상태로 오해하지 않게(10/23 demo-test-23).
  assert.deepEqual(rows[0], { i: 1, status: 'done', target: '"상품명" 입력칸', value: 'A' });
  assert.deepEqual(rows[1], {
    i: 2, status: 'failed', step: '판매기간에 「2026.10.16. – 2026.12.31.」 입력해줘', note: '알림을 닫았어요.', target: '"판매기간" 입력칸',
    requested: '2026.10.16. – 2026.12.31.', observed: '', notices: ['익일 이후로 판매기간을 선택해 주세요.'],
  });
  // 성공했어도 화면 알림은 남긴다.
  assert.deepEqual(rows[2], { i: 3, status: 'done', target: '"정상가" 입력칸', notices: ['구간 내 마진율을 입력해 주세요.'] });
  // 긴 값은 앞부분만, 선택지는 선택 상태를.
  const more = briefResults([
    { step: '상품상세 내용에 「…」 입력해줘', status: 'done', note: '…', ms: 1, target: '"상품상세 내용" 입력칸', requested: 'x'.repeat(100), observed: 'x'.repeat(100) },
    { step: '가격비교를 노출안함으로 바꿔줘', status: 'done', note: '…', ms: 1, target: '"가격비교 노출안함" 선택지', observed: '선택됨' },
  ]);
  assert.equal(more[0].value, 'x'.repeat(40) + '…');
  assert.equal(more[1].value, '선택됨');
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

test('BrowserFill 줄이 부른 칸이 이미 「」 값이면 건너뛸 칸으로 본다', () => {
  const fields = [
    { field: '상품명', type: 'text', value: '[시연] 파우치' },
    { field: '판매가', type: 'text', value: '12,900' },
    { field: '구매연령', type: 'select', value: '전체' },
    { field: '구매제한', type: 'radio', value: '제한' },
    { field: '최대 구매제한 수량', type: 'text', value: '5' },
    { field: '결제수단', type: 'checkbox', value: '신용카드' },
    { field: '결제수단', type: 'checkbox', value: '네이버페이' },
    { field: '협력사', type: 'picked', value: '1000002 플래티어 협력사' },
    { field: '상품상세 내용', type: 'editor', value: '첫 문단\n둘째 문단' },
  ];
  assert.deepEqual(heldValue('상품명에 「[시연] 파우치」 입력해줘', fields), { field: '상품명', value: '[시연] 파우치' });
  // 숫자의 쉼표·띄어쓰기 차이는 같은 값이다.
  assert.deepEqual(heldValue('판매가에 「12900」 입력해줘', fields), { field: '판매가', value: '12,900' });
  assert.deepEqual(heldValue('구매연령을 「전체」로 바꿔줘', fields), { field: '구매연령', value: '전체' });
  assert.deepEqual(heldValue('상품상세 내용에 「첫 문단\n둘째 문단」 입력해줘', fields), { field: '상품상세 내용', value: '첫 문단\n둘째 문단' });
  // 이름이 같은 칸이 있으면 품는 칸("구매제한")은 보지 않는다.
  assert.deepEqual(heldValue('최대 구매제한 수량에 「5」 입력해줘', fields), { field: '최대 구매제한 수량', value: '5' });
  // 값이 다르거나, 칸이 여럿이거나(체크박스 무리), 「」 값이 없거나, 검색할 줄이면 판단 모델에 맡긴다.
  assert.equal(heldValue('판매가에 「13900」 입력해줘', fields), null);
  assert.equal(heldValue('결제수단에 「신용카드」 체크해줘', fields), null);
  assert.equal(heldValue('구매연령을 전체로 바꿔줘', fields), null);
  assert.equal(heldValue('상품명에 「[시연] 파우치」 입력하고 검색해줘', fields), null);
  assert.equal(heldValue('협력사를 「플래티어 협력사(1000002)」로 지정해줘', fields), null);
  assert.equal(heldValue('모델명에 「X」 입력해줘', fields), null);
  assert.equal(heldValue('상품명에 「[시연] 파우치」 입력해줘', null), null);
  // 건너뛴 줄은 결과에 손대지 않았다고 남긴다.
  assert.deepEqual(
    briefResults([{ step: '판매가에 「12900」 입력해줘', status: 'done', note: '이미 「12,900」 — 손대지 않음', ms: 3, target: '"판매가" 칸', observed: '12,900', unchanged: true }]),
    [{ i: 1, status: 'done', target: '"판매가" 칸', value: '12,900', unchanged: true }],
  );
});
