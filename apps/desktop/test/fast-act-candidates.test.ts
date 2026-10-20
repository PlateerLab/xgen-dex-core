import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeByLabel, pickElement, withoutValueEchoes, namedField, mentionsAnyName, type DecisionPost, type DecisionRequest, type ElementRefs } from '../src/main/fast-act';
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

test('칸 이름을 부른 지시에서 넣을 값과 이름만 같은 표 칸은 후보에서 뺀다', () => {
  const refs: ElementRefs = {
    e25: { role: 'combobox', name: '협력사' },
    e37: { role: 'combobox', name: '브랜드' },
    e376: { role: 'gridcell', name: '플래티어' },
    e9: { role: 'option', name: '플래티어' },
    e5: { role: 'file', name: '대표이미지' },
    e6: { role: 'treeitem', name: '가전디지털' },
    e7: { role: 'link', name: '플래티어' },
    e364: { role: 'row', name: '행 선택 create 플래티어 통합몰 패션의류/잡화>남성패션>가방/잡화 해당' },
    e8: { role: 'row', name: '1000002 플래티어 협력사 상품공급업자' },
  };
  const all = Object.keys(refs);
  const keys = (text: string) => Object.keys(withoutValueEchoes(refs, {}, text));
  const noCell = all.filter((k) => k !== 'e376' && k !== 'e364');
  assert.deepEqual(keys('협력사를 플래티어 협력사로 지정해줘'), noCell);
  assert.deepEqual(keys('협력사에 「플래티어 협력사」 지정해줘'), noCell);
  // 줄 이름에 부른 칸 이름(협력사)이 있으면 남긴다 — 브랜드를 부르면 협력사 줄도 값의 메아리다.
  assert.deepEqual(keys('브랜드를 플래티어로 지정해줘'), noCell.filter((k) => k !== 'e8'));
  // 칸 이름을 부르지 않았거나(따옴표 안의 칸 이름은 값), 표 칸이 아니면 그대로.
  assert.deepEqual(keys('플래티어 눌러줘'), all);
  assert.deepEqual(keys('「플래티어 협력사」 눌러줘'), all);
  assert.deepEqual(keys('대표이미지에 「상품이미지/003_대표이미지.png」 올려줘'), all);
});

test('팝업이 말과 상관없고 연 탭의 칸을 부르면 연 탭에서 판단한다 — 판정 함수', () => {
  const category: ElementRefs = { e4: { role: 'button', name: '적용' }, e6: { role: 'treeitem', name: '패션의류/잡화' }, e9: { role: 'textbox', name: '카테고리명 검색어' } };
  const partner: ElementRefs = { e2: { role: 'textbox', name: '협력사명 검색어' }, e5: { role: 'radio', name: '1 1000002 플래티어 협력사' }, e7: { role: 'button', name: '적용' } };
  const form: ElementRefs = { e25: { role: 'combobox', name: '협력사' }, e234: { role: 'combobox', name: '출고소요일 (현재: 3일)' } };
  assert.equal(mentionsAnyName(category, '협력사를 플래티어 협력사로 지정해줘'), false);
  assert.equal(mentionsAnyName(partner, '출고소요일을 2일로 변경해줘'), false);
  assert.equal(namedField(form, {}, '출고소요일을 2일로 변경해줘'), '출고소요일');
  // 팝업 안의 일은 팝업에서 — 줄 이름·버튼·검색칸 낱말이 말에 있다.
  assert.equal(mentionsAnyName(partner, '플래티어 협력사 선택해줘'), true);
  assert.equal(mentionsAnyName(partner, '적용 눌러줘'), true);
  assert.equal(mentionsAnyName(category, '패션의류/잡화 펼쳐줘'), true);
});
