import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeAllowed, type ChromeAction } from '../src/main/fast-act-chrome';

const run = async (): Promise<void> => {};
const back: ChromeAction = { role: 'button', name: '뒤로 (이전 페이지)', word: /(뒤로|이전|back)/i, run };
const layer: ChromeAction = { role: 'button', name: '열린 창 닫기 (Esc 키)', layer: true, run };

test('열린 창 닫기 후보는 낱말 조건 없이 언제나 판단 모델에 보인다 — 입력 요청에도', () => {
  // 10/22 BO: 낱말("접"·"닫")로 닫기를 정하자 "모델명에 「접이식 의자」 입력해줘" 에 Esc 만 보냈다. 고르기는 판단 모델에 맡긴다.
  for (const text of ['사이드바 닫아줘', '모델명에 「접이식 의자」 입력해줘', '메뉴 치워줘']) {
    assert.equal(chromeAllowed(layer, text, false), true, text);
    assert.equal(chromeAllowed(layer, text, true), true, text);
  }
});

test('다른 브라우저 조작은 지금처럼 — 낱말이 있어야 하고, 입력 요청에는 두지 않는다', () => {
  assert.equal(chromeAllowed(back, '뒤로 가줘', false), true);
  assert.equal(chromeAllowed(back, '사이드바 닫아줘', false), false);
  assert.equal(chromeAllowed(back, '뒤로 가서 상품명 입력해줘', true), false);
});
