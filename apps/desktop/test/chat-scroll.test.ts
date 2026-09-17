/**
 * 채팅 스크롤 규칙 — 맨 아래에 붙어 있는지, [맨 아래로] 버튼을 띄울지.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideStick,
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

test('맨 아래에 닿으면 따라가기를 켠다', () => {
  assert.equal(decideStick(box(4200), 4200, true), true);
  // 위로 올려 꺼 두었어도 다시 맨 아래까지 내리면 되켠다
  assert.equal(decideStick(box(4200), 3000, false), true);
});

test('사용자가 위로 올리면 따라가기를 끈다', () => {
  assert.equal(decideStick(box(3000), 4200, true), false);
  // 소수점·관성 흔들림은 방향으로 치지 않는다
  assert.equal(decideStick(box(4000), 4002, true), true);
});

test('답이 자라 거리만 벌어진 것으로는 따라가기를 끄지 않는다', () => {
  // 우리가 맨 아래로 내린 뒤(마지막 위치 = 실제 scrollTop) 작업 과정이 커져 거리가 벌어진 상황
  const grown = { scrollTop: 4200, scrollHeight: 5400, clientHeight: 800 };
  assert.equal(distanceFromBottom(grown), 400);
  assert.equal(decideStick(grown, 4200, true), true);
  // 회귀 방지: 마지막 위치에 scrollHeight 를 적으면 같은 상황이 "위로 올렸다"로 읽혔다(2026-09-16)
  assert.equal(decideStick(grown, 5000, true), false);
});

test('내용이 화면보다 짧으면 항상 맨 아래로 본다', () => {
  const short = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 };
  assert.equal(distanceFromBottom(short), 0);
  assert.equal(isNearBottom(short), true);
  assert.equal(shouldShowJump(short), false);
});
