/**
 * 도구 활동 표시의 **순수 로직** — 렌더/타이머와 분리해 테스트 가능하게.
 *
 * UI 계약: "지금 쓰는 도구" 한 칸만 보여주고 다음으로 스르륵 교체한다.
 */
export interface ToolStepLike {
  eventType?: string;
  toolName?: string;
}

/** 연속된 같은 도구 이벤트(tool_call→tool_start→tool_result)를 한 단계로 접는다.
 *  마지막 상태만 남기므로 칩이 제자리에서 ⚙ → ✓ 로 바뀐다. */
export function collapseToolSteps<T extends ToolStepLike>(events: readonly T[]): T[] {
  const out: T[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && (prev.toolName ?? '') === (e.toolName ?? '')) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

/** 다음에 표시할 단계 인덱스.
 *  - 최신을 이미 보고 있으면 그대로 대기
 *  - 조금 밀렸으면 한 칸씩 (교체 애니메이션이 보이도록)
 *  - 많이 밀렸으면(>skipAfter) 최신으로 점프 (여러 도구를 빠르게 쓰면 슥 지나감) */
export function nextToolIndex(current: number, total: number, skipAfter = 3): number {
  if (total <= 0) return 0;
  const last = total - 1;
  if (current >= last) return last;
  return last - current > skipAfter ? last : current + 1;
}
