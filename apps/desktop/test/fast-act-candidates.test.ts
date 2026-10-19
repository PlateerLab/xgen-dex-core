import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeByLabel, pickElement, type DecisionPost, type DecisionRequest, type ElementRefs } from '../src/main/fast-act';
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
