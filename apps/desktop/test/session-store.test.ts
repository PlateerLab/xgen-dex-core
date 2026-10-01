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
import type { Agent, ChatEvent, HistoryAttachment, HistoryFlowItem } from '@dex/protocol'
import { INTERRUPTED_NOTE } from '@dex/protocol'
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
  /** 서버까지 닿은 [정지] — abort(cancelled)와 **다른 일**이다. */
  stopped: boolean
}

function makeStore(
  history: Record<string, Array<{ input: string; output: string; ioId?: number; attachments?: HistoryAttachment[]; process?: HistoryFlowItem[] }>> = {},
  running: Record<string, boolean> = {},
) {
  const streams: FakeStream[] = []
  const stopCalls: string[] = []
  let historyCalls = 0
  const transport: SessionTransport = {
    stream(req, onEvent, context) {
      const s: FakeStream = {
        interactionId: req.interactionId,
        input: req.input,
        browserSelections: context?.browserSelections,
        onEvent,
        cancelled: false,
        stopped: false,
      }
      streams.push(s)
      return {
        cancel: () => { s.cancelled = true },
        stop: async (interactionId: string) => {
          s.cancelled = true
          s.stopped = true
          stopCalls.push(interactionId)
        },
      }
    },
    async historyTurns(_w, interactionId) {
      historyCalls++
      return history[interactionId] ?? []
    },
    async historySnapshot(_w, interactionId) {
      historyCalls++
      return { turns: history[interactionId] ?? [], running: running[interactionId] === true }
    },
    async stopChat(interactionId) {
      stopCalls.push(interactionId)
    },
  }
  let clock = 1000
  const store = new SessionStore(transport, () => clock++)
  return { store, streams, stopCalls, historyCalls: () => historyCalls }
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

test('Geny 이미지는 에이전트 workspace 업로드 후 참조로 실행한다', async () => {
  const streams: FakeStream[] = []
  const uploads: Array<{ attachmentId: string; workflowId: string; interactionId: string; name: string; bytes: Uint8Array }> = []
  const transport: SessionTransport = {
    stream(req, onEvent) {
      const stream: FakeStream = {
        interactionId: req.interactionId,
        input: req.input,
        onEvent,
        cancelled: false,
        stopped: false,
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
  const geny = { ...agent('geny'), hasAgentGeny: true }
  const key = store.openNew(geny)

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
      attachment_id: uploads[0].attachmentId,
      name: 'a.png',
      mime_type: 'image/png',
      size: 3,
      sha256: 'abc123',
      workspace_path: `uploads/${key}/a.png`,
    }],
  })
})

test('Geny 일반 파일은 이미지로 변환하지 않고 workspace 참조로 실행한다', async () => {
  const streams: FakeStream[] = []
  let uploadedId = ''
  const transport: SessionTransport = {
    stream(req, onEvent) {
      const stream: FakeStream = { interactionId: req.interactionId, input: req.input, onEvent, cancelled: false, stopped: false }
      streams.push(stream)
      return { cancel: () => { stream.cancelled = true } }
    },
    async uploadWorkspaceAttachment(request) {
      uploadedId = request.attachmentId;
      return { workspace_path: `uploads/${request.interactionId}/${request.name}`, size: request.bytes.byteLength }
    },
    async historyTurns() { return [] },
  }
  const store = new SessionStore(transport, () => 1234)
  const key = store.openNew({ ...agent('geny'), hasAgentGeny: true })

  store.send(key, '이 파일을 읽어줘', null, [
    { dataUrl: 'data:application/json;base64,e30=', name: 'data.json', mime: 'application/json', size: 2, kind: 'file' },
  ])
  await flush()

  assert.deepEqual(streams[0].input, {
    input_str: '이 파일을 읽어줘',
    attachments: [{
      kind: 'file', attachment_id: uploadedId, name: 'data.json',
      mime_type: 'application/json', size: 2, sha256: undefined,
      workspace_path: `uploads/${key}/data.json`,
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

test('한 글자도 못 받고 중단하면 빈 말풍선이 아니라 중단 사실이 남는다', () => {
  // 실제 신고: [정지] 를 누르면 답변이 **빈 칸**으로 남아 아무 일도 없었던 것처럼
  // 보였다. 중단은 실패가 아니지만 사용자에게는 보여야 하는 사건이다.
  const { store } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  store.stop(k)
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.text, INTERRUPTED_NOTE)
  assert.equal(last.interrupted, true)
  assert.ok(!last.error, '중단은 실패가 아니다 — 오류로 칠하지 않는다')
})

test('받다 만 글이 있으면 그 글을 지우지 않고 중단 표시만 얹는다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  streams[0].onEvent({ kind: 'text', content: '여기까지 답하다' })
  store.stop(k)
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.text, '여기까지 답하다', '받은 답을 중단 문구로 덮어쓰면 안 된다')
  assert.equal(last.interrupted, true)
})

test('실패는 원문이 아니라 코드·제목으로 남는다', () => {
  // `stream /api/... → 502` 를 본문에 그대로 넣던 자리.
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  streams[0].onEvent({
    kind: 'error',
    detail: 'stream /api/agentflow/execute/based-id/stream → 502',
    info: {
      code: 'XGEN-921',
      title: '서버에 연결하지 못했습니다.',
      hint: '1~2분 뒤에 다시 시도해 주세요.',
      detail: 'stream /api/agentflow/execute/based-id/stream → 502',
      retryable: true,
    },
  })
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.error, true)
  assert.equal(last.errorInfo?.code, 'XGEN-921')
  assert.ok(!last.text.includes('/api/'), '원문이 본문에 새어 나왔다')
  assert.equal(store.get(k)!.error, '서버에 연결하지 못했습니다.', '세션 요약도 사용자 문구여야 한다')
})

test('info 없는 구형 error 이벤트도 코드가 붙는다 (서버·구버전 호환)', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  streams[0].onEvent({ kind: 'error', detail: '[ERROR510: 문서 검색 중 오류가 발생했습니다.]' })
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.errorInfo?.code, 'XGEN-510')
  assert.equal(last.errorInfo?.title, '문서 검색 중 오류가 발생했습니다.')
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

test('openResume 는 서버가 되살린 작업 과정을 답에 붙인다 — 이 PC 기록이 없어도', async () => {
  const process: HistoryFlowItem[] = [
    { kind: 'text', text: '읽습니다.\n', at: 1000 },
    { kind: 'tool', at: 1500, event: { eventType: 'tool_call', toolName: 'Read', toolInput: { file_path: 'a.txt' }, toolUseId: 'u1' } },
    { kind: 'tool', at: 1620, event: { eventType: 'tool_result', toolName: 'Read', result: 'ok', durationMs: 120, toolUseId: 'u1' } },
    { kind: 'text', text: '\n\n끝.', at: 1620 },
  ]
  const { store } = makeStore({ 'iid-p': [{ input: 'u', output: '읽습니다.\n\n끝.', ioId: 9, process }] })
  store.openResume(agent('A'), 'iid-p')
  await flush()
  const answer = store.get('iid-p')!.messages[1]
  assert.equal(answer.executionIoId, 9)
  assert.equal(answer.flow?.length, 4, '서버 과정이 순서로 붙는다')
  assert.equal(answer.tools?.length, 2, '도구 사건도 함께')
  assert.equal(answer.startedAt, 1000)
  assert.equal(answer.lastEventAt, 1620)
})

test('openResume 는 Geny 이력 이미지를 복원하고 세션 종료 때 미리보기 URL을 해제한다', async () => {
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
  remote: false,
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

// ── 실행은 연결이 아니라 대화에 매여 있다 ────────────────────────────────
//
// 서버는 더 이상 연결 끊김을 취소로 읽지 않는다 — 그렇게 읽던 시절엔 화면
// 잠금·절전·기기 이동이 곧 실행 중단이었고, 사용자는 [정지] 를 누른 적이
// 없었다. 그 대신 두 가지가 클라이언트의 몫이 됐다: 정지를 **대화**에 전하는
// 것, 그리고 다른 곳에서 도는 턴을 **그대로 보여 주는** 것.

test('[정지] 는 스트림을 끊는 것으로 그치지 않고 서버 실행까지 멈춘다', async () => {
  const { store, streams, stopCalls } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, '안녕')
  await flush()
  assert.equal(streams.length, 1)

  store.stop(key)
  assert.equal(streams[0].cancelled, true)
  await flush()
  // abort 만 하면 버려진 턴이 끝까지 돌아 이 대화에 답을 적는다.
  assert.equal(streams[0].stopped, true)
  assert.deepEqual(stopCalls, [key])
  assert.equal(store.get(key)?.streaming, false)
})

test('다른 곳에서 도는 턴은 이어보기로 열 때 [진행 중] 으로 복원된다', async () => {
  const { store } = makeStore(
    { 'int-live': [{ input: '앞선 질문', output: '앞선 답' }] },
    { 'int-live': true },
  )
  store.openResume(agent('A'), 'int-live')
  await flush()

  const s = store.get('int-live')
  assert.equal(s?.remote, true)
  assert.equal(s?.messages.length, 2)

  // 그 위에 새 턴을 얹으면 같은 대화에서 두 실행이 겹친다 — 막아야 한다.
  store.send('int-live', '겹쳐 보내기')
  await flush()
  assert.equal(store.get('int-live')?.messages.length, 2)

  // 이 창이 스트림을 쥐고 있지 않아도 [정지] 는 대화를 향해 닿는다.
  store.stop('int-live')
  assert.equal(store.get('int-live')?.remote, true)
  await flush()
  assert.equal(store.get('int-live')?.remote, false)
})

test('도는 턴이 없으면 이어보기는 평소처럼 열린다', async () => {
  const { store } = makeStore({ 'int-done': [{ input: 'q', output: 'a' }] })
  store.openResume(agent('A'), 'int-done')
  await flush()
  assert.equal(store.get('int-done')?.remote, false)
  store.send('int-done', '이어서')
  await flush()
  assert.equal(store.get('int-done')?.streaming, true)
})

test('대화 소켓이 [진행 중] 을 켜고, 완결 턴이 도착하면 끈다', async () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))

  // 다른 기기에서 시작한 턴 — 소켓의 구독 확립이 알려 준다.
  store.setRemoteRunning(key, true)
  assert.equal(store.get(key)?.remote, true)
  store.send(key, '겹쳐 보내기')
  await flush()
  assert.equal(store.get(key)?.messages.length, 0, '도는 턴 위에 새 턴이 얹혔다')

  // 그 턴이 끝나면 답이 완결 push 로 도착한다 — 이 창은 그린 적이 없는 턴이다.
  store.applyExternalTurn({
    interactionId: key,
    ioId: 7,
    input: '웹에서 보낸 질문',
    output: '그 답',
    source: 'user',
  })
  const s = store.get(key)
  assert.equal(s?.remote, false)
  assert.deepEqual(s?.messages.map((m) => m.text), ['웹에서 보낸 질문', '그 답'])

  // 이제 다시 보낼 수 있다.
  store.send(key, '이어서')
  await flush()
  assert.equal(store.get(key)?.streaming, true)
})

// ── 다른 화면에서 하는 대화가 이 창에도 보인다 ──────────────────────
//
// 무엇이 없었나: 같은 대화를 앱과 웹에 나란히 열어 두고 한 쪽에서 말을 걸면,
// 다른 쪽에는 **턴이 끝날 때까지 아무것도** 나타나지 않았다. 상대가 무엇을
// 물었는지조차 완결 뒤에야 알 수 있었고, 그것도 최대 10초 뒤였다(서버가
// 하트비트마다 DB 를 다시 읽는 것이 유일한 길이었다).

test('다른 화면의 질문이 곧바로 보이고, 답이 토큰마다 자란다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))

  store.applyPeerEvent({ kind: 'started', interactionId: key, input: '웹에서 보낸 질문' })
  let s = store.get(key)
  assert.deepEqual(s?.messages.map((m) => m.text), ['웹에서 보낸 질문', ''])
  assert.equal(s?.remote, true, '다른 곳에서 도는 턴이다')

  store.applyPeerEvent({
    kind: 'exec', interactionId: key,
    event: 'message', data: { type: 'data', content: '삼성' },
  })
  store.applyPeerEvent({
    kind: 'exec', interactionId: key,
    event: 'message', data: { type: 'data', content: '전자' },
  })
  s = store.get(key)
  assert.equal(s?.messages[1].text, '삼성전자', '토큰이 이어붙어야 한다')
  assert.equal(s?.messages[1].streaming, true)
})

test('다른 화면의 턴이 끝나면 완결 본문으로 덮어쓴다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.applyPeerEvent({ kind: 'started', interactionId: key, input: '질문' })
  store.applyPeerEvent({
    kind: 'exec', interactionId: key,
    event: 'message', data: { type: 'data', content: '조각만' },
  })
  // 중간에 몇 조각을 놓쳤어도 마지막은 맞아야 한다 — 종료 프레임이 완결 본문을
  // 통째로 싣고 온다.
  store.applyPeerEvent({ kind: 'ended', interactionId: key, output: '완전한 답' })
  const s = store.get(key)
  assert.equal(s?.messages[1].text, '완전한 답')
  assert.ok(!s?.messages[1].streaming, '커서가 남으면 안 된다')
  assert.equal(s?.remote, false)
})

// ── 어디서 열어도 같은 작업 과정 (2026-10-01 사용자 보고) ───────────────
//
// 다른 화면의 턴은 글만 받고 도구는 흘렸다 — 웹이 도구를 24번 부르며 도는 동안 이 창에는
// 글 몇 줄만 보였고, 끝난 뒤에는 작업 과정이 통째로 없었다. 첨부를 함께 보낸 질문은 JSON 으로 보였다.

test('다른 화면의 도구도 작업 과정에 쌓이고, 끝난 뒤에도 남는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.applyPeerEvent({
    kind: 'started', interactionId: key, input: 'LLM 이 안 돼',
    attachments: [{ name: 'image.png', kind: 'image', mimeType: 'image/png', size: 5, workspacePath: 'uploads/u/x.png' }],
  })
  store.applyPeerEvent({ kind: 'exec', interactionId: key, event: 'message', data: { type: 'data', content: '로그를 봅니다.' } })
  store.applyPeerEvent({
    kind: 'exec', interactionId: key, event: 'tool',
    data: { event_type: 'tool_call', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'ls' } },
  })
  store.applyPeerEvent({
    kind: 'exec', interactionId: key, event: 'tool',
    data: { event_type: 'tool_result', tool_name: 'Bash', tool_use_id: 'u1', result: 'ok', duration_ms: 30 },
  })
  let s = store.get(key)!
  assert.equal(s.messages[0].images?.[0]?.name, 'image.png', '질문의 첨부가 보인다')
  assert.equal(s.messages[0].images?.[0]?.workspacePath, 'uploads/u/x.png')
  assert.deepEqual(s.messages[1].flow?.map((f) => f.kind), ['text', 'tool', 'tool'])
  assert.equal(s.messages[1].tools?.length, 1, '한 호출은 한 건')

  store.applyPeerEvent({ kind: 'ended', interactionId: key, ioId: 3, input: 'LLM 이 안 돼', output: '로그를 봅니다. 원인은 X' })
  s = store.get(key)!
  assert.deepEqual(s.messages.map((m) => m.text), ['LLM 이 안 돼', '로그를 봅니다. 원인은 X'])
  assert.equal(s.messages[0].images?.[0]?.name, 'image.png', '완결 뒤에도 첨부가 남는다')
  assert.deepEqual(
    s.messages[1].flow?.map((f) => (f.kind === 'text' ? f.text : f.event.eventType)),
    ['로그를 봅니다.', 'tool_call', 'tool_result', ' 원인은 X'],
    '작업 과정이 남고, 받지 못한 끝은 완결 본문으로 채운다',
  )
})

test('도는 중에 연 대화 — 진행분의 도구까지 되살린다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.setRemoteRunning(key, true, {
    text: '확인중다음',
    textTotal: 5,
    startedAt: 100,
    events: [
      { event: 'tool', data: { event_type: 'tool_call', tool_name: 'Read', tool_use_id: 'r' }, text_at: 3, at: 150 },
      { event: 'tool', data: { event_type: 'tool_result', tool_name: 'Read', tool_use_id: 'r', result: 'x' }, text_at: 3, at: 160 },
    ],
  })
  const m = store.get(key)!.messages[0]
  assert.equal(m.remotePartial, true)
  assert.deepEqual(m.flow?.map((f) => (f.kind === 'text' ? f.text : 'T')), ['확인중', 'T', 'T', '다음'])
  assert.equal(m.tools?.length, 1)
  assert.equal(m.startedAt, 100)
})

test('시작을 못 받은 다른 화면의 턴 — 받을 자리를 세워 답이 두 번 서지 않는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.applyPeerEvent({
    kind: 'exec', interactionId: key, event: 'tool',
    data: { event_type: 'tool_call', tool_name: 'Bash', tool_use_id: 'u' },
  })
  assert.equal(store.get(key)?.messages[0].remotePartial, true)
  store.applyExternalTurn({ interactionId: key, ioId: 4, input: '질문', output: '답', source: 'user' })
  assert.deepEqual(store.get(key)!.messages.map((m) => m.text), ['질문', '답'])
})

test('옛 서버가 JSON 으로 실어 보낸 질문도 본문만 보인다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.applyPeerEvent({
    kind: 'started', interactionId: key,
    input: JSON.stringify({ input_str: '이거 봐 줘', attachments: [{ name: 'a.png' }] }, null, 2),
  })
  assert.equal(store.get(key)?.messages[0].text, '이거 봐 줘')
})

test('내가 돌리는 턴에는 전파가 끼어들지 않는다', async () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, '내 턴')
  await flush()
  const before = store.get(key)?.messages.length
  // 서버가 표식(origin_id)으로 걸러 주지만, 화면이 그 사실에만 기대면 표식이
  // 빠진 날 조용히 글이 두 번 그려진다.
  store.applyPeerEvent({ kind: 'started', interactionId: key, input: '남의 질문' })
  store.applyPeerEvent({
    kind: 'exec', interactionId: key,
    event: 'message', data: { type: 'data', content: '남의 답' },
  })
  assert.equal(store.get(key)?.messages.length, before, '내 턴 위에 남의 턴이 얹혔다')
})

test('전파에 구멍이 나도 마지막은 맞는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.applyPeerEvent({ kind: 'started', interactionId: key, input: '질문' })
  store.applyPeerEvent({ kind: 'gap', interactionId: key })
  store.applyPeerEvent({ kind: 'ended', interactionId: key, output: '완결' })
  assert.equal(store.get(key)?.messages[1].text, '완결')
})

// ── 다른 곳의 턴은 한 번만 그린다 (2026-09-29 사용자 보고) ─────────────
//
// 서버는 완결 행(message)을 **먼저**, turn_ended 를 **나중에** 보낸다. 예전에는 행이 오면
// 질문과 답을 새로 덧붙이고, 종료는 진행분이 마지막일 때만 바꿨다 — 그래서 지켜보던 창에는
// 질문과 답이 두 번, 그중 하나는 커서가 깜박이는 채로 남았다(새로고침해야 사라졌다).

const texts = (store: SessionStore, key: string) =>
  store.get(key)!.messages.map((m) => `${m.role}:${m.text}${m.streaming ? '|' : ''}`)

function peerTurn(store: SessionStore, key: string, input: string, tokens: string[]) {
  store.applyPeerEvent({ kind: 'started', interactionId: key, input })
  for (const t of tokens) {
    store.applyPeerEvent({ kind: 'exec', interactionId: key, event: 'message', data: { type: 'data', content: t } })
  }
}

test('완결 행이 종료보다 먼저 와도 질문과 답은 한 번이고 커서가 남지 않는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  peerTurn(store, key, '안녕하세요', ['안녕', '하세요!'])
  store.applyExternalTurn({ interactionId: key, ioId: 21, input: '안녕하세요', output: '안녕하세요! 무엇을 도와드릴까요?', source: 'user' })
  store.applyPeerEvent({ kind: 'ended', interactionId: key, ioId: 21, input: '안녕하세요', output: '안녕하세요! 무엇을 도와드릴까요?' })
  assert.deepEqual(texts(store, key), ['user:안녕하세요', 'assistant:안녕하세요! 무엇을 도와드릴까요?'])
  assert.equal(store.get(key)!.messages[1].executionIoId, 21, '평가는 이 실행 id 로 붙는다')
  assert.equal(store.get(key)!.remote, false)
})

test('종료가 먼저 와도 뒤에 온 완결 행이 덧붙지 않는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  peerTurn(store, key, '질문', ['조각'])
  store.applyPeerEvent({ kind: 'ended', interactionId: key, ioId: 22, input: '질문', output: '완결' })
  store.applyExternalTurn({ interactionId: key, ioId: 22, input: '질문', output: '완결', source: 'user' })
  assert.deepEqual(texts(store, key), ['user:질문', 'assistant:완결'])
})

test('실행 id 없이 온 종료(옛 서버) 뒤의 완결 행도 한 번만 그린다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  peerTurn(store, key, '질문', [])
  store.applyPeerEvent({ kind: 'ended', interactionId: key, input: '질문', output: '완결' })
  store.applyExternalTurn({ interactionId: key, ioId: 23, input: '질문', output: '완결', source: 'user' })
  assert.deepEqual(texts(store, key), ['user:질문', 'assistant:완결'])
  assert.equal(store.get(key)!.messages[1].executionIoId, 23)
})

test('다른 파드의 하트비트가 종료보다 먼저 [끝남] 을 말해도 답이 사라지지 않는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  peerTurn(store, key, '질문', ['받던 답'])
  store.setRemoteRunning(key, false)
  assert.deepEqual(texts(store, key), ['user:질문', 'assistant:받던 답'], '커서만 멈추고 글은 둔다')
  store.applyExternalTurn({ interactionId: key, ioId: 24, input: '질문', output: '최종 답', source: 'user' })
  assert.deepEqual(texts(store, key), ['user:질문', 'assistant:최종 답'])
})

test('도는 중에 연 대화 — 이력의 질문 위에 답만 붙는다', async () => {
  const { store } = makeStore(
    { 'int-mid': [{ input: '앞선 질문', output: '앞선 답', ioId: 1 }, { input: '지금 질문', output: '', ioId: 2 }] },
    { 'int-mid': true },
  )
  store.openResume(agent('A'), 'int-mid')
  await flush()
  store.setRemoteRunning('int-mid', true, { text: '진행' })
  assert.deepEqual(texts(store, 'int-mid'), ['user:앞선 질문', 'assistant:앞선 답', 'user:지금 질문', 'assistant:진행|'])
  store.applyExternalTurn({ interactionId: 'int-mid', ioId: 2, input: '지금 질문', output: '지금 답', source: 'user' })
  assert.deepEqual(texts(store, 'int-mid'), ['user:앞선 질문', 'assistant:앞선 답', 'user:지금 질문', 'assistant:지금 답'])
})

test('진행분이 이력보다 먼저 와도 지난 대화가 사라지지 않는다', async () => {
  const { store } = makeStore(
    { 'int-race': [{ input: '앞선 질문', output: '앞선 답', ioId: 1 }, { input: '지금 질문', output: '', ioId: 2 }] },
    { 'int-race': true },
  )
  store.openResume(agent('A'), 'int-race')
  store.setRemoteRunning('int-race', true, { text: '진행' })   // 이력 응답보다 빠른 구독 확립
  await flush()
  assert.deepEqual(texts(store, 'int-race'), ['user:앞선 질문', 'assistant:앞선 답', 'user:지금 질문', 'assistant:진행|'])
})

test('다음 턴이 시작되면 완결을 놓친 앞 턴의 진행분은 받은 만큼으로 굳는다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  peerTurn(store, key, '첫 질문', ['첫 답 일부'])
  peerTurn(store, key, '둘째 질문', [])
  store.applyExternalTurn({ interactionId: key, ioId: 31, input: '둘째 질문', output: '둘째 답', source: 'user' })
  assert.deepEqual(texts(store, key), ['user:첫 질문', 'assistant:첫 답 일부', 'user:둘째 질문', 'assistant:둘째 답'])
})

test('내 스트림이 도는 동안의 소켓 running 은 [다른 곳] 이 아니다', async () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, '내 턴')
  await flush()
  // 서버는 "돈다" 고 말하지만 그건 **내가** 돌리는 턴이다.
  store.setRemoteRunning(key, true)
  assert.equal(store.get(key)?.remote, false)
})

// ── 끊겨도 끝난 것이 아니다 ────────────────────────────────────────────
//
// 게이트웨이는 스트리밍 응답을 1시간에 자른다. 프록시·절전·네트워크 전환도 같은
// 모양으로 끊는다. 그때 서버의 턴은 **계속 돈다** — 실행은 연결이 아니라 대화에
// 매여 있기 때문이다.
//
// 예전에는 그 끊김이 `end` 와 구분되지 않아, 받다 만 조각이 최종 답이 되고
// 화면은 조용히 멈췄다(2026-09-08, 76분짜리 턴).

test('스트림이 끊기면 실패가 아니라 [다른 곳에서 진행 중] 으로 넘어간다', async () => {
  const { store, streams } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, '오래 걸리는 일')
  await flush()
  streams[0].onEvent({ kind: 'text', content: '중간까지 받은 조각' })

  streams[0].onEvent({ kind: 'detached', reason: 'stream_closed' })

  const s = store.get(key)!
  assert.equal(s.streaming, false, '이 스트림은 놓는다')
  assert.equal(s.remote, true, '그러나 턴은 아직 돈다')
  const last = s.messages[s.messages.length - 1]
  assert.equal(last.error, undefined, '끊김은 오류가 아니다')
  assert.match(String(last.surfaceNote), /계속 진행/)

  // 작성기는 잠겨 있어야 한다 — 도는 턴 위에 새 턴을 얹으면 둘이 겹친다.
  store.send(key, '겹쳐 보내기')
  await flush()
  assert.equal(streams.length, 1, '분리 중에 새 스트림이 열렸다')

  // 끝나면 완결 push 가 답을 채운다 (대화 소켓).
  store.applyExternalTurn({
    interactionId: key,
    ioId: 3,
    input: '오래 걸리는 일',
    output: '진짜 최종 답',
    source: 'user',
  })
  const after = store.get(key)!
  assert.equal(after.remote, false)
  assert.equal(after.messages[after.messages.length - 1].text, '진짜 최종 답')
  assert.deepEqual(after.messages.map((m) => m.text), ['오래 걸리는 일', '진짜 최종 답'], '받다 만 조각이 최종 답으로 바뀐다 — 질문이 두 번 보이지 않는다')
})

test('정상 종료는 그대로 종료다 — 분리와 섞이지 않는다', async () => {
  const { store, streams } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, '금방 끝나는 일')
  await flush()
  streams[0].onEvent({ kind: 'text', content: '답' })
  streams[0].onEvent({ kind: 'end' })
  const s = store.get(key)!
  assert.equal(s.streaming, false)
  assert.equal(s.remote, false, '끝난 턴을 진행 중으로 두면 작성기가 영영 잠긴다')
})


test('workspace upload failure restores the composer without starting a turn', async () => {
  let started = false
  let restored = false
  const store = new SessionStore({
    stream() { started = true; return { cancel() {} } },
    async uploadWorkspaceAttachment() { throw new Error('upload unavailable') },
    async historyTurns() { return [] },
  }, () => 1234)
  const key = store.openNew({ ...agent('geny'), hasAgentGeny: true })
  store.send(key, 'read this', null, [{ dataUrl: 'data:application/json;base64,e30=', name: 'data.json', mime: 'application/json', size: 2, kind: 'file' }], [], () => { restored = true })
  await flush()
  assert.equal(started, false)
  assert.equal(restored, true)
  assert.equal(store.get(key)!.streaming, false)
})

test('missing workspace uploader reports an error instead of dropping a file', () => {
  const { store, streams } = makeStore()
  const key = store.openNew({ ...agent('geny'), hasAgentGeny: true })
  store.send(key, 'read this', null, [{ dataUrl: 'data:application/json;base64,e30=', name: 'data.json', mime: 'application/json', size: 2, kind: 'file' }])
  assert.equal(streams.length, 0)
  assert.equal(store.get(key)!.messages.at(-1)!.error, true)
})


test('stop ignores late callbacks from the previous stream after continuing', async () => {
  const { store, streams } = makeStore()
  const key = store.openNew(agent('A'))
  store.send(key, 'first')
  store.stop(key)
  store.send(key, 'too early')
  assert.equal(streams.length, 1)
  await flush()
  store.send(key, 'continue')
  assert.equal(streams.length, 2)
  streams[1].onEvent({ kind: 'text', content: 'new answer' })
  streams[0].onEvent({ kind: 'text', content: 'stale answer' })
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(key)!.messages.at(-1)!.text, 'new answer')
  assert.equal(store.get(key)!.streaming, true)
})
