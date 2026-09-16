/**
 * 채팅 스크롤 규칙 — 맨 아래에 붙어 있는지, [맨 아래로] 버튼을 띄울지.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distanceFromBottom,
  isNearBottom,
  JUMP_THRESHOLD_PX,
  shouldShowJump,
  STICK_THRESHOLD_PX,
} from '../src/renderer/src/views/chat-scroll';

const box = (scrollTop: number, scrollHeight = 5000, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight });

test('맨 아래까지 남은 거리', () => {
  assert.equal(distanceFromBottom(box(4200)), 0);
  assert.equal(distanceFromBottom(box(4000)), 200);
  // 고무줄 스크롤로 끝을 넘겨도 음수가 되지 않는다
  assert.equal(distanceFromBottom(box(4500)), 0);
});

test('경계 안쪽이면 따라가기를 유지한다', () => {
  assert.equal(isNearBottom(box(4200)), true);
  assert.equal(isNearBottom(box(4200 - STICK_THRESHOLD_PX)), true);
  assert.equal(isNearBottom(box(4200 - STICK_THRESHOLD_PX - 1)), false);
});

test('많이 올라갔을 때만 [맨 아래로] 버튼', () => {
  assert.equal(shouldShowJump(box(4200)), false);
  assert.equal(shouldShowJump(box(4200 - JUMP_THRESHOLD_PX)), false);
  assert.equal(shouldShowJump(box(4200 - JUMP_THRESHOLD_PX - 1)), true);
});

test('내용이 화면보다 짧으면 항상 맨 아래로 본다', () => {
  const short = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 };
  assert.equal(distanceFromBottom(short), 0);
  assert.equal(isNearBottom(short), true);
  assert.equal(shouldShowJump(short), false);
});
