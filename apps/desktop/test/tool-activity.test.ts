/** 도구 활동 표시 로직 — 한 번에 하나, 연속 상태는 제자리, 몰리면 건너뛰기. */
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collapseToolSteps, nextToolIndex } from '../src/renderer/src/views/tool-activity-model'

const ev = (toolName: string, eventType: string) => ({ toolName, eventType })

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

// 회귀: 탭 전환으로 이미 끝난 메시지에 ToolActivity 가 새로 마운트될 때, "표시 대상 갱신"
// 이펙트가 streaming 을 안 보고 무조건 첫 단계 칩을 켰다가 "턴 종료" 이펙트가 바로 꺼버려
// 옛 도구 칩이 한 프레임 번쩍이고 사라지는 버그가 있었다. 두 이펙트 모두 streaming 을 보는
// 실제 렌더 테스트는 이 저장소에 React 테스트 하네스가 없어 대신 소스 계약으로 고정한다
// (tool-log.test.ts 가 이미 쓰는 패턴).
test('회귀: 표시 대상 갱신 이펙트는 streaming 이 아니면 아무것도 켜지 않는다(탭 전환 시 옛 칩 번쩍임 방지)', () => {
  const chat = readFileSync(join(__dirname, '..', 'src/renderer/src/views/Chat.tsx'), 'utf8')
  const effect = /useEffect\(\(\) => \{\s*if \(!streaming\) return;\s*const target = steps\[/
  assert.match(chat, effect, 'streaming 가드가 target 계산보다 먼저 와야 마운트 시 번쩍임이 없다')
})
