import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIDGE_MAX_DATA,
  BRIDGE_TAG,
  deliverScript,
  parseBridgeFrameName,
  parseBridgeMessage,
  targetAllowed,
} from '../src/main/browser-popup-bridge';

const ID = '7c1f5d2e-9a4b-4c3d-8e2f-0a1b2c3d4e5f';
const said = (m: unknown) => BRIDGE_TAG + JSON.stringify(m);

test('브리지가 연 창 이름에서 짝 번호와 원래 창 이름을 읽는다', () => {
  assert.deepEqual(parseBridgeFrameName(`__dexpopup:${ID}:etEntrListPopup`), {
    id: ID,
    name: 'etEntrListPopup',
  });
  assert.deepEqual(parseBridgeFrameName(`__dexpopup:${ID}:`), { id: ID, name: '' });
  assert.deepEqual(parseBridgeFrameName(`__dexpopup:${ID}:a:b`), { id: ID, name: 'a:b' });
  assert.equal(parseBridgeFrameName('etEntrListPopup'), null);
  assert.equal(parseBridgeFrameName(''), null);
  assert.equal(parseBridgeFrameName('__dexpopup::x'), null);
  assert.equal(parseBridgeFrameName('__dexpopup:bad id!:x'), null);
});

test('console 글은 형식이 맞는 브리지 글만 받는다', () => {
  assert.deepEqual(
    parseBridgeMessage(
      said({ k: 'msg', id: ID, data: JSON.stringify({ type: 'popup', source: [1] }), target: '/' }),
    ),
    { k: 'msg', id: ID, data: { type: 'popup', source: [1] }, target: '/' },
  );
  assert.deepEqual(parseBridgeMessage(said({ k: 'close', id: ID, self: true })), {
    k: 'close',
    id: ID,
    self: true,
  });
  assert.deepEqual(parseBridgeMessage(said({ k: 'close', id: ID })), {
    k: 'close',
    id: ID,
    self: false,
  });
  assert.deepEqual(parseBridgeMessage(said({ k: 'focus', id: ID })), { k: 'focus', id: ID });
  assert.equal(parseBridgeMessage(JSON.stringify({ k: 'focus', id: ID })), null);
  assert.equal(parseBridgeMessage(said({ k: 'msg', id: ID, data: '{bad', target: '*' })), null);
  assert.equal(parseBridgeMessage(said({ k: 'msg', id: ID, data: '1' })), null);
  assert.equal(parseBridgeMessage(said({ k: 'eval', id: ID })), null);
  assert.equal(parseBridgeMessage(said({ k: 'focus', id: 'x' })), null);
  assert.equal(parseBridgeMessage(BRIDGE_TAG + 'not json'), null);
  const big = JSON.stringify('x'.repeat(BRIDGE_MAX_DATA));
  assert.equal(parseBridgeMessage(said({ k: 'msg', id: ID, data: big, target: '*' })), null);
});

test('targetOrigin 은 브라우저 postMessage 와 같게 본다', () => {
  const bo = 'https://bo.x2bee.com';
  assert.equal(targetAllowed('*', bo, 'https://evil.example'), true);
  assert.equal(targetAllowed('/', bo, bo), true);
  assert.equal(targetAllowed('/', bo, 'https://evil.example'), false);
  assert.equal(targetAllowed('https://bo.x2bee.com/goods', bo, bo), true);
  assert.equal(targetAllowed('https://bo.x2bee.com', 'https://evil.example', bo), true);
  assert.equal(targetAllowed('https://fo.x2bee.com', bo, bo), false);
  assert.equal(targetAllowed('not a url', bo, bo), false);
});

test('받는 탭 스크립트는 데이터를 글자 그대로 옮긴다(코드로 해석하지 않는다)', () => {
  const data = { s: '"); alert(1); ("', n: null, list: ['</script>'] };
  const code = deliverScript(ID, data, 'https://bo.x2bee.com');
  const calls: unknown[][] = [];
  const window = { __dexPopupBridge: { deliver: (...a: unknown[]) => (calls.push(a), true) } };
  assert.equal(new Function('window', `return ${code};`)(window), true);
  assert.deepEqual(calls, [[ID, data, 'https://bo.x2bee.com']]);
  assert.equal(new Function('window', `return ${code};`)({}), false);
});
