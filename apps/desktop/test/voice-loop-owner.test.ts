/** 계속 듣기를 맡은 화면(voice-loop-owner) — 켜짐은 하나, 듣는 화면도 하나. 말로 새 채팅을 열면 시작 화면·새 대화가 잇는다. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceLoopOwner as o } from '../src/renderer/src/voice/voice-loop-owner';

test('마이크를 누른 화면이 듣고, 다시 누르면 끈다', () => {
  o.reset();
  o.toggle('chat:a');
  assert.equal(o.listening('chat:a'), true);
  o.toggle('chat:a');
  assert.equal(o.listening('chat:a'), false);
  assert.equal(o.get().on, false);
});

test('다른 화면의 마이크는 끄지 않고 넘겨받는다', () => {
  o.reset();
  o.toggle('chat:a');
  o.toggle('chat:b');
  assert.equal(o.listening('chat:a'), false);
  assert.equal(o.listening('chat:b'), true);
});

test('켜진 채 시작 화면이 열리면 넘겨받고, 연 대화에 넘긴다', () => {
  o.reset();
  o.toggle('chat:a');
  o.claim('start:agent-create');
  assert.equal(o.listening('start:agent-create'), true);
  assert.equal(o.listening('chat:a'), false);
  o.pass('start:agent-create', 'chat:new');
  assert.equal(o.listening('chat:new'), true);
});

test('꺼져 있으면 시작 화면이 열려도 듣지 않는다, 맡지 않은 화면은 넘기지 못한다', () => {
  o.reset();
  o.claim('start:agent-create');
  assert.equal(o.get().on, false);
  o.toggle('chat:a');
  o.pass('start:agent-create', 'chat:new');
  assert.equal(o.listening('chat:a'), true);
  assert.equal(o.listening('chat:new'), false);
});

test('오류로 끄기는 맡은 화면만', () => {
  o.reset();
  o.toggle('chat:a');
  o.stop('chat:b');
  assert.equal(o.listening('chat:a'), true);
  o.stop('chat:a');
  assert.equal(o.get().on, false);
});
