/**
 * SessionStore — 도는 턴에 사용자 메시지를 넣는다(steer).
 *
 * 이 창이 받는 중인 자기 턴에서 보낸 글은 그 턴에 들어간다. 답 말풍선 끝에 "전달 대기" 로 먼저 서고,
 * 결말(steer 이벤트)이 오면 그 자리(offset)로 옮겨 가거나 거둬진다. 들어가지 못한 글은 턴이 끝나면
 * 다음 턴으로 보내고, [정지] 했으면 보내지 않고 작성기로 돌려준다. 메시지는 사라지지 않는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { SessionStore, type SessionTransport } from '../src/renderer/src/session-store'
import type { Agent, ChatEvent, HistorySteer, SteerStatus } from '@dex/protocol'

function agent(workflowId: string): Agent {
  return {
    id: 1, workflowId, workflowName: workflowId, nodeCount: 1, isShared: false, isDeployed: false,
    isCompleted: true, description: '', username: '', fullName: '', createdAt: '', updatedAt: '',
  }
}

interface Stream { input: unknown; onEvent: (e: ChatEvent) => void }

function makeStore(opts: {
  steer?: (interactionId: string, text: string, clientMsgId?: string) => Promise<SteerStatus>
  history?: Record<string, Array<{ input: string; output: string; ioId?: number; steers?: HistorySteer[] }>>
} = {}) {
  const streams: Stream[] = []
  const steerCalls: Array<{ interactionId: string; text: string; clientMsgId?: string }> = []
  const transport: SessionTransport = {
    stream(req, onEvent) {
      streams.push({ input: req.input, onEvent })
      return { cancel: () => {}, stop: async () => ({ stopped: true }) }
    },
    async historyTurns(_w, id) { return opts.history?.[id] ?? [] },
    async historySnapshot(_w, id) { return { turns: opts.history?.[id] ?? [], running: false } },
    ...(opts.steer
      ? {
          steer: (interactionId: string, text: string, clientMsgId?: string) => {
            steerCalls.push({ interactionId, text, clientMsgId })
            return opts.steer!(interactionId, text, clientMsgId)
          },
        }
      : {}),
  }
  let clock = 1000
  return { store: new SessionStore(transport, () => clock++), streams, steerCalls }
}

const flush = () => new Promise((r) => setTimeout(r, 5))
const lastAnswer = (store: SessionStore, k: string) => {
  const msgs = store.get(k)!.messages
  return msgs[msgs.length - 1]
}

test('옛 preload(받는 길 없음)·스트림 없음이면 넣지 않는다', () => {
  const { store } = makeStore()
  const k = store.openNew(agent('A'))
  assert.equal(store.steer(k, '추가'), false) // 도는 턴이 없다
  store.send(k, '질문')
  assert.equal(store.steer(k, '추가'), false) // 받는 길이 없다
  assert.equal(lastAnswer(store, k).steers, undefined)
})

test('넣은 글은 전달 대기로 서고, 들어가면 그 자리로 옮겨 간다', async () => {
  const { store, streams, steerCalls } = makeStore({ steer: async () => 'queued' })
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  streams[0].onEvent({ kind: 'text', content: '앞부분. ' })
  assert.equal(store.steer(k, '  테스트도 돌려 줘  '), true)
  const pending = lastAnswer(store, k).steers!
  assert.equal(pending.length, 1)
  assert.equal(pending[0].status, 'pending')
  assert.equal(pending[0].text, '테스트도 돌려 줘')
  await flush()
  assert.equal(steerCalls.length, 1)
  assert.equal(steerCalls[0].interactionId, store.get(k)!.interactionId)
  assert.equal(steerCalls[0].clientMsgId, pending[0].clientMsgId)

  streams[0].onEvent({ kind: 'steer', steer: { status: 'delivered', clientMsgId: pending[0].clientMsgId, text: '테스트도 돌려 줘', offset: 5 } })
  streams[0].onEvent({ kind: 'text', content: '테스트를 돌렸습니다.' })
  streams[0].onEvent({ kind: 'end' })
  await flush()
  const done = lastAnswer(store, k)
  assert.deepEqual(done.steers, [{ text: '테스트도 돌려 줘', status: 'delivered', offset: 5, clientMsgId: pending[0].clientMsgId }])
  assert.equal(streams.length, 1) // 들어간 글은 다시 보내지 않는다
})

test('돌아온 글은 말풍선에서 거두고 턴이 끝나면 다음 턴으로 보낸다', async () => {
  const { store, streams } = makeStore({ steer: async () => 'queued' })
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  store.steer(k, '늦은 말')
  await flush()
  const cid = lastAnswer(store, k).steers![0].clientMsgId
  streams[0].onEvent({ kind: 'steer', steer: { status: 'rejected', clientMsgId: cid, text: '늦은 말' } })
  assert.equal(lastAnswer(store, k).steers, undefined)
  streams[0].onEvent({ kind: 'end' })
  await flush()
  assert.equal(streams.length, 2)
  assert.equal(streams[1].input, '늦은 말')
  const msgs = store.get(k)!.messages
  assert.equal(msgs[msgs.length - 2].text, '늦은 말') // 새 턴의 질문으로 보인다
})

test('서버가 받지 못하면(closed) 턴이 끝난 뒤 다음 턴으로 — 결말을 못 들은 글도 같다', async () => {
  const { store, streams } = makeStore({ steer: async (_i, text) => (text === '닫힘' ? 'closed' : 'queued') })
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  store.steer(k, '닫힘')
  store.steer(k, '무소식')
  await flush()
  assert.deepEqual(lastAnswer(store, k).steers!.map((st) => st.text), ['무소식'])
  streams[0].onEvent({ kind: 'end' })
  await flush()
  assert.equal(streams.length, 2)
  assert.equal(streams[1].input, '닫힘\n\n무소식')
  assert.equal(store.get(k)!.messages.some((m) => m.steers?.some((st) => st.status === 'pending')), false)
})

test('[정지] 하면 들어가지 못한 글은 보내지 않고 작성기로 돌려준다', async () => {
  const { store, streams } = makeStore({ steer: async () => 'queued' })
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  store.steer(k, '그만둔 턴의 말')
  await flush()
  store.stop(k)
  await flush()
  assert.equal(store.get(k)!.steerReturn, '그만둔 턴의 말')
  assert.equal(streams.length, 1)
  assert.equal(lastAnswer(store, k).steers, undefined)
  store.takeSteerReturn(k)
  assert.equal(store.get(k)!.steerReturn, undefined)
})

test('지난 대화의 steers 는 답의 그 자리로 되살아난다', async () => {
  const history = { 'conv-1': [{ input: '질문', output: '앞. 뒤.', ioId: 7, steers: [{ text: '추가', offset: 3 }] }] }
  const { store } = makeStore({ history })
  const k = store.openResume(agent('A'), 'conv-1')
  await flush()
  const answer = store.get(k)!.messages.find((m) => m.role === 'assistant')!
  assert.deepEqual(answer.steers, [{ text: '추가', offset: 3, status: 'delivered' }])
})
