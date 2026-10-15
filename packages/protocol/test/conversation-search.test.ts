/**
 * 채팅 검색 (2026-10-10): 낱말 규칙, 강조 조각, 한 줄 조각, 서버 응답, 옛 서버 대체, 날 표시.
 *
 * 규칙은 서버(xgen-workflow conversation_search.py)와 같아야 한다. XD 는 이 규칙으로 제 대화를 찾는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { ApiError } from '@dex/protocol/client'
import { HistoryApi } from '@dex/protocol/history'
import {
  SEARCH_SNIPPET_LEN,
  SEARCH_TERMS_MAX,
  conversationDayLabel,
  parseConversationSearchHit,
  parseSearchParts,
  searchConversationList,
  searchCovers,
  searchHasHit,
  searchParts,
  searchPlain,
  searchSnippet,
  searchTerms,
  searchTurnMatch,
} from '@dex/protocol/conversation-search'
import type { Conversation, SearchTextPart } from '@dex/protocol/types'

const hits = (parts: SearchTextPart[] | null) => (parts ?? []).filter((p) => p.hit).map((p) => p.text)

const conv = (iid: string, extra: Partial<Conversation> = {}): Conversation => ({
  id: 1,
  interactionId: iid,
  workflowId: 'wf',
  workflowName: 'Sales Agent',
  interactionCount: 1,
  metadata: {},
  createdAt: '2026-09-01T00:00:00',
  updatedAt: '2026-09-01T00:00:00',
  title: '제목',
  customTitle: false,
  tag: null,
  agentDeleted: false,
  agentOwnerId: null,
  compare: [],
  ...extra,
})

test('낱말: 띄어쓰기로 나누고, 큰따옴표는 구절, 같은 낱말은 한 번, 상한', () => {
  assert.deepEqual(searchTerms('  분기   매출 '), ['분기', '매출'])
  assert.deepEqual(searchTerms('"분기 매출" 정리'), ['분기 매출', '정리'])
  assert.deepEqual(searchTerms('INTJ intj Intj'), ['INTJ'])
  assert.deepEqual(searchTerms('  ""  '), [])
  assert.equal(searchTerms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')).length, SEARCH_TERMS_MAX)
})

test('강조 조각: 대소문자 무시, 긴 낱말 먼저, 정규식 글자는 글자 그대로', () => {
  const parts = searchParts('INTJ와 intj', ['intj'])
  assert.deepEqual(hits(parts), ['INTJ', 'intj'])
  assert.equal(searchPlain(parts), 'INTJ와 intj')
  assert.deepEqual(hits(searchParts('매출액 합계', ['매출', '매출액'])), ['매출액'])
  assert.deepEqual(hits(searchParts('a.b와 axb', ['a.b'])), ['a.b'])
  assert.deepEqual(searchParts('', ['a']), [])
  assert.equal(searchHasHit(parts), true)
  assert.equal(searchHasHit([{ text: 'x', hit: false }]), false)
})

test('한 줄 조각: 처음 맞은 자리 둘레, 줄바꿈은 펴고, 없으면 null', () => {
  const snippet = searchSnippet('가'.repeat(100) + ' INTJ ' + '나'.repeat(200), ['intj'])
  assert.ok(snippet)
  assert.equal(snippet[0].text, '…')
  assert.equal(snippet[snippet.length - 1].text, '…')
  assert.deepEqual(hits(snippet), ['INTJ'])
  assert.ok(searchPlain(snippet).length <= SEARCH_SNIPPET_LEN + 2)
  assert.equal(searchPlain(searchSnippet('첫 줄\n\n둘째 줄 매출', ['매출'])), '첫 줄 둘째 줄 매출')
  assert.equal(searchSnippet('아무 말', ['매출']), null)
})

test('한 줄 조각은 이모지를 반쪽으로 자르지 않는다', () => {
  const text = '😀'.repeat(40) + ' 매출 ' + '😀'.repeat(80)
  const plain = searchPlain(searchSnippet(text, ['매출']))
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(plain), false)
})

test('턴: 낱말이 제목·이름·턴에 나뉘어 있어도 맞고, 턴에 하나는 있어야 하며, 많이 든 쪽에서 자른다', () => {
  assert.equal(searchCovers(['Sales Agent', '서울이 큽니다'], ['sales', '서울']), true)
  const m = searchTurnMatch('제목', 'Sales Agent', '지역별로도', '서울이 큽니다', ['sales', '서울'])
  assert.ok(m)
  assert.equal(m.snippetFrom, 'output')
  assert.deepEqual(hits(m.snippet), ['서울'])
  assert.equal(searchTurnMatch('분기', 'Sales', '다른 말', '다른 답', ['분기']), null)
  assert.equal(searchTurnMatch('t', 'a', '매출', '', ['매출', '독립성']), null)
  assert.equal(searchTurnMatch('t', 'a', '매출 이야기', '매출', ['매출'])?.snippetFrom, 'input')
})

test('서버 결과 한 줄을 대화와 맞은 자리로 읽는다', () => {
  const hit = parseConversationSearchHit({
    id: 4,
    interaction_id: 'chat-4',
    workflow_id: 'wf-a',
    workflow_name: 'HR Helper',
    title: '궁금',
    updated_at: '2026-10-09T10:00:00',
    match: {
      title: [{ text: '궁금', hit: false }],
      agent: [{ text: 'HR Helper', hit: false }, { text: 3 }],
      snippet: [{ text: '…아래는 ', hit: false }, { text: 'INTJ', hit: true }],
      snippet_from: 'output',
      matched_at: '2026-10-09T10:00:00',
    },
  })
  assert.ok(hit)
  assert.equal(hit.conversation.interactionId, 'chat-4')
  assert.equal(hit.conversation.title, '궁금')
  assert.equal(hit.match.snippetFrom, 'output')
  assert.deepEqual(hits(hit.match.snippet), ['INTJ'])
  assert.deepEqual(hit.match.agent, [{ text: 'HR Helper', hit: false }])
  assert.equal(parseConversationSearchHit({ workflow_id: 'wf' }), null)
  assert.deepEqual(parseSearchParts('nope'), [])
  const bare = parseConversationSearchHit({ interaction_id: 'c', workflow_id: 'w', match: { snippet: [], snippet_from: 'x' } })
  assert.equal(bare?.match.snippet, null)
  assert.equal(bare?.match.snippetFrom, null)
})

test('옛 서버: 목록의 제목·에이전트 이름으로만 찾는다', () => {
  const list = [
    conv('a', { title: '분기 매출 정리', workflowName: 'Sales Agent' }),
    conv('b', { title: '휴가 신청', workflowName: 'HR Helper' }),
    conv('c', { title: '매출 예측', workflowName: 'Sales Agent' }),
  ]
  const page = searchConversationList(list, 'sales 매출', 1)
  assert.deepEqual(page.hits.map((h) => h.conversation.interactionId), ['a'])
  assert.equal(page.hasMore, true)
  assert.equal(page.contentSearched, false)
  assert.deepEqual(hits(page.hits[0].match.title), ['매출'])
  assert.deepEqual(hits(page.hits[0].match.agent), ['Sales'])
  assert.equal(page.hits[0].match.snippet, null)
  assert.deepEqual(searchConversationList(list, '   ', 10).hits, [])
})

test('날: 오늘은 시각, 어제, 올해는 월·일, 그 전은 연·월·일', () => {
  const now = new Date(2026, 9, 10, 15, 0)
  assert.equal(conversationDayLabel(new Date(2026, 9, 10, 9, 5).toISOString(), now), '09:05')
  assert.equal(conversationDayLabel(new Date(2026, 9, 9, 23, 0).toISOString(), now), '어제')
  assert.equal(conversationDayLabel(new Date(2026, 9, 5, 12, 0).toISOString(), now), '10월 5일')
  assert.equal(conversationDayLabel(new Date(2025, 0, 2, 12, 0).toISOString(), now), '2025. 1. 2.')
  assert.equal(conversationDayLabel(null, now), '')
  assert.equal(conversationDayLabel('nope', now), '')
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

test('검색: 새 API 를 검색어·수와 함께 부르고 결과를 읽는다', async () => {
  const { api, calls } = fakeHttp({
    'GET /api/interaction/conversations/search': {
      query: 'intj',
      terms: ['intj'],
      has_more: true,
      results: [
        {
          interaction_id: 'chat-1',
          workflow_id: 'wf',
          title: '궁금',
          match: { snippet: [{ text: 'INTJ', hit: true }], snippet_from: 'output' },
        },
      ],
    },
  })
  const page = await api.searchConversations(' intj ', { limit: 20 })
  const url = new URL(calls[0], 'http://x')
  assert.equal(url.searchParams.get('q'), 'intj')
  assert.equal(url.searchParams.get('limit'), '20')
  assert.equal(page.hits.length, 1)
  assert.equal(page.hasMore, true)
  assert.equal(page.contentSearched, true)
})

test('검색: 빈 검색어는 서버에 묻지 않는다', async () => {
  const { api, calls } = fakeHttp({})
  const page = await api.searchConversations('  ')
  assert.deepEqual(page.hits, [])
  assert.equal(calls.length, 0)
})

test('검색: 검색 API 가 없는 옛 서버(404)는 대화 목록의 제목·이름으로 찾는다', async () => {
  const { api } = fakeHttp({
    'GET /api/interaction/conversations': {
      conversations: [
        { interaction_id: 'a', workflow_id: 'wf', workflow_name: 'Sales Agent', title: '분기 매출' },
        { interaction_id: 'b', workflow_id: 'wf', workflow_name: 'HR', title: '휴가' },
      ],
      next_cursor: null,
    },
  })
  const page = await api.searchConversations('매출')
  assert.deepEqual(page.hits.map((h) => h.conversation.interactionId), ['a'])
  assert.equal(page.contentSearched, false)
})

test('검색: 404 가 아닌 실패는 그대로 올린다', async () => {
  const { api } = fakeHttp({ 'GET /api/interaction/conversations/search': new ApiError(500, 'boom', null) })
  await assert.rejects(() => api.searchConversations('매출'), /boom/)
})
