/** SessionStore — multi-session runtime: 전환해도 진행 중 스트림/전사가 유지된다. */
import assert from 'assert'
import { test } from 'node:test'
import {
  SessionStore,
  isKeepable,
  openSessions,
  agentSessions,
  sessionDotState,
  CONNECTOR_SESSION_IDLE_MS,
  type SessionState,
  type SessionTransport,
} from '../src/renderer/src/session-store'
import type { Agent, ChatEvent, HistoryAttachment } from '@dex/protocol'
import type { BrowserSelectionResult } from '@dex/protocol/browser'

function agent(workflowId: string, name = workflowId): Agent {
  return {
    id: 1,
    workflowId,
    workflowName: name,
    nodeCount: 1,
    isShared: false,
    isDeployed: false,
    isCompleted: true,
    workflowType: 'canvas',
    description: '',
    username: '',
    fullName: '',
    createdAt: '',
    updatedAt: '',
  }
}

interface FakeStream {
  interactionId: string
  input: unknown
  browserSelections?: BrowserSelectionResult[]
  onEvent: (e: ChatEvent) => void
  cancelled: boolean
}

function makeStore(
  history: Record<string, Array<{ input: string; output: string; attachments?: HistoryAttachment[] }>> = {},
) {
  const streams: FakeStream[] = []
  let historyCalls = 0
  const transport: SessionTransport = {
    stream(req, onEvent, context) {
      const s: FakeStream = {
        interactionId: req.interactionId,
        input: req.input,
        browserSelections: context?.browserSelections,
        onEvent,
        cancelled: false,
      }
      streams.push(s)
      return { cancel: () => { s.cancelled = true } }
    },
    async historyTurns(_w, interactionId) {
      historyCalls++
      return history[interactionId] ?? []
    },
  }
  let clock = 1000
  const store = new SessionStore(transport, () => clock++)
  return { store, streams, historyCalls: () => historyCalls }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function browserSelection(): BrowserSelectionResult {
  return {
    id: 'sel-1',
    workflowId: 'A',
    pageId: 'page-1',
    generation: 2,
    kind: 'element',
    title: 'Example',
    url: 'https://example.com/page',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    elements: [
      {
        tag: 'button',
        role: 'button',
        name: '저장',
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    image: {
      dataUrl: 'data:image/png;base64,AAAA',
      name: 'browser-selection-sel-1.png',
      mime: 'image/png',
      size: 3,
      width: 100,
      height: 40,
    },
  }
}

test('openNew 는 세션을 만들고 활성화한다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  assert.equal(store.activeKey, key)
  assert.equal(store.get(key)?.agent.workflowId, 'A')
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('같은 에이전트로 새 대화를 다시 열면 빈 세션을 재사용한다', () => {
  const { store } = makeStore()
  const k1 = store.openNew(agent('A'))
  const k2 = store.openNew(agent('A'))
  assert.equal(k1, k2, '빈 세션 재사용')
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('빈 세션은 다른 세션으로 전환할 때 회수된다', () => {
  const { store } = makeStore()
  const kA = store.openNew(agent('A'))
  const kB = store.openNew(agent('B'))
  assert.equal(store.get(kA), null, '빈 A 는 GC')
  assert.equal(store.activeKey, kB)
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('send 는 사용자·assistant 메시지를 넣고 스트림을 연다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  const s = store.get(k)!
  assert.equal(s.streaming, true)
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(s.messages[0].text, '질문')
  assert.equal(streams.length, 1)
})

test('send 는 붙인 이미지 여러 장을 멀티모달 입력과 사용자 메시지에 보존한다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  const images = [
    { dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png', size: 3 },
    { dataUrl: 'data:image/jpeg;base64,BBBB', name: 'b.jpg', mime: 'image/jpeg', size: 3 },
  ]
  store.send(k, '두 그림을 비교해줘', null, images)

  assert.equal(store.get(k)!.messages[0].images?.length, 2)
  assert.deepEqual(streams[0].input, [
    { type: 'text', text: '두 그림을 비교해줘' },
    { type: 'image_url', image_url: { url: images[0].dataUrl } },
    { type: 'image_url', image_url: { url: images[1].dataUrl } },
  ])
})

test('브라우저 선택 스냅샷을 전송 수명과 사용자 메시지에 함께 보존한다', () => {
  const { store, streams } = makeStore()
  const key = store.openNew(agent('A'))
  const selection = browserSelection()
  store.send(
    key,
    '이 버튼은 뭐야?',
    null,
    [
      {
        dataUrl: selection.image.dataUrl,
        name: selection.image.name,
        mime: selection.image.mime,
        size: selection.image.size,
      },
    ],
    [selection],
  )

  assert.equal(streams[0].browserSelections?.[0], selection)
  assert.deepEqual(store.get(key)!.messages[0].browserSelections, [
    {
      id: 'sel-1',
      title: 'Example',
      url: 'https://example.com/page',
      kind: 'element',
      elementCount: 1,
    },
  ])
})

test('이미지만 있는 메시지도 전송하고 허용하지 않은 data URL 은 버린다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, '', null, [
    { dataUrl: 'data:image/webp;base64,AAAA', name: 'ok.webp', mime: 'image/webp', size: 3 },
    { dataUrl: 'data:image/svg+xml;base64,BBBB', name: 'bad.svg', mime: 'image/svg+xml', size: 3 },
  ])

  assert.equal(streams.length, 1)
  assert.equal(store.get(k)!.messages[0].text, '')
  assert.equal(store.get(k)!.messages[0].images?.length, 1)
  assert.deepEqual(streams[0].input, [
    { type: 'text', text: '' },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } },
  ])
})

test('XGeny 이미지는 에이전트 workspace 업로드 후 참조로 실행한다', async () => {
  const streams: FakeStream[] = []
  const uploads: Array<{ workflowId: string; interactionId: string; name: string; bytes: Uint8Array }> = []
  const transport: SessionTransport = {
    stream(req, onEvent) {
      const stream: FakeStream = {
        interactionId: req.interactionId,
        input: req.input,
        onEvent,
        cancelled: false,
      }
      streams.push(stream)
      return { cancel: () => { stream.cancelled = true } }
    },
    async uploadWorkspaceImage(request) {
      uploads.push(request)
      return {
        workspace_path: `uploads/${request.interactionId}/${request.name}`,
        size: request.bytes.byteLength,
        sha256: 'abc123',
      }
    },
    async historyTurns() { return [] },
  }
  const store = new SessionStore(transport, () => 1234)
  const xgeny = { ...agent('geny'), hasAgentGeny: true }
  const key = store.openNew(xgeny)

  store.send(key, '이미지를 설명해줘', null, [
    { dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png', size: 3 },
  ])
  assert.equal(streams.length, 0, 'workspace commit 전에는 실행하지 않음')
  await flush()

  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].workflowId, 'geny')
  assert.equal(streams.length, 1)
  assert.deepEqual(streams[0].input, {
    input_str: '이미지를 설명해줘',
    attachments: [{
      kind: 'image',
      attachment_id: `conn-${key}-1`,
      name: 'a.png',
      mime_type: 'image/png',
      size: 3,
      sha256: 'abc123',
      workspace_path: `uploads/${key}/a.png`,
    }],
  })
})

test('스트림 이벤트가 텍스트·도구·출처를 누적하고 end 에서 멈춘다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  streams[0].onEvent({ kind: 'text', content: 'Hel' })
  streams[0].onEvent({ kind: 'text', content: 'lo' })
  streams[0].onEvent({
    kind: 'tool',
    event: { eventType: 'tool_result', toolName: 'X', citations: [{ fileName: 'a.pdf', pageNumber: 1 }] },
  })
  streams[0].onEvent({ kind: 'end' })
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.text, 'Hello')
  assert.equal(last.tools?.length, 1)
  assert.equal(last.citations?.length, 1)
  assert.equal(last.streaming, false)
  assert.equal(store.get(k)!.streaming, false)
})

test('다른 세션으로 전환해도 진행 중 스트림이 죽지 않고 백그라운드로 누적된다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  // A 가 스트리밍 중일 때 B 로 전환
  const kB = store.openNew(agent('B'))
  assert.equal(streams[0].cancelled, false, 'A 스트림은 취소되지 않음')
  assert.equal(store.activeKey, kB)
  // 포그라운드가 아닌 A 로 이벤트가 계속 흐른다
  streams[0].onEvent({ kind: 'text', content: '백그라운드' })
  streams[0].onEvent({ kind: 'end' })
  const a = store.get(kA)!
  assert.equal(a.messages.at(-1)!.text, '백그라운드')
  assert.equal(a.streaming, false)
  assert.equal(store.activeKey, kB, '활성 세션은 여전히 B')
})

test('setActive 로 되돌아오면 그 전사가 그대로 보인다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  streams[0].onEvent({ kind: 'text', content: '진행' })
  const kB = store.openNew(agent('B'))
  store.send(kB, 'q2')
  store.setActive(kA)
  assert.equal(store.activeKey, kA)
  assert.equal(store.get(kA)!.messages.at(-1)!.text, '진행')
})

test('stop 은 스트림을 취소하고 스트리밍 상태를 내린다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  store.stop(k)
  assert.equal(streams[0].cancelled, true)
  assert.equal(store.get(k)!.streaming, false)
  assert.equal(store.get(k)!.messages.at(-1)!.streaming, false)
})

test('endChat 은 스트림을 끊고 세션을 지우며 다음 세션을 활성화한다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  const kB = store.openNew(agent('B'))
  store.send(kB, 'b')
  store.endChat(kB)
  assert.equal(streams[1].cancelled, true)
  assert.equal(store.get(kB), null)
  assert.equal(store.activeKey, kA, '남은 세션 중 최신이 활성')
  store.endChat(kA)
  assert.equal(store.activeKey, null)
})

test('openResume 는 히스토리를 불러오고, 이미 열려 있으면 다시 불러오지 않는다', async () => {
  const { store, historyCalls } = makeStore({ 'iid-1': [{ input: 'u', output: 'a' }] })
  store.openResume(agent('A'), 'iid-1')
  assert.equal(store.get('iid-1')!.loadingHistory, true)
  await flush()
  const s = store.get('iid-1')!
  assert.equal(s.loadingHistory, false)
  assert.deepEqual(s.messages.map((m) => m.text), ['u', 'a'])
  // 다시 열기 → 포커스만, 히스토리 재호출 없음
  store.setActive(null)
  store.openResume(agent('A'), 'iid-1')
  await flush()
  assert.equal(historyCalls(), 1, '히스토리는 한 번만 로드')
})

test('openResume 는 XGeny 이력 이미지를 복원하고 세션 종료 때 미리보기 URL을 해제한다', async () => {
  const restored: HistoryAttachment[] = []
  const released: string[] = []
  const attachment: HistoryAttachment = {
    id: 7,
    name: 'red-drop.png',
    size: 4,
    contentType: 'image/png',
    type: 'picture',
    path: 'geny-workspace:uploads/users/42/iid-image/att-1/red-drop.png',
    bucket: 'geny-workspace',
  }
  const transport: SessionTransport = {
    stream() {
      return { cancel() {} }
    },
    async historyTurns() {
      return [{ input: '이 그림을 설명해줘', output: '빨간 그림입니다.', attachments: [attachment] }]
    },
    async historyImage(_workflowId, item) {
      restored.push(item)
      return {
        dataUrl: 'blob:history/red-drop',
        name: item.name,
        mime: item.contentType,
        size: item.size,
      }
    },
    releaseHistoryImage(url) {
      released.push(url)
    },
  }
  const store = new SessionStore(transport, () => 1000)
  store.openResume(agent('geny'), 'iid-image')
  await flush()

  const user = store.get('iid-image')!.messages[0]
  assert.equal(restored.length, 1)
  assert.equal(user.text, '이 그림을 설명해줘')
  assert.deepEqual(user.images, [
    {
      dataUrl: 'blob:history/red-drop',
      name: 'red-drop.png',
      mime: 'image/png',
      size: 4,
    },
  ])

  store.endChat('iid-image')
  assert.deepEqual(released, ['blob:history/red-drop'])
})

test('이력 이미지 하나를 내려받지 못해도 대화 본문은 복원한다', async () => {
  const transport: SessionTransport = {
    stream() {
      return { cancel() {} }
    },
    async historyTurns() {
      return [
        {
          input: '질문',
          output: '답변',
          attachments: [
            {
              name: 'missing.png',
              size: 10,
              contentType: 'image/png',
              type: 'picture',
              path: 'geny-workspace:uploads/users/42/iid-missing/a/missing.png',
              bucket: 'geny-workspace',
            },
          ],
        },
      ]
    },
    async historyImage() {
      throw new Error('404')
    },
  }
  const store = new SessionStore(transport, () => 1000)
  store.openResume(agent('geny'), 'iid-missing')
  await flush()
  assert.deepEqual(
    store.get('iid-missing')!.messages.map((message) => message.text),
    ['질문', '답변'],
  )
})

test('진행 중 턴이 히스토리 로드를 덮어쓰지 않는다', async () => {
  const { store, streams } = makeStore({ 'iid-2': [{ input: 'old', output: 'answer' }] })
  store.openResume(agent('A'), 'iid-2')
  // 히스토리 도착 전에 새 턴 시작
  store.send('iid-2', '새질문')
  streams[0].onEvent({ kind: 'text', content: '새답변' })
  await flush()
  const s = store.get('iid-2')!
  // 히스토리(old/answer)로 덮지 않고 라이브 전사를 유지
  assert.ok(s.messages.some((m) => m.text === '새질문'))
  assert.ok(!s.messages.some((m) => m.text === 'old'))
})

test('reset 은 모든 스트림을 끊고 비운다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  const kB = store.openNew(agent('B'))
  store.send(kB, 'b')
  store.reset()
  assert.equal(streams[0].cancelled, true)
  assert.equal(streams[1].cancelled, true)
  assert.equal(store.getSnapshot().sessions.length, 0)
  assert.equal(store.activeKey, null)
})

test('getSnapshot 은 변화가 없으면 같은 참조를 돌려준다', () => {
  const { store } = makeStore()
  store.openNew(agent('A'))
  const snap1 = store.getSnapshot()
  const snap2 = store.getSnapshot()
  assert.equal(snap1, snap2, '동일 참조 (useSyncExternalStore 요건)')
})

test('unseen: 백그라운드에서 끝난 턴은 unseen 이 서고, 포그라운드에서 끝나면 안 선다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  const kB = store.openNew(agent('B')) // A 는 백그라운드로
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true, '백그라운드에서 끝나면 unseen')
  assert.equal(store.get(kB)!.unseen, false, '지금 보고 있는 세션은 아직 아무 턴도 안 끝남')

  store.send(kB, 'q2')
  streams[1].onEvent({ kind: 'end' })
  assert.equal(store.get(kB)!.unseen, false, '포그라운드에서 끝나면 unseen 이 안 선다')
})

test('unseen: 오류로 끝나도 백그라운드면 선다(빨간 점 재료)', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'error', detail: '실패' })
  const a = store.get(kA)!
  assert.equal(a.unseen, true)
  assert.equal(a.error, '실패')
})

test('unseen: setActive 로 그 탭을 보면 꺼진다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true)
  store.setActive(kA)
  assert.equal(store.get(kA)!.unseen, false)
})

test('unseen: 새 턴을 보내면 이전 unseen 은 초기화된다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q1')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true)
  store.send(kA, 'q2') // 백그라운드에서 바로 다음 턴 시작
  assert.equal(store.get(kA)!.unseen, false, '진행 중인 턴은 unseen 결과가 아니다(스트리밍 점이 대신 뜬다)')
})

test('helpers: isKeepable / openSessions / agentSessions', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  streams[0].onEvent({ kind: 'end' })
  const kB = store.openNew(agent('B')) // empty
  const all = store.getSnapshot().sessions
  assert.equal(isKeepable(store.get(kA)!), true)
  assert.equal(isKeepable(store.get(kB)!), false, '빈 세션은 keepable 아님')
  assert.equal(openSessions(all).length, 1)
  assert.equal(agentSessions(all, 'A').length, 1)
  assert.equal(agentSessions(all, 'B').length, 0)
})

// ── 상태 점 색(진행 중인 대화): 초록=활성 / 빨강=에러 / 회색=idle(삭제 예정) ──
function mkSession(over: Partial<SessionState>): SessionState {
  return {
    key: 'k',
    agent: agent('wf'),
    interactionId: 'i',
    resume: false,
    loadingHistory: false,
    historyLoaded: true,
    messages: [],
    streaming: false,
    error: null,
    unseen: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

test('sessionDotState: 에러가 있으면 빨강(error) — 최우선', () => {
  const now = 1_000_000
  // idle 임계를 넘겼어도, 스트리밍 중이어도 에러가 이긴다.
  assert.equal(sessionDotState(mkSession({ error: 'boom', updatedAt: 0 }), now), 'error')
  assert.equal(sessionDotState(mkSession({ error: 'boom', streaming: true, updatedAt: now }), now), 'error')
})

test('sessionDotState: 스트리밍/최근 활동은 초록(active)', () => {
  const now = 1_000_000
  assert.equal(sessionDotState(mkSession({ streaming: true, updatedAt: 0 }), now), 'active')
  assert.equal(sessionDotState(mkSession({ updatedAt: now }), now), 'active')
  // 임계 직전(1분 여유)도 active
  assert.equal(sessionDotState(mkSession({ updatedAt: now - CONNECTOR_SESSION_IDLE_MS + 60_000 }), now), 'active')
})

test('sessionDotState: idle 임계를 넘기면 회색(idle) — 삭제 예정', () => {
  const now = 100 * 60_000
  assert.equal(sessionDotState(mkSession({ updatedAt: now - CONNECTOR_SESSION_IDLE_MS }), now), 'idle')
  assert.equal(sessionDotState(mkSession({ updatedAt: 0 }), now), 'idle')
})

test('대화 소켓 push — 트리거 턴이 실시간으로 세션에 붙는다 (dedup·source 필터)', () => {
  const watched: string[] = []
  const unwatched: string[] = []
  const store = new SessionStore({
    stream: () => ({ cancel: () => undefined }),
    historyTurns: async () => [],
    watchConversation: (_wf: string, _name: string, iid: string) => watched.push(iid),
    unwatchConversation: (iid: string) => unwatched.push(iid),
  } as unknown as SessionTransport)
  const key = store.openNew(agent('wf-1', 'Agent'))
  assert.deepEqual(watched, [key], '세션이 열리면 대화 소켓을 감시해야 한다')

  const turn = {
    interactionId: key,
    ioId: 11,
    input: '<agent_trigger:agent source="worker-1">보고</agent_trigger:agent>',
    output: '서브에이전트 결과를 정리했습니다.',
    source: 'subagent_report',
  }
  store.applyExternalTurn(turn)
  let msgs = store.getSnapshot().sessions.find((s) => s.key === key)!.messages
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'user')
  assert.match(msgs[0].text, /agent_trigger:agent/)
  assert.equal(msgs[1].role, 'assistant')

  // 같은 io_id 재수신(하트비트 폴백 중복) — 멱등.
  store.applyExternalTurn(turn)
  msgs = store.getSnapshot().sessions.find((s) => s.key === key)!.messages
  assert.equal(msgs.length, 2, '중복 push 가 두 번 붙었다')

  // 자기 사용자 턴 push 는 스트림이 이미 그렸다 — 무시.
  store.applyExternalTurn({ ...turn, ioId: 12, source: 'user' })
  msgs = store.getSnapshot().sessions.find((s) => s.key === key)!.messages
  assert.equal(msgs.length, 2)

  // 미완결(output 없음)은 완결 push 를 기다린다.
  store.applyExternalTurn({ ...turn, ioId: 13, output: '' })
  assert.equal(store.getSnapshot().sessions.find((s) => s.key === key)!.messages.length, 2)

  store.endChat(key)
  assert.ok(unwatched.includes(key), '세션이 닫히면 감시를 내려야 한다')
})
