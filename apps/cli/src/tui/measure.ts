import { useEffect, useRef, useState } from 'react';
import type { DOMElement } from 'ink';

/**
 * 어떤 칸이 화면의 **어디에, 얼마만큼** 그려지는지 레이아웃에서 읽어 온다.
 *
 * 예전에는 화면마다 `{ x: 16, y: 6 }`, `height - 5` 처럼 손으로 세어 넣었다. 그
 * 숫자는 그때의 레이아웃에서만 맞다 — 라벨 한 글자, 테두리 하나, 사이드바 폭이
 * 바뀌면 조용히 어긋난다. yoga 가 이미 정확히 아는 값이라 셀 이유가 없다.
 */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function placementOf(node: DOMElement | null): Placement | undefined {
  const yogaSelf = node?.yogaNode;
  if (!node || !yogaSelf) return undefined;
  let x = 0;
  let y = 0;
  for (let current: DOMElement | undefined = node; current; current = current.parentNode) {
    const yoga = current.yogaNode;
    if (!yoga) continue;
    x += yoga.getComputedLeft();
    y += yoga.getComputedTop();
  }
  return { x, y, width: yogaSelf.getComputedWidth(), height: yogaSelf.getComputedHeight() };
}

/**
 * 붙인 칸의 자리를 재서 돌려준다. 첫 프레임에는 `undefined` 다.
 *
 * ink 은 커밋이 **끝난 뒤에** 레이아웃을 계산하므로 여기서 읽으면 한 프레임 늦다.
 * 달라졌을 때만 상태를 바꿔 다음 프레임에서 맞춘다 — 매번 바꾸면 렌더가 끝없이 돈다.
 */
export function useMeasured(): [React.MutableRefObject<DOMElement | null>, Placement | undefined] {
  const ref = useRef<DOMElement | null>(null);
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);
  useEffect(() => {
    const measured = placementOf(ref.current);
    if (!measured) return;
    if (
      placement?.x !== measured.x ||
      placement?.y !== measured.y ||
      placement?.width !== measured.width ||
      placement?.height !== measured.height
    ) {
      setPlacement(measured);
    }
  });
  return [ref, placement];
}
