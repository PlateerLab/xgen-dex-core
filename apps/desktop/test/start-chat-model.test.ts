/** 시작 화면("오늘은 무엇을 해볼까요?")의 입력창 잠금: 보낼 수 있을 때만 열린다. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_REQUIRED,
  NAME_REQUIRED,
  NAME_TAKEN,
  OPTIONS_LOADING,
  lockedByName,
  startChatLockReason,
} from '../src/renderer/src/views/start-chat-model';

const base = { isNew: true, name: '리서치 도우미', nameTaken: false, optionsReady: true, optionsError: null, agentSelected: false };

test('새 에이전트: 이름이 없으면 잠기고, 까닭은 이름 칸을 가리킨다', () => {
  const reason = startChatLockReason({ ...base, name: '   ' });
  assert.equal(reason, NAME_REQUIRED);
  assert.equal(lockedByName(reason), true);
});

test('새 에이전트: 이름이 겹치면 잠긴다', () => {
  const reason = startChatLockReason({ ...base, nameTaken: true });
  assert.equal(reason, NAME_TAKEN);
  assert.equal(lockedByName(reason), true);
});

test('새 에이전트: 모델 목록이 오기 전에는 잠기고, 못 받았으면 그 까닭을 보인다', () => {
  assert.equal(startChatLockReason({ ...base, optionsReady: false }), OPTIONS_LOADING);
  assert.equal(startChatLockReason({ ...base, optionsReady: false, optionsError: '서버 오류' }), '서버 오류');
  assert.equal(lockedByName(OPTIONS_LOADING), false);
});

test('새 에이전트: 이름이 있고 겹치지 않고 모델 목록이 있으면 열린다', () => {
  assert.equal(startChatLockReason(base), null);
});

test('고른 에이전트: 골라져 있으면 열리고, 아니면 고르라고 한다', () => {
  assert.equal(startChatLockReason({ ...base, isNew: false, name: '', agentSelected: true }), null);
  assert.equal(startChatLockReason({ ...base, isNew: false, agentSelected: false }), AGENT_REQUIRED);
});
