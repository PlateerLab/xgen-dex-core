/**
 * 스토어가 끝난 턴의 작업 과정을 남기고, 대화를 다시 열 때(이력) 답에 되붙이는지.
 * 앱을 껐다 켠 것은 같은 저장소를 쓰는 새 스토어로 흉내 낸다.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, ChatEvent } from '@dex/protocol'
import { SessionStore, type SessionTransport } from '../src/renderer/src/session-store'
import type { KeyValueStorage } from '../src/renderer/src/turn-process-memory'

const flush = () => new Promise((r) => setTimeout(r, 0))
const agentA = { workflowId: 'A', workflowName: 'A' } as Agent

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

function liveTurn(storage: KeyValueStorage | null) {
  const sink: { onEvent?: (ev: ChatEvent) => void } = {}
  const transport: SessionTransport = {
    stream(_req, onEvent) {
      sink.onEvent = onEvent
      return { cancel: () => {}, stop: async () => {} }
    },
    async historyTurns() { return [] },
    async historySnapshot() { return { turns: [], running: false } },
  }
  let clock = 1000
  const store = new SessionStore(transport, () => clock++, storage)
  const key = store.openNew(agentA)
  store.send(key, '파일을 읽어 줘')
  const emit = (ev: ChatEvent) => sink.onEvent?.(ev)
  emit({ kind: 'text', content: '읽는 중입니다.\n' })
  emit({ kind: 'tool', event: { eventType: 'tool_result', toolName: 'Read', result: 'ok' } })
  emit({ kind: 'text', content: '3건입니다.' })
  emit({ kind: 'end' })
  const messages = store.get(key)!.messages
  return { key, answer: messages[messages.length - 1].text }
}

function reopen(storage: KeyValueStorage | null, key: string, output: string) {
  const transport: SessionTransport = {
    stream() { return { cancel: () => {}, stop: async () => {} } },
    async historyTurns() { return [] },
    async historySnapshot() { return { turns: [{ input: '파일을 읽어 줘', output }], running: false } },
  }
  const store = new SessionStore(transport, () => 5000, storage)
  store.restore([{ workflowId: 'A', workflowName: 'A', interactionId: key }])
  return store
}

test('끝난 턴의 과정은 앱을 다시 켜 대화를 열어도 답에 붙어 있다', async () => {
  const storage = memoryStorage()
  const { key, answer } = liveTurn(storage)
  assert.equal(answer, '읽는 중입니다.\n3건입니다.')

  // 서버 이력은 문단 사이 공백이 다를 수 있다
  const store = reopen(storage, key, answer.replace('\n', '\n\n'))
  await flush()
  await flush()
  const msgs = store.get(key)!.messages
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1].flow?.length, 3, '작업 과정이 되붙지 않았다')
  assert.equal(msgs[1].tools?.length, 1, '전체 로그용 도구 기록이 되붙지 않았다')
  assert.notEqual(msgs[1].startedAt, undefined)
})

test('저장소가 없으면 예전처럼 글만 되살린다', async () => {
  const { key, answer } = liveTurn(null)
  const store = reopen(null, key, answer)
  await flush()
  await flush()
  const msgs = store.get(key)!.messages
  assert.equal(msgs[1].text, answer)
  assert.equal(msgs[1].flow, undefined)
})
