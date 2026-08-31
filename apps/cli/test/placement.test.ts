/**
 * 입력 칸이 화면의 몇 번째 칸·줄에 그려지는가.
 *
 * 이 값이 틀리면 진짜 터미널 커서가 글자와 다른 자리에 서고, 터미널 IME 는 조합
 * 중인 한글을 그 자리에 그린다 — 사용자에게는 한글이 엉뚱한 데 나타나거나 아예
 * 입력되지 않는 것처럼 보인다. 예전에는 화면마다 손으로 세어 넣던 값이라, 라벨
 * 한 글자만 바뀌어도 조용히 어긋났다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DOMElement } from 'ink';
import { placementOf } from '../src/tui/ime-text-input';

/** 부모를 타고 올라가는 계산만 보면 되므로 yoga 는 흉내만 낸다. */
function node(left: number, top: number, width: number, parent?: DOMElement): DOMElement {
  return {
    yogaNode: {
      getComputedLeft: () => left,
      getComputedTop: () => top,
      getComputedWidth: () => width,
    },
    parentNode: parent,
  } as unknown as DOMElement;
}

test('부모를 따라 올라가며 좌표를 더한다', () => {
  const root = node(0, 0, 120);
  const body = node(30, 1, 90, root);
  const box = node(2, 27, 86, body);
  const input = node(2, 0, 84, box);
  assert.deepEqual(placementOf(input), { x: 34, y: 28, width: 84 });
});

test('가장 바깥 노드는 그 자리 그대로다', () => {
  assert.deepEqual(placementOf(node(0, 0, 100)), { x: 0, y: 0, width: 100 });
});

test('yoga 가 없는 조상은 건너뛴다', () => {
  // ink-virtual-text 처럼 레이아웃에 참여하지 않는 노드가 사이에 낀다.
  const root = node(0, 0, 80);
  const virtual = { parentNode: root } as unknown as DOMElement;
  const input = node(5, 3, 40, virtual);
  assert.deepEqual(placementOf(input), { x: 5, y: 3, width: 40 });
});

test('아직 레이아웃이 없으면 아무것도 말하지 않는다', () => {
  // 첫 프레임에는 값이 없다. 0 을 돌려주면 커서가 화면 왼쪽 위로 튄다.
  assert.equal(placementOf(null), undefined);
  assert.equal(placementOf({ parentNode: undefined } as unknown as DOMElement), undefined);
});
