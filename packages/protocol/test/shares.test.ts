/**
 * 공유(shares): 채팅 공유 API 가 웹과 **같은 엔드포인트·같은 몸통**을 쓰는지, 그리고 공유 문구가 사람의 말인지.
 *
 * 데스크톱·모바일·웹이 다른 경로나 다른 키를 보내면 같은 대화의 같은 시점이 서로 다른 링크가 된다.
 */
import assert from 'assert'
import { test } from 'node:test'
import {
  APP_SHARE_TEXT,
  CHAT_SHARE_TEXT,
  ChatSharesApi,
  shareLinkUrl,
  toShareAudience,
} from '@dex/protocol/shares'

function fakeHttp(reply: unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown; opts?: unknown }> = []
  const http = {
    get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path })
      return Promise.resolve(reply as T)
    },
    post<T>(path: string, body?: unknown, opts?: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body, opts })
      return Promise.resolve(reply as T)
    },
    del<T>(path: string): Promise<T> {
      calls.push({ method: 'DELETE', path })
      return Promise.resolve(reply as T)
    },
  }
  return { api: new ChatSharesApi(http as never), calls }
}

test('공유 상태는 /api/chat/shares/state 하나로 읽고 빠진 칸을 채운다', async () => {
  const { api, calls } = fakeHttp({
    checkpoint: { last_io_id: 12, turn_count: 3 },
    running: true,
    share: { token: 'T1', path: '/share/chat/T1', audience: 'public', include_process: false, turn_count: 3 },
    previous: [{ token: 'T0', audience: 'weird' }, null],
  })
  const st = await api.state('wf 1', 'c/1')
  const url = new URL(calls[0].path, 'http://x')
  assert.equal(url.pathname, '/api/chat/shares/state')
  assert.equal(url.searchParams.get('workflow_id'), 'wf 1')
  assert.equal(url.searchParams.get('interaction_id'), 'c/1')
  assert.equal(st.running, true)
  assert.equal(st.share?.audience, 'public')
  assert.equal(st.share?.include_process, false)
  assert.equal(st.share?.include_files, true, '빠진 선택은 기본(켜짐)')
  assert.equal(st.previous.length, 1)
  assert.equal(st.previous[0].audience, 'users', '모르는 범위는 좁은 쪽으로 읽는다')
  assert.equal(st.previous[0].path, '/share/chat/T0')
})

test('링크 만들기는 웹과 같은 몸통(snake_case)을 보내고 넉넉히 기다린다', async () => {
  const { api, calls } = fakeHttp({ ok: true, share: { token: 'T2', path: '/share/chat/T2', audience: 'users' }, reused: true })
  const res = await api.create({
    workflowId: 'wf', interactionId: 'c1', audience: 'users', includeProcess: true, includeFiles: false,
  })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].path, '/api/chat/shares')
  assert.deepEqual(calls[0].body, {
    workflow_id: 'wf', interaction_id: 'c1', audience: 'users', include_process: true, include_files: false,
  })
  assert.ok(((calls[0].opts as { timeoutMs?: number })?.timeoutMs ?? 0) >= 60_000, '파일을 얼리는 동안 끊지 않는다')
  assert.equal(res.share.token, 'T2')
  assert.equal(res.reused, true)
})

test('링크가 없는 응답은 오류다(빈 링크를 사람에게 주지 않는다)', async () => {
  const { api } = fakeHttp({ ok: true })
  await assert.rejects(() => api.create({
    workflowId: 'wf', interactionId: 'c1', audience: 'public', includeProcess: true, includeFiles: true,
  }))
})

test('끊기는 DELETE /api/chat/shares/{token}', async () => {
  const { api, calls } = fakeHttp({ ok: true })
  await api.revoke('a/b')
  assert.deepEqual(calls[0], { method: 'DELETE', path: '/api/chat/shares/a%2Fb' })
})

test('공유 링크 주소와 범위 읽기', () => {
  assert.equal(shareLinkUrl('https://x.example/', '/share/chat/T'), 'https://x.example/share/chat/T')
  assert.equal(shareLinkUrl('https://x.example', 'share/app/a'), 'https://x.example/share/app/a')
  assert.equal(shareLinkUrl('https://x.example', ''), '')
  assert.equal(toShareAudience('public'), 'public')
  assert.equal(toShareAudience(undefined), 'users')
})

test('공유 문구는 사람의 말이다(줄표·내부 용어 없음)', () => {
  const texts: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') texts.push(v)
    else if (typeof v === 'function') texts.push(String((v as (...a: unknown[]) => string)(2, 'users', '어제')))
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(APP_SHARE_TEXT)
  walk(CHAT_SHARE_TEXT)
  for (const text of texts) assert.doesNotMatch(text, /\u2014|audience|token|snapshot|workflow/, text)
  assert.equal(CHAT_SHARE_TEXT.intro(4).includes('4턴'), true)
})
