/**
 * 연결된 에이전트의 **원본은 서버 하나**다.
 *
 * 예전에는 커넥터가 자기 `connector.json` 에 목록을 따로 들고 있었다. 그래서
 * 웹에서 연결한 에이전트는 커넥터에 안 뜨고, 커넥터에서 추가한 에이전트는
 * 웹에 안 떴다 — 같은 이름의 목록 둘이 각자 다른 저장소를 보고 서로 다른
 * 말을 했다. 어느 쪽이 맞는지 사용자가 알 방법도 없었다.
 *
 * 이제 서버가 유일한 원본이고 로컬 설정은 그 사본이다. 여기서 고정하는 것:
 *
 *   1. 서버에 있는 것이 이 PC 에 나타나고, 없어진 것은 사라진다.
 *   2. **폴더명과 id 는 로컬 것을 지킨다** — 폴더명이 바뀌면 사용자 화면에서
 *      폴더가 이름을 바꾸며 움직이고, id 가 바뀌면 동기화 인덱스가 처음부터
 *      다시 시작한다.
 *   3. **서버를 못 읽으면 아무것도 하지 않는다.** 빈 목록을 반영하면 드라이브의
 *      에이전트 폴더가 전부 사라져, 사용자에게는 파일이 통째로 날아간 것으로
 *      보인다.
 *   4. 드라이브 on/off 와 루트 위치는 이 동기화가 건드리지 않는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyCloudLinks, sameAgents, type WorkspaceConfig } from '../src/main/workspace'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../src/main/workspace-manager'

let seq = 0
const ids = () => `id-${++seq}`

const local = (agents: WorkspaceConfig['agents'], extra: Partial<WorkspaceConfig> = {}) =>
  ({ root: '/r', enabled: true, agents, ...extra }) as WorkspaceConfig

test('웹에서 연결한 에이전트가 이 PC 에 나타난다', () => {
  const next = applyCloudLinks(local([]), [{ workflowId: 'wf-1', label: '보고서 작성기' }], ids)
  assert.equal(next.agents.length, 1)
  assert.equal(next.agents[0].workflowId, 'wf-1')
  assert.equal(next.agents[0].folder, '보고서 작성기')
})

test('서버에서 사라진 에이전트는 이 PC 에서도 사라진다', () => {
  const cur = local([{ id: 'a', workflowId: 'wf-1', label: 'A', folder: 'A' }])
  assert.deepEqual(applyCloudLinks(cur, [], ids).agents, [])
})

test('이미 있던 에이전트의 폴더명과 id 는 그대로 둔다', () => {
  // 사용자가 이 폴더에 익숙해져 있고, id 가 바뀌면 동기화가 처음부터 다시 돈다.
  const cur = local([{ id: 'keep-me', workflowId: 'wf-1', label: '옛 이름', folder: '옛 폴더' }])
  const next = applyCloudLinks(cur, [{ workflowId: 'wf-1', label: '새 이름' }], ids)
  assert.equal(next.agents[0].id, 'keep-me')
  assert.equal(next.agents[0].folder, '옛 폴더')
  // 이름은 서버를 따른다 — 에이전트를 개명하면 목록에도 보여야 한다.
  assert.equal(next.agents[0].label, '새 이름')
})

test('새로 붙는 에이전트의 폴더명은 기존 것과 겹치지 않는다', () => {
  const cur = local([{ id: 'a', workflowId: 'wf-1', label: '분석', folder: '분석' }])
  const next = applyCloudLinks(
    cur,
    [
      { workflowId: 'wf-1', label: '분석' },
      { workflowId: 'wf-2', label: '분석' },
    ],
    ids,
  )
  assert.notEqual(next.agents[0].folder, next.agents[1].folder, '두 에이전트가 한 폴더를 쓴다')
})

test('일시중지 상태도 서버를 따른다', () => {
  const cur = local([{ id: 'a', workflowId: 'wf-1', label: 'A', folder: 'A', paused: true }])
  const next = applyCloudLinks(cur, [{ workflowId: 'wf-1', label: 'A', paused: false }], ids)
  assert.equal(next.agents[0].paused, false)
})

test('드라이브 on/off 와 루트는 건드리지 않는다', () => {
  const cur = local([], { enabled: false, root: '/내가/고른/곳' })
  const next = applyCloudLinks(cur, [{ workflowId: 'wf-1', label: 'A' }], ids)
  assert.equal(next.enabled, false, '에이전트가 붙었다고 드라이브가 켜지면 안 된다')
  assert.equal(next.root, '/내가/고른/곳')
})

test('같은 목록이면 같다고 판정한다 (설정을 헛되이 다시 쓰지 않는다)', () => {
  const a = [{ id: 'x', workflowId: 'wf-1', label: 'A', folder: 'A' }]
  assert.ok(sameAgents(a, [{ ...a[0] }]))
  assert.ok(!sameAgents(a, [{ ...a[0], label: 'B' }]))
  assert.ok(!sameAgents(a, []))
})

// ── 매니저 배선 ───────────────────────────────────────────────────

function manager(
  cloudLinks: WorkspaceManagerDeps['cloudLinks'],
  start: WorkspaceConfig,
): { saved: WorkspaceConfig[]; sync: () => Promise<void> } {
  const saved: WorkspaceConfig[] = []
  let cur = start
  const deps: WorkspaceManagerDeps = {
    config: () => cur,
    apiFor: () => ({}) as never,
    loggedIn: () => true,
    cloudLinks,
    persist: (next) => {
      saved.push(next)
      cur = next
    },
    newId: () => 'new',
  }
  const m = new WorkspaceManager(deps)
  const sync = (m as unknown as { syncCloudLinks: () => Promise<void> }).syncCloudLinks.bind(m)
  return { saved, sync }
}

test('매 리컨사일마다 서버에서 받아 저장한다', async () => {
  const { saved, sync } = manager(
    async () => [{ workflowId: 'wf-1', label: 'A' }],
    local([]),
  )
  await sync()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].agents[0].workflowId, 'wf-1')
})

test('서버를 못 읽으면 로컬 목록을 그대로 둔다', async () => {
  const cur = local([{ id: 'a', workflowId: 'wf-1', label: 'A', folder: 'A' }])
  const { saved, sync } = manager(async () => {
    throw new Error('네트워크')
  }, cur)
  await sync()
  assert.deepEqual(saved, [], '빈 목록을 반영하면 드라이브의 에이전트 폴더가 전부 사라진다')
})

test('바뀐 게 없으면 설정을 다시 쓰지 않는다', async () => {
  const cur = local([{ id: 'a', workflowId: 'wf-1', label: 'A', folder: 'A' }])
  const { saved, sync } = manager(async () => [{ workflowId: 'wf-1', label: 'A' }], cur)
  await sync()
  assert.deepEqual(saved, [])
})

test('로그아웃 상태에서는 서버에 묻지 않는다', async () => {
  let asked = 0
  const deps: WorkspaceManagerDeps = {
    config: () => local([]),
    apiFor: () => ({}) as never,
    loggedIn: () => false,
    cloudLinks: async () => {
      asked++
      return []
    },
    persist: () => undefined,
  }
  const m = new WorkspaceManager(deps)
  await (m as unknown as { syncCloudLinks: () => Promise<void> }).syncCloudLinks.call(m)
  assert.equal(asked, 0)
})

test('연결 목록을 타이머로 다시 읽지 않는다', () => {
  // 연결은 거의 바뀌지 않는다. 타이머를 두면 앱이 켜져 있는 내내 서버를
  // 두드리게 되고, 그 비용은 사용자 수만큼 곱해진다. 갱신 지점은 셋으로 족하다:
  // 리컨사일(로그인·설정 변경·[다시 연결]), 화면을 열 때, [새로고침].
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'workspace-manager.ts'), 'utf-8')
  assert.ok(
    !/setInterval/.test(src),
    'workspace-manager 에 타이머가 생겼다 — 연결 목록 폴링이 되살아났는지 확인하라',
  )
})

test('화면을 열면 서버와 맞춘다', () => {
  // 웹에서 붙이고 커넥터를 열었을 때 옛 목록이 떠 있으면, 그게 곧
  // "동기화가 안 된다" 로 읽힌다.
  const ui = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'src', 'views', 'SyncSettings.tsx'),
    'utf-8',
  )
  assert.ok(ui.includes('xgen.workspace.refresh()'), '열 때 갱신이 빠졌다')
  assert.ok(ui.includes('xgen.workspace.refreshAgents()'), '[새로고침] 버튼이 빠졌다')
})
