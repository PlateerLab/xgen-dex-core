/**
 * 사이드바 [최근 채팅] · [에이전트] (2026-10-10): 서버 묶음 읽기, 옛 서버에서 묶기, 실시간 소식으로 고치기,
 * 에이전트 필터.
 */
import assert from 'assert'
import { test } from 'node:test'
import { ApiError } from '@dex/protocol/client'
import { HistoryApi } from '@dex/protocol/history'
import {
  RECENT_CONVERSATION_STEP,
  dropFromConversationAgents,
  groupConversationsByAgent,
  parseConversationAgent,
  renameInConversationAgents,
  sortConversationAgents,
  touchConversationAgent,
} from '@dex/protocol/conversation-agents'
import type { Conversation, ConversationAgent } from '@dex/protocol/types'

const conv = (iid: string, workflowId: string, updatedAt: string, extra: Partial<Conversation> = {}): Conversation => ({
  id: Number(iid.replace(/\D/g, '')) || 1,
  interactionId: iid,
  workflowId,
  workflowName: workflowId.toUpperCase(),
  interactionCount: 1,
  metadata: {},
  createdAt: updatedAt,
  updatedAt,
  title: `제목 ${iid}`,
  customTitle: false,
  tag: null,
  agentDeleted: false,
  agentOwnerId: 7,
  compare: [],
  ...extra,
})

const agentRow = (workflowId: string, lastActivity: string, extra: Partial<ConversationAgent> = {}): ConversationAgent => ({
  workflowId,
  workflowName: workflowId.toUpperCase(),
  conversationCount: 2,
  lastActivity,
  lastTitle: '마지막',
  lastInteractionId: `${workflowId}-last`,
  agentDeleted: false,
  agentOwnerId: 7,
  ...extra,
})

test('최근 채팅은 5개씩', () => {
  assert.equal(RECENT_CONVERSATION_STEP, 5)
})

test('서버 묶음 한 줄을 읽고, 에이전트를 가리킬 수 없는 줄은 버린다', () => {
  const row = parseConversationAgent({
    workflow_id: 'wf-a',
    workflow_name: 'Sales',
    conversation_count: 3,
    last_activity: '2026-10-09T10:00:00',
    last_title: '분기 매출',
    last_interaction_id: 'c1',
    agent_deleted: false,
    agent_owner_id: 7,
  })
  assert.deepEqual(row, {
    workflowId: 'wf-a',
    workflowName: 'Sales',
    conversationCount: 3,
    lastActivity: '2026-10-09T10:00:00',
    lastTitle: '분기 매출',
    lastInteractionId: 'c1',
    agentDeleted: false,
    agentOwnerId: 7,
  })
  assert.equal(parseConversationAgent({ workflow_name: 'x' }), null)
  assert.equal(parseConversationAgent({ workflow_id: 'w', conversation_count: 'nope' })?.conversationCount, 0)
})

test('대화 목록을 에이전트로 묶는다: 마지막 대화와 수, 마지막으로 말한 순서', () => {
  const rows = groupConversationsByAgent([
    conv('c1', 'wf-a', '2026-10-01T00:00:00Z'),
    conv('c2', 'wf-b', '2026-10-03T00:00:00Z'),
    conv('c3', 'wf-a', '2026-10-05T00:00:00Z', { title: '최근 것' }),
  ])
  assert.deepEqual(
    rows.map((r) => [r.workflowId, r.conversationCount, r.lastInteractionId, r.lastTitle]),
    [
      ['wf-a', 2, 'c3', '최근 것'],
      ['wf-b', 1, 'c2', '제목 c2'],
    ],
  )
})

test('정렬은 마지막으로 말한 순서, 같으면 이름 순', () => {
  const rows = sortConversationAgents([
    agentRow('b', '2026-10-01T00:00:00Z'),
    agentRow('a', '2026-10-01T00:00:00Z'),
    agentRow('c', '2026-10-02T00:00:00Z'),
  ])
  assert.deepEqual(rows.map((r) => r.workflowId), ['c', 'a', 'b'])
})

test('방금 말한 대화: 그 에이전트 줄이 맨 위로, 새 대화면 수가 는다', () => {
  const agents = [agentRow('a', '2026-10-02T00:00:00Z'), agentRow('b', '2026-10-01T00:00:00Z')]
  const turn = touchConversationAgent(agents, conv('b-9', 'b', '2026-10-09T00:00:00Z', { title: '새 말' }), false)
  assert.equal(turn.known, true)
  assert.deepEqual(turn.agents.map((r) => [r.workflowId, r.conversationCount, r.lastTitle]), [
    ['b', 2, '새 말'],
    ['a', 2, '마지막'],
  ])
  const created = touchConversationAgent(agents, conv('a-9', 'a', '2026-10-09T00:00:00Z'), true)
  assert.equal(created.agents[0].conversationCount, 3)
  assert.equal(created.agents[0].lastInteractionId, 'a-9')
})

test('묶음에 없는 에이전트: 새 대화면 줄을 만들고, 옛 대화면 다시 읽으라고 한다', () => {
  const agents = [agentRow('a', '2026-10-02T00:00:00Z')]
  const fresh = touchConversationAgent(agents, conv('z-1', 'z', '2026-10-09T00:00:00Z'), true)
  assert.equal(fresh.known, true)
  assert.deepEqual(fresh.agents.map((r) => [r.workflowId, r.conversationCount]), [
    ['z', 1],
    ['a', 2],
  ])
  const old = touchConversationAgent(agents, conv('z-1', 'z', '2026-10-09T00:00:00Z'), false)
  assert.equal(old.known, false)
  assert.deepEqual(old.agents, agents)
})

test('이름 바꾸기는 마지막 대화일 때만 줄 제목을 바꾼다', () => {
  const agents = [agentRow('a', '2026-10-02T00:00:00Z')]
  assert.equal(renameInConversationAgents(agents, 'a', 'a-last', '새 이름')[0].lastTitle, '새 이름')
  assert.equal(renameInConversationAgents(agents, 'a', 'other', '새 이름')[0].lastTitle, '마지막')
})

test('지우기: 수가 줄고 0 이면 줄이 빠지며, 마지막 대화를 지웠으면 다시 읽으라고 한다', () => {
  const agents = [agentRow('a', '2026-10-02T00:00:00Z'), agentRow('b', '2026-10-01T00:00:00Z', { conversationCount: 1 })]
  const one = dropFromConversationAgents(agents, 'a', 'a-other')
  assert.equal(one.agents[0].conversationCount, 1)
  assert.equal(one.stale, false)
  assert.equal(dropFromConversationAgents(agents, 'a', 'a-last').stale, true)
  assert.deepEqual(dropFromConversationAgents(agents, 'b', 'b-last').agents.map((r) => r.workflowId), ['a'])
  assert.deepEqual(dropFromConversationAgents(agents, 'zz', 'x').agents, agents)
})

function fakeHttp(routes: Record<string, unknown>) {
  const calls: string[] = []
  const http = {
    get<T>(path: string): Promise<T> {
      calls.push(path)
      const key = `GET ${new URL(path, 'http://x').pathname}`
      const reply = routes[key]
      if (reply instanceof Error) return Promise.reject(reply)
      if (reply === undefined) return Promise.reject(new ApiError(404, `${key} → 404`, null))
      return Promise.resolve(reply as T)
    },
  }
  return { api: new HistoryApi(http as never), calls }
}

test('묶음: 서버 API 를 부른다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/conversations/agents': {
      agents: [{ workflow_id: 'wf-a', workflow_name: 'A', conversation_count: 2 }, { nope: 1 }],
    },
  })
  const rows = await api.conversationAgents()
  assert.deepEqual(rows.map((r) => r.workflowId), ['wf-a'])
  assert.equal(new URL(calls[0], 'http://x').searchParams.get('limit'), '200')
})

test('묶음: API 가 없는 옛 서버(404)는 대화 목록으로 묶는다', async () => {
  const { api } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [
        { interaction_id: 'c1', workflow_id: 'wf-a', workflow_name: 'A', updated_at: '2026-10-01T00:00:00Z' },
        { interaction_id: 'c2', workflow_id: 'wf-a', workflow_name: 'A', updated_at: '2026-10-02T00:00:00Z' },
      ],
      next_cursor: null,
    },
  })
  const rows = await api.conversationAgents()
  assert.deepEqual(rows.map((r) => [r.workflowId, r.conversationCount, r.lastInteractionId]), [['wf-a', 2, 'c2']])
})

test('에이전트 필터: 보내고, 모르는 서버면 받은 쪽을 거른다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [
        { interaction_id: 'c1', workflow_id: 'wf-a' },
        { interaction_id: 'c2', workflow_id: 'wf-b' },
      ],
      next_cursor: 'n',
      total: 2,
    },
  })
  const page = await api.conversationPage({ workflowId: 'wf-a' })
  assert.equal(new URL(calls[0], 'http://x').searchParams.get('workflow_id'), 'wf-a')
  assert.deepEqual(page.conversations.map((c) => c.interactionId), ['c1'])
  assert.equal(page.total, undefined)
})

test('에이전트 필터: 아는 서버면 총 수를 그대로 쓴다', async () => {
  const { api } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [{ interaction_id: 'c1', workflow_id: 'wf-a' }],
      next_cursor: null,
      total: 1,
      workflow_id: 'wf-a',
    },
  })
  const page = await api.conversationPage({ workflowId: 'wf-a' })
  assert.equal(page.total, 1)
})
