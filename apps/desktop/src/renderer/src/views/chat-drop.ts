/**
 * 파일을 끌어다 놓는 동안의 규칙 — 무엇을 받고, 안내를 언제 켜고 끄는가.
 *
 * 화면에서 떼어 둔 이유: dragenter/dragleave 는 **자식 요소마다** 온다. 켜고 끄기를
 * 그대로 따라 하면 말풍선 하나를 지날 때마다 안내가 깜빡이고, 어떤 순서에서는 켜진 채로
 * 남아 화면을 덮는다. 세는 규칙이 맞는지는 눈으로 확인할 수 없어 테스트로 지킨다.
 */

/** 이 드래그가 파일을 들고 있는가. 텍스트·링크 드래그에는 반응하지 않는다. */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return Array.from(types ?? []).includes('Files');
}

/**
 * 들어오고 나간 횟수를 세어 "지금 덮개를 보여야 하는가" 를 답한다.
 *
 * drop 과 화면 이탈에서는 0 으로 되돌린다 — 브라우저는 drop 뒤에 남은 dragleave 를
 * 보내 주지 않아서, 빼기만 하면 깊이가 영영 1 에 머문다.
 */
export class DropTracker {
  private depth = 0;

  enter(): boolean {
    this.depth += 1;
    return this.depth === 1;
  }

  leave(): boolean {
    this.depth = Math.max(0, this.depth - 1);
    return this.depth === 0;
  }

  reset(): void {
    this.depth = 0;
  }

  get active(): boolean {
    return this.depth > 0;
  }
}
