/** 도구 활동 표시 — 한 번에 하나, 연속 상태는 제자리, 몰리면 건너뛰기.
 *
 * 규칙 자체는 `@dex/protocol/tool-activity` 가 정본이고 테스트도 그쪽에 있다
 * (packages/protocol/test/tool-activity.test.ts). 여기서는 데스크톱이 **그 규칙을
 * 쓰는지**, 그리고 사본을 다시 두지 않았는지만 본다. */
import assert from 'assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collapseToolSteps, nextToolIndex } from '@dex/protocol/tool-activity'

const VIEWS = join(__dirname, '..', 'src/renderer/src/views')
const CHAT = readFileSync(join(VIEWS, 'Chat.tsx'), 'utf8')

const ev = (toolName: string, eventType: string) => ({ toolName, eventType })

test('칩 규칙은 protocol 에서 가져온다 (앱 안에 사본이 없다)', () => {
  assert.match(CHAT, /import \{ collapseToolSteps, nextToolIndex \} from '@dex\/protocol\/tool-activity'/)
  assert.equal(existsSync(join(VIEWS, 'tool-activity-model.ts')), false, '옛 사본이 되살아나면 웹과 규칙이 갈라진다')
})

test('데스크톱 경로로 불러도 id 없는 이벤트는 예전처럼 접힌다', () => {
  const steps = collapseToolSteps([
    ev('Bash', 'tool_call'), ev('Bash', 'tool_start'), ev('Bash', 'tool_error'),
    ev('DocAnalyze', 'tool_call'), ev('DocAnalyze', 'tool_result'),
  ])
  assert.deepEqual(steps, [ev('Bash', 'tool_error'), ev('DocAnalyze', 'tool_result')])
  assert.equal(nextToolIndex(0, 12), 11)
})

// 회귀: 탭 전환으로 이미 끝난 메시지에 ToolActivity 가 새로 마운트될 때, "표시 대상 갱신"
// 이펙트가 streaming 을 안 보고 무조건 첫 단계 칩을 켰다가 "턴 종료" 이펙트가 바로 꺼버려
// 옛 도구 칩이 한 프레임 번쩍이고 사라지는 버그가 있었다. 두 이펙트 모두 streaming 을 보는
// 실제 렌더 테스트는 이 저장소에 React 테스트 하네스가 없어 대신 소스 계약으로 고정한다
// (tool-log.test.ts 가 이미 쓰는 패턴).
test('회귀: 표시 대상 갱신 이펙트는 streaming 이 아니면 아무것도 켜지 않는다(탭 전환 시 옛 칩 번쩍임 방지)', () => {
  const effect = /useEffect\(\(\) => \{\s*if \(!streaming\) return;\s*const target = steps\[/
  assert.match(CHAT, effect, 'streaming 가드가 target 계산보다 먼저 와야 마운트 시 번쩍임이 없다')
})
