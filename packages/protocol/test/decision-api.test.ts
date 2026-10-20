/**
 * 판단 모델 API — 커넥터는 판단 모델 서버를 직접 부르지 않고 로그인 토큰으로 xgen-core 를 부른다.
 *
 * 지키는 것: 경로·본문이 core 계약(`POST /api/base/v1/decision/systemone {state, questions}`)과 같고,
 * 실패는 상태 코드째 던져 호출자가 고를 수 있게 한다(503 = 판단 모델 없음 → 서버 에이전트로).
 * 빠른 조작은 실패하면 다른 길로 가므로 `auth: false` 면 401 이 로그아웃으로 번지지 않아야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { ApiError, HttpClient } from '@dex/protocol/client'
import { DECISION_SYSTEMONE_PATH, DecisionApi } from '@dex/protocol/decision'

interface Seen {
  url: string
  method?: string
  headers: Record<string, string>
  body: unknown
}

function client(status: number, payload: unknown) {
  const seen: Seen[] = []
  let authFailures = 0
  const http = new HttpClient({
    baseUrl: 'https://xgen.example.com/',
    fetch: async (url, init) => {
      seen.push({
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(payload), { status })
    },
    onAuthFailure: () => {
      authFailures += 1
    },
  })
  http.setToken('tok')
  return { api: new DecisionApi(http), seen, authFailures: () => authFailures }
}

const QUESTIONS = { q: { type: 'choice' as const, instructions: '어느 요소?', criteria: { a: '검색', b: '로그인' } } }

test('core 판단 API 를 토큰과 함께 부르고 답을 그대로 돌려준다', async () => {
  const answers = { q: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }
  const { api, seen } = client(200, { model: 'decider', answers, usage: { input_tokens: 120, output_tokens: 0 } })
  const res = await api.systemone('화면', QUESTIONS)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `https://xgen.example.com${DECISION_SYSTEMONE_PATH}`)
  assert.equal(DECISION_SYSTEMONE_PATH, '/api/base/v1/decision/systemone')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].headers.Authorization, 'Bearer tok')
  assert.deepEqual(seen[0].body, { state: '화면', questions: QUESTIONS })
  assert.deepEqual(res.answers, answers)
  assert.equal(res.model, 'decider')
})

test('판단 모델이 없으면 503 을 상태째 던진다', async () => {
  const { api } = client(503, { error: "판단 모델 'decider' 이 로드되어 있지 않습니다" })
  await assert.rejects(api.systemone('화면', QUESTIONS), (err: unknown) => err instanceof ApiError && err.status === 503)
})

test('auth: false 면 401 이 로그아웃 처리로 번지지 않는다', async () => {
  const quiet = client(401, { detail: 'Unauthorized' })
  await assert.rejects(quiet.api.systemone('화면', QUESTIONS, { auth: false }), (err: unknown) => err instanceof ApiError && err.status === 401)
  assert.equal(quiet.authFailures(), 0)
  const loud = client(401, { detail: 'Unauthorized' })
  await assert.rejects(loud.api.systemone('화면', QUESTIONS))
  assert.equal(loud.authFailures(), 1)
})

test('판단 모델 선택지는 카탈로그의 켜진 판단 모델만, 지금 값은 DECISION_MODEL 에서', async () => {
  const seen: string[] = []
  const http = new HttpClient({
    baseUrl: 'https://xgen.example.com',
    fetch: async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`)
      const body = url.endsWith('/api/admin/llm-catalog')
        ? {
            items: [
              { provider: 'openrouter', model_id: 'typesafe/jev-1.14', display_name: 'Jev 1.14', enabled: true, capabilities: { kind: 'decision' } },
              { provider: 'openrouter', model_id: 'typesafe/jev-1.13', enabled: false, capabilities: { kind: 'decision' } },
              { provider: 'openai', model_id: 'gpt-4o', enabled: true, capabilities: {} },
            ],
          }
        : url.endsWith('/api/config/persistent')
          ? { persistent_summary: { configs: [{ env_name: 'DECISION_MODEL', current_value: 'openrouter/typesafe/jev-1.14' }] } }
          : {}
      return new Response(JSON.stringify(body), { status: 200 })
    },
  })
  const api = new DecisionApi(http)
  const state = await api.model()
  assert.equal(state.current, 'openrouter/typesafe/jev-1.14')
  assert.deepEqual(state.choices.map((c) => c.value), ['', 'openrouter/typesafe/jev-1.14'])
  assert.deepEqual((await new DecisionApi(new HttpClient({
    baseUrl: 'https://x',
    fetch: async (url) => new Response(JSON.stringify(url.endsWith('persistent')
      ? { persistent_summary: { configs: [{ env_name: 'DECISION_MODEL', current_value: 'openrouter/typesafe/jev-1.13' }] } }
      : { items: [] })),
  })).model()).choices.map((c) => c.value), ['', 'openrouter/typesafe/jev-1.13'])
  await api.setModel('')
  assert.equal(seen.at(-1), 'PUT https://xgen.example.com/api/config/persistent/DECISION_MODEL {"value":""}')
})

test('권한이 없으면 던지고 로그아웃으로 번지지 않는다', async () => {
  const c = client(403, { detail: 'Permission denied' })
  await assert.rejects(c.api.model(), (err: unknown) => err instanceof ApiError && err.status === 403)
  const u = client(401, { detail: 'Unauthorized' })
  await assert.rejects(u.api.model())
  assert.equal(u.authFailures(), 0)
})
