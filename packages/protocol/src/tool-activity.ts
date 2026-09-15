/**
 * 도구 과정 표시 규칙 — 답변이 도는 동안 무엇을 한 칸씩 보여주고, 끝난 뒤 무엇을
 * 몇 건으로 세는지.
 *
 * 데스크톱 화면에 있던 순수 함수를 여기로 올렸다. 웹(xgen-frontend)도 같은 칩과
 * 같은 [전체 로그 보기 · N건] 을 그린다 — 규칙이 앱마다 따로 있으면 같은 답변을
 * 한쪽은 3건, 다른 쪽은 9건이라고 말하게 된다. 렌더와 타이머는 여기 없다.
 *
 * 짝 맞추기의 기준은 하나다: 이벤트에 `toolUseId`(없으면 `runId`)가 있으면 그것,
 * 없으면 이름. 서버가 id 를 싣기 전에도 지금과 똑같이 동작해야 하므로 이름 규칙은
 * 버리는 것이 아니라 바닥으로 남는다. id 가 있으면 같은 이름의 동시 호출과 뒤섞여
 * 끝나는 호출을 제대로 가른다.
 */
import type { ToolEvent } from './types';

/** 호출 한 건의 상태 — 실행 중 · 완료 · 실패. */
export type ToolPhase = 'run' | 'ok' | 'err';

/** 칩 규칙이 보는 최소 모양. `ToolEvent` 가 그대로 들어간다. */
export interface ToolStepLike {
  eventType?: string;
  toolName?: string;
  toolUseId?: string;
  runId?: string;
  error?: string;
}

/** 로그 창의 한 행 = 도구 호출 한 건 (시작 · 진행 · 끝 이벤트를 한 줄로 합친 것). */
export interface ToolCallRow {
  /** 목록 키 — 호출 id, 없으면 `#<순번>`. 행이 생길 때 정해져 이벤트가 더 와도 바뀌지 않는다. */
  key: string;
  /** 원래 이름 (접두사 포함). 화면에는 `shortToolName` 으로. 이름이 없으면 빈 문자열. */
  toolName: string;
  input: unknown;
  result: ToolEvent['result'];
  error: string | undefined;
  phase: ToolPhase;
  durationMs: number | undefined;
  /** 이 호출에서 처음 본 이벤트의 시각. */
  startedAt: string | undefined;
}

/** 이 이벤트가 속한 호출의 id — `toolUseId` 우선, 없으면 `runId`. 빈 문자열은 없는 것으로 본다. */
export function toolCallId(e: Pick<ToolStepLike, 'toolUseId' | 'runId'>): string | undefined {
  for (const v of [e.toolUseId, e.runId]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * 목록에 쓸 짧은 이름 — 브릿지 접두사를 걷어낸다.
 *
 * `mcp__connector__mcp_mcp-atlassian_jira_search` 를 그대로 두면 목록이
 * 접두사로만 채워져 무엇이 무엇인지 구분되지 않는다 (실제로 화면에서
 * `mcp__connector__mcp_mcp-atlassi…` 로 잘려 보였다). 원본은 상세에 남긴다.
 */
export function shortToolName(raw: string | undefined): string {
  const name = String(raw ?? '').trim();
  if (!name) return '(이름 없음)';
  return name.replace(/^mcp__connector__/, '').replace(/^mcp_(mcp-)?/, '');
}

/** 이벤트 하나의 상태와 그 이름표. 오류가 실려 있으면 종류와 무관하게 실패다. */
export function toolPhase(e: Pick<ToolStepLike, 'eventType' | 'error'>): {
  label: string;
  tone: ToolPhase;
} {
  if (e.eventType === 'tool_error' || e.error) return { label: '실패', tone: 'err' };
  if (e.eventType === 'tool_result') return { label: '완료', tone: 'ok' };
  return { label: '실행', tone: 'run' };
}

/** 입력 · 결과 값을 읽을 수 있는 글로. 직렬화할 수 없는 값도 삼키지 않는다. */
export function toolValueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 전체 기록을 사람이 읽을 수 있는 텍스트로 (복사용).
 *
 * JSON 덩어리 하나로 주지 않는다 — 붙여넣는 곳이 이슈든 채팅이든 그대로
 * 읽혀야 하고, 그러려면 섹션이 있어야 한다.
 */
export function formatToolLog(events: readonly ToolEvent[]): string {
  const lines: string[] = [`# 도구 실행 기록 (${events.length}건)`, ''];
  events.forEach((e, i) => {
    lines.push(`## ${i + 1}. ${shortToolName(e.toolName)} — ${toolPhase(e).label}`);
    if (e.toolName && shortToolName(e.toolName) !== e.toolName) {
      lines.push(`- 전체 이름: ${e.toolName}`);
    }
    if (typeof e.durationMs === 'number') lines.push(`- 소요: ${e.durationMs}ms`);
    if (e.timestamp) lines.push(`- 시각: ${e.timestamp}`);
    const input = toolValueText(e.toolInput);
    if (input) lines.push('', '### 입력', '```json', input, '```');
    if (e.error) lines.push('', '### 오류', '```', String(e.error), '```');
    const result = toolValueText(e.result);
    if (result) lines.push('', '### 결과', '```', result, '```');
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 칩에 보여줄 단계들 — 한 호출의 이벤트(tool_call → tool_start → tool_result)를
 * 한 단계로 접고 마지막 상태만 남긴다. 그래서 칩이 제자리에서 실행 → 완료로 바뀐다.
 *
 * - id 가 있으면 id 로 접는다. 떨어져 있어도 같은 호출이면 한 단계다 (동시 호출이
 *   서로 끼어들어도 단계 수가 호출 수와 같다).
 * - id 가 없으면 예전 그대로 **바로 앞 단계와 이름이 같을 때만** 접는다.
 * - 한쪽에만 id 가 있는 이웃(같은 호출을 id 를 알기 전과 후에 본 것)은 이름으로 잇는다.
 */
export function collapseToolSteps<T extends ToolStepLike>(events: readonly T[]): T[] {
  const out: T[] = [];
  const ids: (string | undefined)[] = [];
  const byId = new Map<string, number>();
  for (const e of events) {
    const id = toolCallId(e);
    if (id !== undefined) {
      const at = byId.get(id);
      if (at !== undefined) {
        out[at] = e;
        continue;
      }
    }
    const last = out.length - 1;
    const prev = out[last];
    const sameName = prev !== undefined && (prev.toolName ?? '') === (e.toolName ?? '');
    // 둘 다 id 가 있는데 다르면 이름이 같아도 다른 호출이다.
    if (sameName && (id === undefined || ids[last] === undefined)) {
      out[last] = e;
      if (id !== undefined) {
        ids[last] = id;
        byId.set(id, last);
      }
      continue;
    }
    out.push(e);
    ids.push(id);
    if (id !== undefined) byId.set(id, out.length - 1);
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

/**
 * 도구 호출 한 건 = 한 행.
 *
 * 짝: id 가 있으면 그 id 의 행. 없으면 끝(tool_result · tool_error)과 tool_start 는
 * **같은 이름의 가장 오래된 열린 호출**에 붙는다. tool_call 은 언제나 새 호출이다.
 * 짝이 없는 끝 이벤트(턴 중간에 붙은 화면)도 버리지 않고 한 행으로 남긴다.
 *
 * 실패는 뒤에 온 이벤트가 덮지 않는다 — 한 번 실패한 호출을 완료로 보이게 하면 안 된다.
 */
export function pairToolCalls(events: readonly ToolEvent[]): ToolCallRow[] {
  const rows: ToolCallRow[] = [];
  const byId = new Map<string, ToolCallRow>();
  /** id 를 가진 행 — 이름 규칙으로는 id 없는 행만 이어 받는다 (다른 id 의 호출을 뺏지 않게). */
  const idRows = new Set<ToolCallRow>();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const id = toolCallId(e);
    const name = typeof e.toolName === 'string' ? e.toolName : '';
    const tone = toolPhase(e).tone;
    const ending = tone !== 'run';

    let row = id !== undefined ? byId.get(id) : undefined;
    if (!row && (ending || e.eventType === 'tool_start')) {
      row = rows.find((r) => r.phase === 'run' && r.toolName === name && (id === undefined || !idRows.has(r)));
    }
    if (!row) {
      row = {
        key: id ?? `#${rows.length + 1}`,
        toolName: name,
        input: undefined,
        result: undefined,
        error: undefined,
        phase: 'run',
        durationMs: undefined,
        startedAt: undefined,
      };
      rows.push(row);
    }
    if (id !== undefined && !byId.has(id)) {
      byId.set(id, row);
      idRows.add(row);
    }

    if (!row.toolName && name) row.toolName = name;
    if (row.input === undefined && e.toolInput !== undefined) row.input = e.toolInput;
    if (row.startedAt === undefined && typeof e.timestamp === 'string' && e.timestamp) {
      row.startedAt = e.timestamp;
    }
    if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) row.durationMs = e.durationMs;
    if (e.result !== undefined) row.result = e.result;
    if (e.error) row.error = String(e.error);
    if (ending && row.phase !== 'err') row.phase = tone;
  }
  return rows;
}

/** 이 이벤트들 안의 도구 호출 수 — [전체 로그 보기 · N건] 의 N. 이벤트 수가 아니다. */
export function countToolCalls(events: readonly ToolEvent[]): number {
  return pairToolCalls(events).length;
}
