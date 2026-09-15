/**
 * 도구 과정 표시 규칙 — 칩 단계 · 호출 한 건 한 행 · 건수.
 *
 * 데스크톱 화면에 있던 규칙을 옮겨 왔다(원래 테스트 그대로 + id 짝 맞추기). 웹과
 * 앱이 같은 답변에 같은 건수를 말해야 하므로 규칙의 정본은 여기다.
 *
 * 가장 중요한 약속: **id 가 없는 이벤트에서는 예전과 한 글자도 다르지 않다.**
 * 서버가 id 를 싣기 전 판과 섞여 돌기 때문이다.
 */
import assert from 'assert'
import { test } from 'node:test'
import {
  collapseToolSteps,
  countToolCalls,
  formatToolLog,
  nextToolIndex,
  pairToolCalls,
  shortToolName,
  toolCallId,
  toolPhase,
  toolValueText,
} from '@dex/protocol/tool-activity'
import * as root from '@dex/protocol'
import { frameToChatEvent } from '@dex/protocol'
import type { ToolEvent } from '@dex/protocol'

const ev = (toolName: string, eventType: string) => ({ toolName, eventType })
const idEv = (toolName: string, eventType: string, toolUseId: string, extra: Partial<ToolEvent> = {}): ToolEvent =>
  ({ toolName, eventType, toolUseId, ...extra })

// ── 칩 단계 (옮겨 온 원래 테스트) ─────────────────────────────────────

test('연속된 같은 도구 이벤트는 한 단계로 접힌다 (마지막 상태 유지)', () => {
  const steps = collapseToolSteps([
    ev('Bash', 'tool_call'), ev('Bash', 'tool_start'), ev('Bash', 'tool_error'),
    ev('DocAnalyze', 'tool_call'), ev('DocAnalyze', 'tool_result'),
  ])
  assert.equal(steps.length, 2, '도구 2종 → 단계 2개')
  assert.deepEqual(steps[0], ev('Bash', 'tool_error'))
  assert.deepEqual(steps[1], ev('DocAnalyze', 'tool_result'))
})

test('스크린샷 시나리오(30 이벤트)가 도구 수만큼으로 접힌다', () => {
  const names = ['Bash', 'mcp__connector__Bash', 'mcp__connector__DocAnalyze',
    'mcp__connector__DocGuide', 'mcp__connector__DocBuild', 'mcp__connector__DocAnalyze',
    'mcp__connector__DocGuide', 'mcp__connector__DocXmlRead', 'mcp__connector__Bash', 'Write']
  const events = names.flatMap((n) => [ev(n, 'tool_call'), ev(n, 'tool_start'), ev(n, 'tool_result')])
  assert.equal(events.length, 30)
  assert.equal(collapseToolSteps(events).length, names.length, '30칩 벽 → 도구 단계 10개')
})

test('같은 도구가 떨어져서 다시 쓰이면 별도 단계다', () => {
  const steps = collapseToolSteps([ev('Bash', 'tool_result'), ev('Write', 'tool_result'), ev('Bash', 'tool_call')])
  assert.equal(steps.length, 3)
})

test('전진 규칙: 최신이면 대기, 조금 밀리면 한 칸, 많이 밀리면 최신으로 점프', () => {
  assert.equal(nextToolIndex(4, 5), 4, '최신 표시 중이면 그대로')
  assert.equal(nextToolIndex(0, 2), 1, '한 단계 밀림 → +1 (교체가 보이게)')
  assert.equal(nextToolIndex(0, 4), 1, '3단계 밀림(경계) → +1')
  assert.equal(nextToolIndex(0, 12), 11, '많이 밀리면 최신으로 점프 (슥 지나감)')
  assert.equal(nextToolIndex(9, 12), 10, '2단계 밀림 → +1')
  assert.equal(nextToolIndex(0, 5), 4, '4단계 밀림 → 점프')
})

test('빈 목록/범위 밖 인덱스에서도 안전하다', () => {
  assert.equal(nextToolIndex(0, 0), 0)
  assert.equal(nextToolIndex(99, 3), 2)
  assert.deepEqual(collapseToolSteps([]), [])
})

// ── 칩 단계: id 가 있을 때 ─────────────────────────────────────────────

/** 옮기기 전 데스크톱 구현 그대로 — id 없는 입력에서 새 구현과 같아야 한다. */
function legacyCollapse<T extends { toolName?: string }>(events: readonly T[]): T[] {
  const out: T[] = []
  for (const e of events) {
    const prev = out[out.length - 1]
    if (prev && (prev.toolName ?? '') === (e.toolName ?? '')) out[out.length - 1] = e
    else out.push(e)
  }
  return out
}

test('id 가 없으면 옮기기 전 구현과 결과가 똑같다 (무작위 2000개)', () => {
  let seed = 7
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const names = ['Bash', 'Read', 'Write', '', 'mcp__connector__Bash']
  const types = ['tool_call', 'tool_start', 'tool_result', 'tool_error']
  for (let round = 0; round < 2000; round++) {
    const events = Array.from({ length: rand(12) }, () => ({ toolName: rand(6) === 0 ? undefined : names[rand(names.length)], eventType: types[rand(types.length)] }))
    assert.deepEqual(collapseToolSteps(events), legacyCollapse(events))
  }
})

test('id 가 있으면 같은 이름의 동시 호출을 가른다', () => {
  const events = [
    idEv('Bash', 'tool_call', 'a'), idEv('Bash', 'tool_call', 'b'),
    idEv('Bash', 'tool_result', 'a'), idEv('Bash', 'tool_result', 'b'),
  ]
  assert.equal(legacyCollapse(events).length, 1, '이름만 보면 두 호출이 한 단계로 뭉친다')
  const steps = collapseToolSteps(events)
  assert.equal(steps.length, 2)
  assert.equal(steps[0], events[2])
  assert.equal(steps[1], events[3])
})

test('id 가 있으면 서로 끼어든 호출도 호출 수만큼만 단계가 된다', () => {
  const events = [
    idEv('Read', 'tool_call', 'r'), idEv('Grep', 'tool_call', 'g'),
    idEv('Read', 'tool_result', 'r'), idEv('Grep', 'tool_error', 'g'),
  ]
  assert.equal(legacyCollapse(events).length, 4, '이름만 보면 칩이 네 번 바뀐다')
  const steps = collapseToolSteps(events)
  assert.deepEqual(steps.map((s) => [s.toolName, s.eventType]), [['Read', 'tool_result'], ['Grep', 'tool_error']])
})

test('같은 호출을 id 를 알기 전후로 본 이웃은 이름으로 잇는다', () => {
  const steps = collapseToolSteps([
    idEv('Bash', 'tool_call', 'a'), ev('Bash', 'tool_start'), idEv('Bash', 'tool_result', 'a'),
  ])
  assert.equal(steps.length, 1)
  assert.equal(steps[0].eventType, 'tool_result')
})

test('toolUseId 가 없으면 runId 로 짝을 짓는다', () => {
  const steps = collapseToolSteps([
    { toolName: 'Bash', eventType: 'tool_call', runId: 'x' },
    { toolName: 'Bash', eventType: 'tool_call', runId: 'y' },
    { toolName: 'Bash', eventType: 'tool_result', runId: 'x' },
  ])
  assert.equal(steps.length, 2)
  assert.equal(steps[0].eventType, 'tool_result')
})

test('toolCallId: toolUseId 우선, 빈 문자열은 없는 것', () => {
  assert.equal(toolCallId({ toolUseId: 't', runId: 'r' }), 't')
  assert.equal(toolCallId({ toolUseId: '', runId: 'r' }), 'r')
  assert.equal(toolCallId({ runId: '' }), undefined)
  assert.equal(toolCallId({}), undefined)
})

// ── 이름 · 상태 · 복사용 텍스트 (옮겨 온 원래 테스트) ───────────────────

test('브릿지 접두사를 걷어낸다', () => {
  assert.equal(shortToolName('mcp__connector__mcp_mcp-atlassian_jira_search'), 'atlassian_jira_search')
  assert.equal(shortToolName('mcp__connector__Bash'), 'Bash')
  assert.equal(shortToolName('Bash'), 'Bash')
})

test('이름이 없어도 빈 칸을 남기지 않는다', () => {
  assert.equal(shortToolName(undefined), '(이름 없음)')
  assert.equal(shortToolName('  '), '(이름 없음)')
})

test('상태: 오류가 실리면 종류와 무관하게 실패', () => {
  assert.deepEqual(toolPhase({ eventType: 'tool_call' }), { label: '실행', tone: 'run' })
  assert.deepEqual(toolPhase({ eventType: 'tool_result' }), { label: '완료', tone: 'ok' })
  assert.deepEqual(toolPhase({ eventType: 'tool_error' }), { label: '실패', tone: 'err' })
  assert.deepEqual(toolPhase({ eventType: 'tool_result', error: 'x' }), { label: '실패', tone: 'err' })
})

test('값 글자화: 문자열은 그대로, 객체는 들여쓴 JSON, 없으면 빈 문자열', () => {
  assert.equal(toolValueText('a'), 'a')
  assert.equal(toolValueText({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(toolValueText(null), '')
  assert.equal(toolValueText(undefined), '')
})

test('붙여넣을 곳에서 그대로 읽힌다', () => {
  const out = formatToolLog([
    { eventType: 'tool_result', toolName: 'mcp__connector__Bash', toolInput: { command: 'ls' }, result: 'a.txt', durationMs: 12 },
  ])
  assert.match(out, /# 도구 실행 기록 \(1건\)/)
  assert.match(out, /## 1\. Bash — 완료/)
  assert.match(out, /### 입력/)
  assert.match(out, /"command": "ls"/)
  assert.match(out, /### 결과/)
  assert.match(out, /소요: 12ms/)
})

test('짧게 줄인 이름 때문에 원본을 잃지 않는다', () => {
  const out = formatToolLog([{ eventType: 'tool_result', toolName: 'mcp__connector__mcp_x_y', result: 'ok' }])
  assert.match(out, /전체 이름: mcp__connector__mcp_x_y/)
})

test('실패는 실패로 적힌다', () => {
  const out = formatToolLog([{ eventType: 'tool_error', toolName: 'Bash', error: '터짐' }])
  assert.match(out, /— 실패/)
  assert.match(out, /### 오류/)
  assert.match(out, /터짐/)
})

test('순서가 보존된다', () => {
  const out = formatToolLog([{ eventType: 'tool_result', toolName: 'A' }, { eventType: 'tool_result', toolName: 'B' }])
  assert.ok(out.indexOf('## 1. A') < out.indexOf('## 2. B'))
})

test('비어 있어도 터지지 않는다', () => {
  assert.match(formatToolLog([]), /0건/)
})

test('직렬화할 수 없는 인자도 삼키지 않는다', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const out = formatToolLog([{ eventType: 'tool_call', toolName: 'X', toolInput: cyclic }])
  assert.match(out, /## 1\. X/)
})

// ── 호출 한 건 = 한 행 ────────────────────────────────────────────────

test('id 없이: 시작과 끝을 한 행으로, 순서대로', () => {
  const rows = pairToolCalls([
    { eventType: 'tool_call', toolName: 'Read', toolInput: { path: 'a' }, timestamp: 't1' },
    { eventType: 'tool_result', toolName: 'Read', result: 'A', durationMs: 5, timestamp: 't2' },
    { eventType: 'tool_call', toolName: 'Bash', toolInput: { command: 'x' }, timestamp: 't3' },
    { eventType: 'tool_error', toolName: 'Bash', error: '터짐', durationMs: 9 },
  ])
  assert.deepEqual(rows, [
    { key: '#1', toolName: 'Read', input: { path: 'a' }, result: 'A', error: undefined, phase: 'ok', durationMs: 5, startedAt: 't1' },
    { key: '#2', toolName: 'Bash', input: { command: 'x' }, result: undefined, error: '터짐', phase: 'err', durationMs: 9, startedAt: 't3' },
  ])
})

test('id 없이: 같은 이름이 겹치면 끝은 가장 오래된 열린 호출에 붙는다', () => {
  const rows = pairToolCalls([
    { eventType: 'tool_call', toolName: 'Bash', toolInput: 1 },
    { eventType: 'tool_call', toolName: 'Bash', toolInput: 2 },
    { eventType: 'tool_result', toolName: 'Bash', result: 'r1' },
  ])
  assert.deepEqual(rows.map((r) => [r.input, r.phase, r.result]), [[1, 'ok', 'r1'], [2, 'run', undefined]])
})

test('id 가 있으면 끝나는 순서가 뒤바뀌어도 제 호출에 붙는다', () => {
  const events = [
    idEv('Bash', 'tool_call', 'a', { toolInput: 1 }),
    idEv('Bash', 'tool_call', 'b', { toolInput: 2 }),
    idEv('Bash', 'tool_result', 'b', { result: 'r2' }),
    idEv('Bash', 'tool_result', 'a', { result: 'r1' }),
  ]
  const rows = pairToolCalls(events)
  assert.deepEqual(rows.map((r) => [r.key, r.input, r.result]), [['a', 1, 'r1'], ['b', 2, 'r2']])
  // 이름 규칙만이면 뒤바뀌어 붙었을 것이다.
  const byName = pairToolCalls(events.map(({ toolUseId: _drop, ...rest }) => rest))
  assert.deepEqual(byName.map((r) => [r.input, r.result]), [[1, 'r2'], [2, 'r1']])
})

test('tool_start 는 새 호출이 아니다', () => {
  const rows = pairToolCalls([ev('X', 'tool_call'), ev('X', 'tool_start'), ev('X', 'tool_result')])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].phase, 'ok')
})

test('시작을 못 본 끝(턴 중간에 붙은 화면)도 한 행으로 남는다', () => {
  const rows = pairToolCalls([{ eventType: 'tool_result', toolName: 'X', result: 'ok' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].phase, 'ok')
  assert.equal(rows[0].input, undefined)
})

test('아직 안 끝난 호출은 실행 중이다', () => {
  assert.equal(pairToolCalls([ev('X', 'tool_call')])[0].phase, 'run')
})

test('결과 이벤트에 오류가 실리면 실패, 뒤에 온 이벤트가 실패를 덮지 않는다', () => {
  assert.equal(pairToolCalls([idEv('X', 'tool_call', 'a'), idEv('X', 'tool_result', 'a', { error: 'e' })])[0].phase, 'err')
  assert.equal(pairToolCalls([idEv('X', 'tool_error', 'a', { error: 'e' }), idEv('X', 'tool_result', 'a')])[0].phase, 'err')
})

test('이벤트가 더 와도 앞 행의 키는 바뀌지 않는다 (목록이 튀지 않게)', () => {
  const events = [ev('A', 'tool_call'), ev('A', 'tool_result'), idEv('B', 'tool_call', 'b'), ev('C', 'tool_call')]
  const early = pairToolCalls(events.slice(0, 2)).map((r) => r.key)
  const late = pairToolCalls(events).map((r) => r.key)
  assert.deepEqual(late.slice(0, early.length), early)
  assert.deepEqual(late, ['#1', 'b', '#3'])
})

test('id 없는 끝은 다른 id 의 열린 호출도 이어 받지만, id 있는 끝은 남의 id 를 뺏지 않는다', () => {
  const rows = pairToolCalls([idEv('X', 'tool_call', 'a'), idEv('X', 'tool_result', 'z')])
  assert.equal(rows.length, 2, '다른 id 의 끝은 새 행')
  assert.equal(rows[0].phase, 'run')
  const adopt = pairToolCalls([ev('X', 'tool_call'), idEv('X', 'tool_result', 'a')])
  assert.equal(adopt.length, 1, 'id 를 모르던 호출은 이어 받는다')
})

test('건수 = 호출 수 (이벤트 수가 아니다)', () => {
  const events = [ev('A', 'tool_call'), ev('A', 'tool_start'), ev('A', 'tool_result'), ev('B', 'tool_call'), ev('B', 'tool_result')]
  assert.equal(countToolCalls(events), 2)
  assert.equal(countToolCalls([]), 0)
  assert.equal(countToolCalls(events), pairToolCalls(events).length)
})

test('잘못 섞여 들어온 값에 터지지 않는다', () => {
  assert.deepEqual(pairToolCalls([null as unknown as ToolEvent, ev('A', 'tool_call')]).map((r) => r.toolName), ['A'])
})

// ── 서버 이벤트에서 id 가 옮겨지는지 ───────────────────────────────────

test('서버 tool 이벤트의 tool_use_id 가 toolUseId 로 온다', () => {
  const withId = frameToChatEvent('tool', JSON.stringify({ event_type: 'tool_call', tool_name: 'Bash', tool_use_id: 'tu_1', run_id: 'tu_1' }))
  assert.ok(withId && withId.kind === 'tool')
  assert.equal(withId.event.toolUseId, 'tu_1')
  assert.equal(withId.event.runId, 'tu_1')
  const old = frameToChatEvent('tool', JSON.stringify({ event_type: 'tool_call', tool_name: 'Bash' }))
  assert.ok(old && old.kind === 'tool')
  assert.equal(old.event.toolUseId, undefined)
})

test('패키지 루트에서도 같은 함수가 나온다', () => {
  assert.equal(root.pairToolCalls, pairToolCalls)
  assert.equal(root.countToolCalls, countToolCalls)
  assert.equal(root.collapseToolSteps, collapseToolSteps)
})
