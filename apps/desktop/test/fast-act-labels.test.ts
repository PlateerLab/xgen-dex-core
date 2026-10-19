import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editableAsTextbox,
  checkOf,
  inDocOrder,
  itemOf,
  labelChoices,
  labelSearchTerms,
  nearNames,
  rowsNamed,
  valueToPick,
  choiceMissed,
  disabledOf,
  checkStates,
  labelClickables,
  labelFields,
  locativeAfterLabel,
  refOrder,
  withoutLabel,
  withoutLeadingLabel,
} from '../src/main/fast-act-labels';
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

test('넣을 글자 앞의 칸 이름(조사 포함)을 뗀다 — 남는 글자가 있을 때만', () => {
  assert.equal(withoutLeadingLabel('원산지에 대한민국', '원산지'), '대한민국');
  assert.equal(
    withoutLeadingLabel('검색키워드에 노트북, 데스크', '검색키워드 내용'),
    '노트북, 데스크',
  );
  assert.equal(withoutLeadingLabel('상품명은 xgen', '상품명'), 'xgen');
  assert.equal(withoutLeadingLabel('대한민국', '원산지'), '대한민국');
  assert.equal(withoutLeadingLabel('원산지', '원산지'), '원산지');
  assert.equal(withoutLeadingLabel('원산지표시 없음', '원산지'), '원산지표시 없음');
  assert.equal(withoutLeadingLabel('원산지에 대한민국', undefined), '원산지에 대한민국');
  assert.equal(withoutLeadingLabel('안전재고 열 개', '안전재고수량'), '열 개');
  assert.equal(withoutLeadingLabel('안전재고를 열 개', '안전재고 수량'), '열 개');
  assert.equal(withoutLeadingLabel('삼성 갤럭시북', '삼성전자 모델명'), '삼성 갤럭시북');
  assert.equal(withoutLeadingLabel('안전 장치', '안전재고수량'), '안전 장치');
});

// 관리자 폼의 찾기 칸 — 제목 아래 역할 없는 누름 상자(빈 칸 / 고른 값이 든 칸)와 칸이 아닌 것들.
const BOX_SNAPSHOT = [
  '- region "scrollable content" [ref=e1] focusable [tabindex]',
  '  - button "협력사" [ref=e2]',
  '- heading "협력사 *" [level=6, ref=e3]',
  '- generic [ref=e4] clickable [cursor:pointer]',
  '  - generic [ref=e5] clickable [cursor:pointer, onclick]',
  '  - generic [ref=e6] clickable [cursor:pointer, onclick]',
  '- heading "브랜드 *" [level=6, ref=e7]',
  '- generic "LA5298   모디바" [ref=e8] clickable [cursor:pointer]',
  '  - generic [ref=e9] clickable [cursor:pointer, onclick]',
  '  - generic "LA5298   모디바" [ref=e10] clickable [cursor:pointer, onclick]',
  '    - generic "LA5298" [ref=e11] clickable [cursor:pointer, tabindex]',
  '  - button [ref=e12]',
  '- heading "업체상품번호" [level=6, ref=e13]',
  '- generic "" [ref=e14] clickable [onclick]',
  '  - textbox [ref=e15]',
  '- heading "동영상" [level=6, ref=e16]',
  '- generic "업로드할 파일을 드래그 하거나 선택해 주세요" [ref=e17] clickable [cursor:pointer, onclick, tabindex]',
  '- heading "추천 상품" [level=3, ref=e18]',
  '- generic [ref=e19] clickable [cursor:pointer]',
  '- generic [ref=e20] clickable [cursor:pointer]',
  '- button [ref=e21]',
  '- generic [ref=e22] clickable [cursor:pointer]',
].join('\n');
const boxRefs = (): ElementRefs => {
  const refs: ElementRefs = {};
  for (const m of BOX_SNAPSHOT.matchAll(/- (\w+)(?: "([^"]*)")?[^\n]*?ref=(e\d+)/g))
    refs[m[3]] = { role: m[1], name: m[2] ?? '' };
  return refs;
};

test('제목 아래 하나뿐인 누름 상자는 그 제목을 이름으로 한 선택 상자다 — 고른 값은 이름 뒤에', () => {
  const { refs, labels } = labelClickables(boxRefs(), BOX_SNAPSHOT);
  assert.deepEqual(labels, { e4: '협력사', e8: '브랜드' });
  assert.deepEqual(refs.e4, { role: 'combobox', name: '협력사' });
  assert.deepEqual(refs.e8, { role: 'combobox', name: '브랜드 LA5298 모디바' });
  // 메뉴 버튼·입력칸을 감싼 상자·제 글이 있는 끌어 놓기 칸·제목 아래 여러 장(카드)은 그대로.
  assert.deepEqual(refs.e2, { role: 'button', name: '협력사' });
  assert.deepEqual(refs.e14, { role: 'generic', name: '' });
  assert.deepEqual(refs.e17.role, 'generic');
  assert.deepEqual(
    [refs.e19.role, refs.e20.role, refs.e22.role],
    ['generic', 'generic', 'generic'],
  );
});

test('스냅샷 글이 비거나 요소 목록에 없는 번호면 붙이지 않는다', () => {
  assert.deepEqual(labelClickables(boxRefs(), '').labels, {});
  const refs = boxRefs();
  delete refs.e4;
  assert.deepEqual(labelClickables(refs, BOX_SNAPSHOT).labels, { e8: '브랜드' });
});

test('글 편집 영역(contenteditable)은 입력칸이다 — 칸 이름은 labelFields 가 붙인다', () => {
  const snapshot = [
    '- heading "상품상세 내용 *" [level=6, ref=e107]',
    '- button [ref=e362]',
    '- generic [ref=e368] clickable [cursor:pointer]',
    '- generic [ref=e353] editable [contenteditable]: ',
    '- link "POWERED BY JODIT" [ref=e355]',
  ].join('\n');
  const refs: ElementRefs = {
    e107: { role: 'heading', name: '상품상세 내용 *' },
    e362: { role: 'button', name: '' },
    e368: { role: 'generic', name: '' },
    e353: { role: 'generic', name: '' },
    e355: { role: 'link', name: 'POWERED BY JODIT' },
  };
  const out = editableAsTextbox(refs, snapshot);
  assert.deepEqual(out.e353, { role: 'textbox', name: '' });
  assert.equal(out.e368.role, 'generic');
  assert.equal(refs.e353.role, 'generic', '원래 목록은 그대로');
  const named = labelFields(out, refOrder(snapshot), [
    { role: 'textbox', hint: '', label: '상품상세 내용' },
  ]);
  assert.equal(named.refs.e353.name, '상품상세 내용');
});

test('항목마다 그 항목을 고르는 체크박스 — 하위 항목 전까지 하나뿐일 때만', () => {
  const snapshot = [
    '- treeitem "가전디지털" [level=1, expanded=true, ref=e17]',
    '  - generic "가전디지털" [ref=e25] clickable [cursor:pointer, onclick]',
    '    - generic [ref=e43] clickable [cursor:pointer, onclick]',
    '    - checkbox [checked=false, ref=e44]',
    '    - generic "가전디지털" [ref=e45] clickable [cursor:pointer, onclick]',
    '  - treeitem "냉장고" [level=2, expanded=false, ref=e47]',
    '    - generic "냉장고" [ref=e58] clickable [cursor:pointer, onclick]',
    '      - checkbox [checked=true, ref=e66]',
    '- row "1 11371 삼성전자 사용" [ref=e80]',
    '  - gridcell [ref=e81]',
    '    - checkbox [checked=false, ref=e82]',
    '  - gridcell [ref=e83]',
    '    - checkbox [checked=false, ref=e84]',
    '- treeitem "빈 항목" [ref=e90]',
  ].join('\n');
  assert.deepEqual(checkOf(snapshot), {
    e17: { ref: 'e44', checked: false },
    e47: { ref: 'e66', checked: true },
  });
  assert.deepEqual(checkOf(''), {});
});

test('표 행과 그 행의 셀은 같은 항목 번호로 — 셀 안의 고르는 상자나 다음 행은 넣지 않는다', () => {
  const snapshot = [
    '- grid [ref=e1]',
    '  - columnheader "브랜드명" [ref=e20] clickable [cursor:pointer, onclick]',
    '  - row "1 11371 삼성전자 사용" [ref=e22] clickable [onclick]',
    '    - gridcell "1" [ref=e45] clickable [onclick]',
    '    - gridcell [ref=e46] clickable [onclick]',
    '      - generic [ref=e120] clickable [cursor:pointer, onclick]',
    '        - radio [checked=false, ref=e135]',
    '    - gridcell "삼성전자" [ref=e48] clickable [onclick]',
    '    - button "수정" [ref=e60]',
    '  - row "2 11372 삼성카드 사용" [ref=e23] clickable [onclick]',
    '    - gridcell "삼성카드" [ref=e53] clickable [onclick]',
    '- treeitem "가전디지털" [ref=e17]',
    '  - checkbox [checked=false, ref=e44]',
    '  - treeitem "TV" [ref=e18]',
  ].join('\n');
  assert.deepEqual(itemOf(snapshot), {
    e22: 'e22',
    e45: 'e22',
    e46: 'e22',
    e48: 'e22',
    e23: 'e23',
    e53: 'e23',
    e17: 'e17',
    e18: 'e18',
  });
  assert.deepEqual(checkOf(snapshot), { e22: { ref: 'e135', checked: false }, e17: { ref: 'e44', checked: false } });
});

test("칸 이름 바로 뒤의 '의' 는 '에' 로 — 띄어쓰기는 보지 않고, 칸 이름이 아니면 그대로", () => {
  assert.equal(
    locativeAfterLabel('상품 상세 내용의 삼성 노트북 테스트 상품입니다. 입력해줘', '상품상세 내용'),
    '상품 상세 내용에 삼성 노트북 테스트 상품입니다. 입력해줘',
  );
  assert.equal(locativeAfterLabel('재고수량 *의 100 넣어줘', '재고수량 *'), '재고수량 *의 100 넣어줘');
  assert.equal(locativeAfterLabel('재고수량의 100 넣어줘', '재고수량 *'), '재고수량에 100 넣어줘');
  assert.equal(locativeAfterLabel('삼성의 노트북 입력해줘', '상품명'), '삼성의 노트북 입력해줘');
  assert.equal(locativeAfterLabel('상품명의미 입력해줘', '상품명'), '상품명의미 입력해줘');
  assert.equal(locativeAfterLabel('상품명의 삼성 입력해줘', undefined), '상품명의 삼성 입력해줘');
});

test('요소 목록을 문서 순서로 — 제목 바로 뒤에 그 제목의 선택지가 오게, 스냅샷에 없는 요소는 뒤에', () => {
  // refs 키는 e1, e10, e100… 순이다(10/19 BO 상품 등록: "선물하기 해당" 이 직구상품 여부의 "해당" 으로 눌렸다).
  const refs: ElementRefs = {
    e100: { role: 'radio', name: '해당' },
    e101: { role: 'radio', name: '해당' },
    e38: { role: 'heading', name: '직구상품 여부' },
    e39: { role: 'heading', name: '선물하기' },
    c1: { role: 'button', name: '뒤로' },
  };
  const ordered = inDocOrder(refs, ['e38', 'e100', 'e39', 'e101', 'e7']);
  assert.deepEqual(Object.keys(ordered), ['e38', 'e100', 'e39', 'e101', 'c1']);
  assert.equal(ordered.e39, refs.e39);
});

test('제목 아래 선택지(radio)는 이름 앞에 그 제목을 — 이름이 같은 선택지를 이름만으로 가른다', () => {
  // 10/19 BO 상품 등록 "반품기능 제공안함으로 해줘": 한 방향으로 묻는 창에서 앞의 취소기능 "제공안함" 이 1.0 이라 반품기능 것은 결승에도 못 갔다.
  const snapshot = [
    '- heading "취소기능" [level=6, ref=e71]',
    '- LabelText "제공" [ref=e208] clickable [cursor:pointer]',
    '  - radio "제공" [checked=true, ref=e270]',
    '- LabelText "제공안함" [ref=e209] clickable [cursor:pointer]',
    '  - radio "제공안함" [checked=false, ref=e271]',
    '- heading "반품기능" [level=6, ref=e73]',
    '- LabelText "제공안함" [ref=e213] clickable [cursor:pointer]',
    '  - radio "제공안함" [checked=false, ref=e275]',
    '- button "저장" [ref=e3]',
    '- radio "따로" [checked=false, ref=e9]',
  ].join('\n');
  const refs: ElementRefs = {
    e270: { role: 'radio', name: '제공' },
    e271: { role: 'radio', name: '제공안함' },
    e275: { role: 'radio', name: '제공안함' },
    e9: { role: 'radio', name: '따로' },
  };
  const { refs: out, labels } = labelChoices(refs, snapshot);
  assert.equal(out.e270.name, '취소기능 제공');
  assert.equal(out.e271.name, '취소기능 제공안함');
  assert.equal(out.e275.name, '반품기능 제공안함');
  assert.equal(out.e9.name, '따로'); // 바로 앞이 제목이 아니면 그대로
  assert.deepEqual(labels, { e270: '취소기능', e271: '취소기능', e275: '반품기능' });
});

test('검색 기준 선택 상자 바로 뒤의 이름 없는 입력칸은 "기준 검색어" — 기준 상자와 가른다', () => {
  // 10/19 BO 협력사 조회 팝업: [협력사명 ▾][      ] 의 입력칸이 이름이 없어 "플래티어로 조회해줘" 에 협력사구분 상자를 눌렀다.
  const snapshot = [
    '- heading "협력사정보" [level=6, ref=e8]',
    '- generic "협력사명" [ref=e17] clickable [onclick]',
    '  - combobox "협력사명" [expanded=false, ref=e24]',
    '- generic "" [ref=e18] clickable [onclick]',
    '  - textbox [ref=e25]',
    '- button "조회" [ref=e10]',
    '- textbox [ref=e30]',
    '- combobox "전체" [ref=e31]',
    '- textbox "메모" [ref=e32]',
  ].join('\n');
  const refs: ElementRefs = {
    e24: { role: 'combobox', name: '협력사명' },
    e25: { role: 'textbox', name: '' },
    e30: { role: 'textbox' },
    e31: { role: 'combobox', name: '전체' },
    e32: { role: 'textbox', name: '메모' },
  };
  const { refs: out, labels } = labelSearchTerms(refs, snapshot);
  assert.equal(out.e25.name, '협력사명 검색어');
  assert.equal(out.e30.name, undefined); // 앞이 선택 상자가 아니면 그대로
  assert.equal(out.e32.name, '메모'); // 이름이 있으면 그대로
  assert.deepEqual(labels, { e25: '협력사명' });
});

// 10/19 BO 협력사 조회 팝업에서 "플래티어" 로 조회한 결과.
const PARTNER_ROWS: ElementRefs = {
  e33: { role: 'row', name: '1 1000401 플래티어' },
  e45: { role: 'gridcell', name: '플래티어 2' },
  e34: { role: 'row', name: '2 1000002 플래티어' },
  e51: { role: 'gridcell', name: '플래티어  협력사' },
  e35: { role: 'row', name: '3 1000001 플래티어' },
  e57: { role: 'gridcell', name: '플래티어' },
  e58: { role: 'gridcell', name: '상품공급업자' },
};
const PARTNER_ITEMS = { e33: 'e33', e45: 'e33', e34: 'e34', e51: 'e34', e35: 'e35', e57: 'e35', e58: 'e35' };

test('셀 글자가 고를 값과 정확히 같은 행만 — 공백만 정리하고, 앞부분이 같은 이름은 아니다', () => {
  assert.deepEqual(rowsNamed(PARTNER_ROWS, PARTNER_ITEMS, '플래티어 협력사'), ['e34']);
  assert.deepEqual(rowsNamed(PARTNER_ROWS, PARTNER_ITEMS, '플래티어'), ['e35']);
  assert.deepEqual(rowsNamed(PARTNER_ROWS, PARTNER_ITEMS, '플래티어 3'), []);
});

test('정확히 같은 행이 없을 때 물어볼 후보 — 고를 값과 낱말이 겹치는 셀 글자, 중복 없이', () => {
  assert.deepEqual(nearNames(PARTNER_ROWS, PARTNER_ITEMS, '플래티어 3'), ['플래티어 2', '플래티어 협력사', '플래티어']);
  assert.deepEqual(nearNames(PARTNER_ROWS, PARTNER_ITEMS, '삼성'), []);
});

test('조회 팝업에서 고를 값 — 칸 이름을 떼고, 칸 이름뿐이면 고를 값이 없다', () => {
  // 10/19 BO: "협력사 눌러줘" 에서 칸 이름 "협력사" 를 고를 값으로 뽑아 팝업에서 "협력사" 로 조회했다.
  assert.equal(valueToPick('협력사', '협력사'), null);
  assert.equal(valueToPick('협력사 플래티어 협력사', '협력사'), '플래티어 협력사');
  assert.equal(valueToPick('플래티어 협력사', '협력사'), '플래티어 협력사');
  assert.equal(valueToPick('', '협력사'), null);
});

test('누른 선택지가 고른 상태가 되지 않았나 — 선택지는 눌러서 선택돼야, 체크박스는 전 상태를 알 때 바뀌어야', () => {
  // 10/19 BO: 직구상품 여부가 "해당" 이면 선물하기를 고를 수 없는데, 누르고 "눌렀어요" 로 성공이라 답했다.
  assert.equal(choiceMissed('radio', undefined, false), true);
  assert.equal(choiceMissed('radio', undefined, true), false);
  assert.equal(choiceMissed('checkbox', false, false), true);
  assert.equal(choiceMissed('checkbox', false, true), false);
  assert.equal(choiceMissed('checkbox', undefined, false), false); // 전 상태를 모르면 판단하지 않는다
  assert.equal(choiceMissed('radio', undefined, null), false); // 못 읽었으면 판단하지 않는다
  assert.equal(choiceMissed('button', undefined, false), false);
});

test('스냅샷에서 비활성 요소 — 괄호 안 disabled 표시만, 이름에 든 글자는 아니다', () => {
  // 10/19 BO 상품 등록: 협력사를 정하기 전에는 부가세·배송수단 상자가 잠겨 있는데, 눌러 놓고 "눌렀어요" 라 답했다.
  const snapshot = [
    '- combobox "과세" [expanded=false, disabled, ref=e181]',
    '- textbox [disabled, ref=e153]: 0',
    '- combobox "구매연령 전체" [expanded=false, ref=e169]',
    '- button "disabled 안내" [ref=e9]',
  ].join('\n');
  assert.deepEqual([...disabledOf(snapshot)], ['e181', 'e153']);
});

test('스냅샷에서 체크박스·선택지의 지금 상태 — checked 표시가 있는 요소만', () => {
  // 10/19 BO: 결제가능수단은 처음부터 모두 체크돼 있어 "네이버페이 체크해줘" 가 오히려 풀었다.
  const snapshot = [
    '- checkbox "네이버페이" [checked=true, ref=e257]',
    '- checkbox "페이코" [checked=false, ref=e259]',
    '- radio "해당" [checked=true, disabled, ref=e243]',
    '- button "저장" [ref=e3]',
  ].join('\n');
  assert.deepEqual(checkStates(snapshot), { e257: true, e259: false, e243: true });
});
