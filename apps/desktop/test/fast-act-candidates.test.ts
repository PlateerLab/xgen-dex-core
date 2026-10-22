import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeByLabel, pickElement, namedField, saidField, sameField, narrowLarge, mentionsAnyName, type DecisionPost, type DecisionRequest, type ElementRefs } from '../src/main/fast-act';
import { buildScreen, PICK_Q13, stateWith } from '../src/main/fast-act-e13';

test('같은 이름과 이름 없는 서로 다른 ref를 유지한다', () => {
  const refs = { e1: { role: 'textbox', name: '상품명' }, e2: { role: 'textbox', name: '상품명' }, e3: { role: 'textbox' }, e4: { role: 'textbox' } };
  assert.deepEqual(dedupeByLabel(refs, ['e2', 'e1', 'e2', 'e3', 'e4', 'missing', 'toString']), ['e2', 'e1', 'e3', 'e4']);
});

for (const count of [2, 30, 70]) {
  test(`${count}개 화면: 동일 label의 두 번째 ref 선택, E13 및 2등 결승 유지`, async () => {
    const refs: ElementRefs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i + 1}`, { role: 'textbox', name: i < 2 ? '상품명' : `칸 ${i + 1}` }]));
    const origin = 'https://bo.x2bee.com/goods/goods-mgmt/general-goods-reg/';
    const said = '두 번째 상품명에 테스트 입력해줘';
    const scr = buildScreen(origin, Object.entries(refs).map(([ref, r]) => ({ ref, role: r.role, name: r.name ?? '' })));
    const requests: DecisionRequest[] = [];
    const post: DecisionPost = async (body) => {
      requests.push(body);
      assert.ok(body.state.startsWith(`Page: ${origin}\nScreen:\n`));
      assert.ok(body.state.endsWith(`\nUser said: ${said}`));
      return Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
        assert.equal(q.instructions, PICK_Q13);
        const keys = Object.keys(q.criteria);
        for (const k of keys) {
          assert.equal(q.criteria[k], k);
          assert.ok(body.state.includes(`\n${k} | textbox | "`));
        }
        const runnerUp = count > 25 && id.startsWith('c') && keys.includes('e2');
        const probabilities = Object.fromEntries(keys.map((k) => [k, runnerUp ? (k === 'e1' ? 0.8 : k === 'e2' ? 0.2 : 0) : (k === 'e2' ? 0.98 : keys.includes('e2') ? 0.02 / (keys.length - 1) : k === keys[0] ? 1 : 0)]));
        const choice = Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];
        return [id, { choice, probabilities }];
      }));
    };
    const result = await pickElement(post, said, origin, refs, scr);
    assert.equal(result?.ref, 'e2');
    assert.equal(result?.confidence, 0.98);
    assert.equal(requests.length, count === 2 ? 1 : count === 30 ? 2 : 3);
    if (count <= 60) assert.equal(requests[0].state, stateWith(scr, said));
    if (count > 25) {
      const final = requests.find((r) => r.questions.q)!;
      assert.ok(final.questions.q.criteria.e1);
      assert.ok(final.questions.q.criteria.e2);
      assert.deepEqual(Object.keys(final.questions.qr.criteria), Object.keys(final.questions.q.criteria).reverse());
    }
  });
}

test('창으로 나눈 화면의 결승에도 승자마다 앞 제목을 싣는다 — 이름이 같은 선택지를 제목으로 가른다', async () => {
  // 10/19 BO 상품 등록 "반품기능 제공안함으로 해줘": 결승 화면에 "제공안함" 두 줄만 남아 취소기능 것이 눌렸다.
  const refs: ElementRefs = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { role: 'textbox', name: `칸 ${i}` }]));
  Object.assign(refs, {
    h1: { role: 'heading', name: '취소기능' },
    r1: { role: 'radio', name: '제공안함' },
    h2: { role: 'heading', name: '반품기능' },
    r2: { role: 'radio', name: '제공안함' },
  });
  const origin = 'https://bo.x2bee.com/goods/goods-mgmt/general-goods-reg/';
  const scr = buildScreen(origin, Object.entries(refs).map(([ref, r]) => ({ ref, role: r.role, name: r.name ?? '' })));
  let final = '';
  const post: DecisionPost = async (body) => {
    if (body.questions.q) final = body.state;
    return Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      const keys = Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === 'r1' || k === 'r2' ? 0.5 : 0]));
      return [id, { choice: keys[0], probabilities }];
    }));
  };
  await pickElement(post, '반품기능 제공안함으로 해줘', origin, refs, scr);
  assert.match(final, /h1 \| heading \| "취소기능"\nr1 \| radio \| "제공안함"\nh2 \| heading \| "반품기능"\nr2 \| radio \| "제공안함"/);
});

test('한 방향으로 물은 묶음의 2등은 확률이 낮아도 결승에 올린다 — 앞자리 편향은 결승에서 뒤집는다', async () => {
  // 10/19 BO 상품 등록 "반품기능 제공안함으로 해줘": 묶음에서 취소기능 0.926·반품기능 0.071 이라 반품기능이 결승에 못 갔다.
  const refs: ElementRefs = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { role: 'textbox', name: `칸 ${i}` }]));
  Object.assign(refs, { r1: { role: 'radio', name: '취소기능 제공안함' }, r2: { role: 'radio', name: '반품기능 제공안함' } });
  const origin = 'https://bo.x2bee.com/goods/goods-mgmt/general-goods-reg/';
  const scr = buildScreen(origin, Object.entries(refs).map(([ref, r]) => ({ ref, role: r.role, name: r.name ?? '' })));
  const post: DecisionPost = async (body) =>
    Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      const keys = Object.keys(q.criteria);
      const final = id === 'q' || id === 'qr';
      const probabilities = Object.fromEntries(keys.map((k) => [k, final ? (k === 'r2' ? 0.9 : 0.1 / keys.length) : k === 'r1' ? 0.926 : k === 'r2' ? 0.071 : 0.003 / keys.length]));
      return [id, { choice: keys[0], probabilities }];
    }));
  const result = await pickElement(post, '반품기능 제공안함으로 해줘', origin, refs, scr);
  assert.equal(result?.ref, 'r2');
});

test('팝업이 말과 상관없고 연 탭의 칸을 부르면 연 탭에서 판단한다 — 판정 함수', () => {
  const category: ElementRefs = { e4: { role: 'button', name: '적용' }, e6: { role: 'treeitem', name: '패션의류/잡화' }, e9: { role: 'textbox', name: '카테고리명 검색어' } };
  const partner: ElementRefs = { e2: { role: 'textbox', name: '협력사명 검색어' }, e5: { role: 'radio', name: '1 1000002 플래티어 협력사' }, e7: { role: 'button', name: '적용' } };
  const form: ElementRefs = { e25: { role: 'combobox', name: '협력사' }, e234: { role: 'combobox', name: '출고소요일 (현재: 3일)' } };
  assert.equal(mentionsAnyName(category, '협력사를 플래티어 협력사로 지정해줘'), false);
  assert.equal(mentionsAnyName(partner, '출고소요일을 2일로 변경해줘'), false);
  assert.deepEqual(namedField(form, {}, '출고소요일을 2일로 변경해줘'), { ref: 'e234', name: '출고소요일' });
  assert.deepEqual(namedField(form, {}, '협력사에 「플래티어 협력사」 지정해줘'), { ref: 'e25', name: '협력사' });
  // 팝업 안의 일은 팝업에서 — 줄 이름·버튼·검색칸 낱말이 말에 있다.
  assert.equal(mentionsAnyName(partner, '플래티어 협력사 선택해줘'), true);
  assert.equal(mentionsAnyName(partner, '적용 눌러줘'), true);
  assert.equal(mentionsAnyName(category, '패션의류/잡화 펼쳐줘'), true);
});

test('지시가 부른 칸 이름 — 「」 안의 값은 칸 이름이 아니다', () => {
  assert.equal(saidField('규격에 「외부 400×285×30mm」 입력해줘'), '규격');
  assert.equal(saidField('브랜드 원산지 표기나 구매안내에 「16인치 표기는 …」 입력해줘'), '브랜드원산지표기나구매안내');
  assert.equal(saidField('상품상세 내용에 「… 원산지 중국 …」 입력해줘'), '상품상세내용');
  assert.equal(saidField('협력사를 플래티어 협력사로 지정해줘'), '협력사');
  assert.equal(saidField('선물하기를 「해당없음」으로 설정해줘'), '선물하기');
  assert.equal(saidField('출고소요일을 2일로 변경해줘'), '출고소요일');
  for (const text of ['실시간계좌이체 체크 해제해줘', '부가 정보 펼쳐줘', '로그인 버튼 눌러줘', '상품 등록 페이지 들어가줘'])
    assert.equal(saidField(text), null, text);
});

test('열린 서랍에서 고른 항목이 말과 맞는가 — 말이 항목 이름을 품어야 하고, "상품" 같은 두 글자만 겹치면 아니다', () => {
  // 10/22 BO: 서랍이 열린 채 "모델명 접이식 의자로 바꿔줘" 에 서랍 메뉴 "단품 정보 관리" 를 눌러 페이지가 바뀌었다.
  const said = (t: string) => t.replace(/\s+/g, '');
  assert.equal(sameField(said('모델명 접이식 의자로 바꿔줘'), '단품 정보 관리'), false);
  assert.equal(sameField(said('상품 등록 들어가줘'), '상품 등록'), true);
  assert.equal(sameField(said('상품 정보 관리 들어가줘'), '상품 등록'), false);
});

test('같은 칸 판정 — 품거나 조각 절반 이상 겹치면 같은 칸, 조각 하나만 겹치면 다른 칸', () => {
  for (const [said, name] of [['최소구매수량', '최소'], ['검색키워드', '검색키워드 내용 ‘,(쉼표)’로 구분하여 입력해 주세요.'],
    ['출고소요일', '출고소요일 (현재: 3일)'], ['결제수단', '결제가능수단 실시간계좌이체'], ['안전재고수량', '안전재고수량'], ['대표이미지대체텍스트', '대체 텍스트를 입력해주세요(100자 이하)']])
    assert.equal(sameField(said, name), true, `${said} ~ ${name}`);
  for (const [said, name] of [['고객센터전화번호', '업체상품번호'], ['규격', '상품상세 내용'], ['무게', '치수'], ['협력사', '플래티어'],
    ['기본배송비', '최소'], ['판매시작일', '판매기간 YYYY.MM.DD. – YYYY.MM.DD.'], ['색상', '검색키워드 내용 ‘,(쉼표)’로 구분하여 입력해 주세요.']])
    assert.equal(sameField(said, name), false, `${said} ≁ ${name}`);
});

test('큰 화면을 줄일 때 남긴 요소의 구역 제목도 남긴다', () => {
  const refs: ElementRefs = {};
  const keys: string[] = [];
  for (let i = 0; i < 130; i++) { keys.push(`f${i}`); refs[`f${i}`] = { role: 'textbox', name: `칸 ${i}` }; }
  keys.push('h1', 'b1', 'h2', 'r1', 'c1');
  Object.assign(refs, { h1: { role: 'heading', name: '브랜드 *' }, b1: { role: 'combobox', name: '브랜드' },
    h2: { role: 'heading', name: '전시카테고리 *' }, r1: { role: 'row', name: '행 선택 플래티어 통합몰' }, c1: { role: 'gridcell', name: '플래티어' } });
  const kept = narrowLarge(keys, refs, '협력사를 플래티어 협력사로 지정해줘');
  assert.deepEqual(kept.slice(60), ['h2', 'r1', 'c1']);
});

test('판단 응답 누락은 클릭이나 질문 아님으로 간주하지 않는다', async () => {
  const { classify, askedProbability } = await import('../src/main/fast-act');
  const scr = buildScreen('https://example.test', [{ ref: 'e1', role: 'textbox', name: '이름' }]);
  await assert.rejects(classify(async () => ({}), '이름에 봄 입력해줘', '', scr));
  await assert.rejects(classify(async () => ({ action: { choice: 'type' }, ready: { choice: 'act_now', probabilities: { act_now: 1 } } }), '이름에 봄 입력해줘', '', scr));
  for (const p of [undefined, NaN, -1, 2]) {
    await assert.rejects(askedProbability(async () => ({ asked: { choice: 'done', probabilities: p === undefined ? undefined : { asks: p } } }), '어느 상품인가요?'));
  }
  assert.equal(await askedProbability(async () => ({ asked: { choice: 'done', probabilities: { asks: 0 } } }), '입력했어요.'), 0);
});

test('순서 요청과 이름 붙은 탭 닫기를 한 번의 현재 화면 조작으로 끝내지 않는다', async () => {
  const { needsSequentialPlan, closesCurrentTab } = await import('../src/main/fast-act');
  assert.equal(needsSequentialPlan('카테고리 지정하고, 그다음에 협력사 지정해줘'), true);
  assert.equal(needsSequentialPlan('메모에 「그리고 다음 날」 입력해줘'), false);
  assert.equal(closesCurrentTab('협력사 조회 탭 닫아줘'), false);
  assert.equal(closesCurrentTab('지금 탭 닫아줘'), true);
  assert.equal(closesCurrentTab('탭 닫아줘'), true);
});
