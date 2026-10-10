/**
 * 대화 목록 (2026-10-09): 마지막으로 말한 순서, 첫 메시지 제목, 꼬리표, 목록 규칙.
 *
 * 데스크톱·CLI·VSCode·모바일이 이 모듈 하나로 목록을 읽고 고친다. 옛 서버(새 API 404)에서도
 * 같은 모양이 나와야 한다: 어느 서버에 붙어도 목록이 같아 보여야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { ApiError } from '@dex/protocol/client'
import { HistoryApi } from '@dex/protocol/history'
import {
  CONVERSATION_TAG_LABELS,
  conversationAgentLabel,
  conversationDisplayTitle,
  conversationListChange,
  conversationMatchesKind,
  conversationTagOf,
  conversationTitleFromMetadata,
  foldLegacyConversations,
  legacyConversation,
  mergeConversationPage,
  parseConversation,
  removeConversation,
  renameConversationInList,
  sortConversations,
  touchConversation,
} from '@dex/protocol/conversation-list'
import type { Conversation } from '@dex/protocol/types'

const conv = (iid: string, updatedAt: string, extra: Partial<Conversation> = {}): Conversation => ({
  id: Number(iid.replace(/\D/g, '')) || 1,
  interactionId: iid,
  workflowId: 'wf',
  workflowName: 'Agent',
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

const ids = (list: Conversation[]) => list.map((c) => c.interactionId)

test('서버 줄을 읽는다: 제목·꼬리표·지워짐·주인·비교 묶음', () => {
  const c = parseConversation({
    id: 3,
    interaction_id: 'chat-1',
    workflow_id: 'wf-a',
    workflow_name: '상담봇',
    title: '분기 매출 정리',
    custom_title: true,
    tag: 'compare',
    agent_deleted: false,
    agent_owner_id: 12,
    interaction_count: 4,
    created_at: '2026-10-01T09:00:00+09:00',
    updated_at: '2026-10-09T21:00:00+09:00',
    compare: [{ interaction_id: 'chat-1__cmp_wf-b', workflow_id: 'wf-b', workflow_name: 'B' }],
  })
  assert.ok(c)
  assert.equal(c.title, '분기 매출 정리')
  assert.equal(c.customTitle, true)
  assert.equal(c.tag, 'compare')
  assert.equal(c.agentOwnerId, 12)
  assert.deepEqual(c.compare, [{ interactionId: 'chat-1__cmp_wf-b', workflowId: 'wf-b', workflowName: 'B' }])
  assert.equal(parseConversation({ interaction_id: 'x', workflow_id: 'wf', tag: 'weird' })?.tag, null)
  assert.equal(parseConversation({ interaction_id: '', workflow_id: 'wf' }), null)
})

test('꼬리표는 서버와 같은 규칙: 배포·Teams·스케줄·비교·API·테스트·캔버스', () => {
  assert.equal(conversationTagOf('chat_1696_ab'), null)
  assert.equal(conversationTagOf('conn-wf-1696'), null)
  assert.equal(conversationTagOf('a'.repeat(40)), 'deploy')
  assert.equal(conversationTagOf('guest_x'), 'deploy')
  assert.equal(conversationTagOf('teams-room-wf'), 'teams')
  assert.equal(conversationTagOf('schedule_wf'), 'schedule')
  assert.equal(conversationTagOf('workflow_schedule_s1'), 'schedule')
  assert.equal(conversationTagOf('openai_01'), 'api')
  assert.equal(conversationTagOf('tester_run'), 'test')
  assert.equal(conversationTagOf('canvas_wf_7'), 'canvas')
  assert.equal(conversationTagOf('chat_1__cmp_wf2'), 'compare')
  assert.equal(conversationTagOf('chat_1', true), 'compare')
  assert.equal(CONVERSATION_TAG_LABELS.teams, 'Teams')
})

test('옛 메타의 제목: 붙인 이름, 없으면 첫 메시지 한 줄, 첨부만 보냈으면 첫 파일 이름', () => {
  assert.deepEqual(conversationTitleFromMetadata({ first_message: '  분기 매출\n\n정리해 줘 ' }), {
    title: '분기 매출 정리해 줘',
    customTitle: false,
  })
  const envelope = JSON.stringify({ input_str: '이 표 요약', attachments: [{ name: 'a.xlsx' }] })
  assert.equal(conversationTitleFromMetadata({ first_message: envelope }).title, '이 표 요약')
  const filesOnly = JSON.stringify({ input_str: '', attachments: [{ name: '보고서.pdf' }] })
  assert.equal(conversationTitleFromMetadata({ first_message: filesOnly }).title, '보고서.pdf')
  assert.deepEqual(conversationTitleFromMetadata({ first_message: 'x', title: ' 내 이름 ' }), {
    title: '내 이름',
    customTitle: true,
  })
  const long = conversationTitleFromMetadata({ first_message: '가'.repeat(300) }).title
  assert.equal(long.length, 80)
  assert.ok(long.endsWith('…'))
  assert.equal(conversationTitleFromMetadata(undefined).title, '')
})

test('옛 목록이 200자로 잘라 깨진 봉투도 본문만 제목으로 쓴다', () => {
  const full = JSON.stringify({ input_str: '우리 게임 앱 하나 만들어 줘\n자세히는', attachments: [{ name: 'a.png' }] })
  const cut = `${full.slice(0, 40)}…`
  assert.throws(() => JSON.parse(cut))
  const title = conversationTitleFromMetadata({ first_message: cut }).title
  assert.ok(title.startsWith('우리 게임 앱 하나 만들어 줘'), title)
  assert.ok(!title.includes('input_str'))
  // 이스케이프 중간에서 잘려도 깨진 글자가 남지 않는다.
  const midEscape = '{"input_str": "줄 하나\\'
  assert.equal(conversationTitleFromMetadata({ first_message: midEscape }).title, '줄 하나')
})

test('옛 목록: 같은 모양으로 읽고 비교 파생은 부모 줄로 접는다', () => {
  const rows = [
    { id: 1, interaction_id: 'p1', workflow_id: 'wf-a', workflow_name: 'A', metadata: { first_message: '안녕' } },
    { id: 2, interaction_id: 'p1__cmp_wf-b', workflow_id: 'wf-b', workflow_name: 'B', metadata: {} },
    { id: 3, interaction_id: 'lost__cmp_wf-c', workflow_id: 'wf-c', workflow_name: 'C', metadata: {} },
    { id: 4, interaction_id: 'teams-r-wf', workflow_id: 'wf-a', workflow_name: 'A', agent_deleted: true },
  ].map(legacyConversation)
  const folded = foldLegacyConversations(rows)
  assert.deepEqual(ids(folded), ['p1', 'lost__cmp_wf-c', 'teams-r-wf'])
  assert.equal(folded[0].title, '안녕')
  assert.equal(folded[0].tag, 'compare')
  assert.deepEqual(folded[0].compare.map((c) => c.interactionId), ['p1__cmp_wf-b'])
  assert.equal(folded[1].tag, 'compare')
  assert.equal(folded[2].tag, 'teams')
  assert.equal(folded[2].agentDeleted, true)
})

test('줄 표시: 제목이 없으면 "새 대화", 에이전트가 사라졌으면 "지워짐"', () => {
  assert.equal(conversationDisplayTitle({ title: '  ' }), '새 대화')
  assert.equal(conversationAgentLabel({ agentDeleted: true, workflowName: 'A' }), '지워짐')
  assert.equal(conversationAgentLabel({ agentDeleted: false, workflowName: 'A' }), 'A')
})

test('순서와 합치기: 마지막으로 말한 순서, 첫 쪽을 다시 읽어도 뒤쪽은 지킨다', () => {
  assert.deepEqual(
    ids(sortConversations([conv('c1', '2026-10-01T00:00:00Z'), conv('c3', '2026-10-05T00:00:00Z'), conv('c2', '2026-10-05T00:00:00Z')])),
    ['c3', 'c2', 'c1'],
  )
  const current = [conv('c9', '2026-10-09T00:00:00Z'), conv('c8', '2026-10-08T00:00:00Z'), conv('c2', '2026-10-02T00:00:00Z')]
  const head = mergeConversationPage(current, [conv('c2', '2026-10-10T00:00:00Z', { title: '방금' }), conv('c9', '2026-10-09T00:00:00Z')], 'head')
  assert.deepEqual(ids(head), ['c2', 'c9', 'c8'])
  assert.equal(head[0].title, '방금')
  assert.deepEqual(ids(mergeConversationPage(current, [conv('c8', '2026-10-08T00:00:00Z'), conv('c1', '2026-10-01T00:00:00Z')], 'append')), [
    'c9',
    'c8',
    'c2',
    'c1',
  ])
})

test('방금 말한 대화는 맨 위로, 비교 묶음·주인은 지키고 모르는 대화는 알린다', () => {
  const compare = [{ interactionId: 'c5__cmp_wf-b', workflowId: 'wf-b', workflowName: 'B' }]
  const current = [conv('c9', '2026-10-09T00:00:00Z'), conv('c5', '2026-10-05T00:00:00Z', { tag: 'compare', compare })]
  const touched = touchConversation(current, conv('c5', '2026-10-10T00:00:00Z', { interactionCount: 7, agentOwnerId: null }))
  assert.equal(touched.known, true)
  assert.deepEqual(ids(touched.list), ['c5', 'c9'])
  assert.equal(touched.list[0].interactionCount, 7)
  assert.equal(touched.list[0].tag, 'compare')
  assert.deepEqual(touched.list[0].compare, compare)
  assert.equal(touched.list[0].agentOwnerId, 7)
  const unknown = touchConversation(current, conv('c10', '2026-10-10T00:00:00Z'))
  assert.equal(unknown.known, false)
  assert.equal(unknown.list, current)
})

test('지우기·이름 바꾸기는 (에이전트, 대화) 둘 다로 가린다', () => {
  const list = [conv('c1', '2026-10-01T00:00:00Z', { workflowId: 'wf-a' }), conv('c1', '2026-10-01T00:00:00Z', { workflowId: 'wf-b' })]
  assert.deepEqual(removeConversation(list, 'wf-a', 'c1').map((c) => c.workflowId), ['wf-b'])
  assert.deepEqual(
    renameConversationInList(list, 'wf-b', 'c1', '새 이름', true).map((c) => [c.workflowId, c.title, c.customTitle]),
    [
      ['wf-a', '제목 c1', false],
      ['wf-b', '새 이름', true],
    ],
  )
})

test('소켓 소식 → 목록이 할 일', () => {
  const touched = conversationListChange('conversation_touched', {
    interaction_id: 'c1',
    workflow_id: 'wf',
    created: true,
    conversation: { interaction_id: 'c1', workflow_id: 'wf', title: '안녕', updated_at: '2026-10-10T00:00:00Z' },
  })
  assert.equal(touched.type, 'touched')
  assert.equal(touched.type === 'touched' && touched.conversation?.title, '안녕')
  assert.equal(touched.type === 'touched' && touched.created, true)
  assert.deepEqual(conversationListChange('conversation_updated', { interaction_id: 'c1', workflow_id: 'wf', title: '새', custom_title: true }), {
    type: 'renamed',
    workflowId: 'wf',
    interactionId: 'c1',
    title: '새',
    customTitle: true,
  })
  assert.deepEqual(conversationListChange('conversation_updated', { interaction_id: 'c1', workflow_id: 'wf', metadata: {} }), { type: 'reload' })
  assert.deepEqual(conversationListChange('conversation_deleted', { interaction_id: 'c1', workflow_id: 'wf' }), {
    type: 'removed',
    workflowId: 'wf',
    interactionId: 'c1',
  })
  assert.deepEqual(conversationListChange('conversation_running', { interaction_id: 'c1', workflow_id: 'wf', running: true }), {
    type: 'running',
    workflowId: 'wf',
    interactionId: 'c1',
    running: true,
  })
  assert.deepEqual(conversationListChange('apps', {}), { type: 'ignore' })
  assert.deepEqual(conversationListChange('folders', {}), { type: 'ignore' })
  assert.deepEqual(conversationListChange('something_new', {}), { type: 'reload' })
})

function fakeHttp(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const answer = (method: string, path: string) => {
    const key = `${method} ${new URL(path, 'http://x').pathname}`
    const reply = routes[key]
    if (reply instanceof Error) return Promise.reject(reply)
    if (reply === undefined) return Promise.reject(new ApiError(404, `${key} → 404`, null))
    return Promise.resolve(reply)
  }
  const http = {
    get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path })
      return answer('GET', path) as Promise<T>
    },
    post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body })
      return answer('POST', path) as Promise<T>
    },
    del<T>(path: string): Promise<T> {
      calls.push({ method: 'DELETE', path })
      return answer('DELETE', path) as Promise<T>
    },
  }
  return { api: new HistoryApi(http as never), calls }
}

test('대화 목록 한 쪽: 새 API 를 커서와 함께 부른다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [{ interaction_id: 'c1', workflow_id: 'wf', title: 't', updated_at: '2026-10-10T00:00:00Z' }],
      next_cursor: 'CUR',
      agent_deleted_count: 2,
    },
  })
  const page = await api.conversationPage({ limit: 20, cursor: 'PREV' })
  const url = new URL(calls[0].path, 'http://x')
  assert.equal(url.searchParams.get('limit'), '20')
  assert.equal(url.searchParams.get('cursor'), 'PREV')
  assert.deepEqual(ids(page.conversations), ['c1'])
  assert.equal(page.nextCursor, 'CUR')
  assert.equal(page.agentDeletedCount, 2)
})

test('옛 서버(새 API 404): 옛 목록을 같은 모양으로, 한 쪽에 끝낸다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/list': {
      execution_meta_list: [
        { id: 1, interaction_id: 'p1', workflow_id: 'wf', workflow_name: 'A', metadata: { first_message: '안녕' } },
        { id: 2, interaction_id: 'p1__cmp_wf-b', workflow_id: 'wf-b', workflow_name: 'B', metadata: {} },
        { id: 3, interaction_id: 'gone', workflow_id: 'wf-x', workflow_name: 'X', agent_deleted: true },
      ],
    },
  })
  const page = await api.conversationPage()
  assert.deepEqual(calls.map((c) => new URL(c.path, 'http://x').pathname), ['/api/interaction/conversations', '/api/interaction/list'])
  assert.deepEqual(ids(page.conversations), ['p1', 'gone'])
  assert.equal(page.conversations[0].title, '안녕')
  assert.equal(page.nextCursor, null)
  assert.equal(page.agentDeletedCount, 1)
})

test('다른 오류는 옛 목록으로 숨기지 않는다', async () => {
  const { api } = fakeHttp({ 'GET /api/interaction/conversations': new ApiError(500, 'boom', null) })
  await assert.rejects(() => api.conversationPage(), /boom/)
})

test('전부 받기는 커서를 따라간다', async () => {
  let n = 0
  const http = {
    get<T>(path: string): Promise<T> {
      const cursor = new URL(path, 'http://x').searchParams.get('cursor')
      n += 1
      const page = cursor
        ? { conversations: [{ interaction_id: 'c2', workflow_id: 'wf' }], next_cursor: null }
        : { conversations: [{ interaction_id: 'c1', workflow_id: 'wf' }], next_cursor: 'N' }
      return Promise.resolve(page as T)
    },
  }
  const all = await new HistoryApi(http as never).conversations()
  assert.deepEqual(ids(all), ['c1', 'c2'])
  assert.equal(n, 2)
})

test('이름 바꾸기·지우기·정리는 웹과 같은 엔드포인트·같은 몸통', async () => {
  const { api, calls } = fakeHttp({
    'POST /api/interaction/conversations/rename': { title: '새 이름', custom_title: true },
    'DELETE /api/chat/io-logs': { deleted_count: 3 },
    'DELETE /api/chat/io-logs/orphans': { deleted_interactions: 4 },
  })
  assert.deepEqual(await api.renameConversation('wf', 'c1', ' 새 이름 '), { title: '새 이름', customTitle: true })
  assert.deepEqual(calls[0].body, { workflow_id: 'wf', interaction_id: 'c1', title: ' 새 이름 ' })
  await api.deleteConversation('wf', 'c1', 'Agent')
  const del = new URL(calls[1].path, 'http://x')
  assert.equal(del.searchParams.get('with_compare'), 'true')
  assert.equal(del.searchParams.get('workflow_name'), 'Agent')
  assert.equal(await api.purgeDeletedAgentConversations(), 4)
})

test('상태 필터 판정: 서버 kind 와 같다(배포 = SHA1, 삭제됨 = 에이전트 사라짐, 활성 = 둘 다 아님)', () => {
  const sha = 'a'.repeat(40)
  assert.equal(conversationMatchesKind({ interactionId: sha, agentDeleted: false }, 'deploy'), true)
  assert.equal(conversationMatchesKind({ interactionId: 'deploy_x', agentDeleted: false }, 'deploy'), false)
  assert.equal(conversationMatchesKind({ interactionId: 'c1', agentDeleted: true }, 'deleted'), true)
  assert.equal(conversationMatchesKind({ interactionId: 'c1', agentDeleted: false }, 'active'), true)
  assert.equal(conversationMatchesKind({ interactionId: sha, agentDeleted: false }, 'active'), false)
  assert.equal(conversationMatchesKind({ interactionId: 'c1', agentDeleted: true }, 'active'), false)
  assert.equal(conversationMatchesKind({ interactionId: 'c1', agentDeleted: true }, 'all'), true)
  assert.equal(conversationMatchesKind({ interactionId: 'c1', agentDeleted: true }, undefined), true)
})

test('대화 목록 한 쪽: 상태 필터를 보내고 총 수를 읽는다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [{ interaction_id: 'g', workflow_id: 'wf', agent_deleted: true }],
      next_cursor: null,
      agent_deleted_count: 1,
      total: 1,
      kind: 'deleted',
    },
  })
  const page = await api.conversationPage({ kind: 'deleted' })
  assert.equal(new URL(calls[0].path, 'http://x').searchParams.get('kind'), 'deleted')
  assert.equal(page.total, 1)
  assert.deepEqual(page.conversations.map((c) => c.interactionId), ['g'])
  // 전체는 kind 를 보내지 않는다.
  await api.conversationPage({ kind: 'all' })
  assert.equal(new URL(calls[1].path, 'http://x').searchParams.get('kind'), null)
})

test('대화 목록 한 쪽: 상태 필터를 모르는 서버면 받은 쪽을 같은 판정으로 거르고 총 수는 모른다', async () => {
  const { api } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [
        { interaction_id: 'a', workflow_id: 'wf', agent_deleted: false },
        { interaction_id: 'g', workflow_id: 'wf', agent_deleted: true },
      ],
      next_cursor: 'next',
      total: 2,
    },
  })
  const page = await api.conversationPage({ kind: 'deleted' })
  assert.deepEqual(page.conversations.map((c) => c.interactionId), ['g'])
  assert.equal(page.total, undefined)
  assert.equal(page.nextCursor, 'next')
})
