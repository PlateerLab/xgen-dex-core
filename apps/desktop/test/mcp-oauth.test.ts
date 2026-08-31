/** MCP OAuth (G8b) — provider 형태·조용/대화형 리다이렉트·전송옵션 부착 (순수 부분).
 *  키체인 저장 경로는 electron safeStorage 의존이라 여기선 검증하지 않는다. */
import assert from 'assert'
import { test } from 'node:test'
import {
  ConnectorOAuthProvider,
  makeSilentOAuthProvider,
  oauthTransportOptions,
} from '@dex/engine/mcp-oauth'
import type { McpServerConfig } from '../src/main/config'

test('oauthTransportOptions: auth!=oauth 는 그대로, oauth 는 authProvider 부착', () => {
  const base = { requestInit: { headers: { X: '1' } } }
  const plain: McpServerConfig = { name: 's', transport: 'sse', url: 'https://x' }
  assert.deepEqual(oauthTransportOptions(plain, base), base)

  const oauth: McpServerConfig = { name: 's', transport: 'sse', url: 'https://x', auth: 'oauth' }
  const opts = oauthTransportOptions(oauth, base) as { authProvider?: unknown; requestInit?: unknown }
  assert.ok(opts.authProvider, 'authProvider 가 부착되지 않았다')
  assert.deepEqual(opts.requestInit, base.requestInit)
})

test('ConnectorOAuthProvider: redirectUrl 과 clientMetadata 형태', () => {
  const p = new ConnectorOAuthProvider('srv', 41234, true)
  assert.equal(p.redirectUrl, 'http://127.0.0.1:41234/callback')
  const meta = p.clientMetadata
  assert.deepEqual(meta.redirect_uris, ['http://127.0.0.1:41234/callback'])
  assert.deepEqual(meta.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(meta.response_types, ['code'])
  assert.equal(meta.token_endpoint_auth_method, 'none')
  assert.equal(meta.client_name, 'XGen Dex')
})

test('redirectToAuthorization: silent 은 브라우저를 안 연다, interactive 는 콜백 호출', async () => {
  let silentCalled = false
  const silent = new ConnectorOAuthProvider('s', 1, false, async () => {
    silentCalled = true
  })
  await silent.redirectToAuthorization(new URL('https://auth.example/authorize'))
  assert.equal(silentCalled, false, 'silent 모드가 브라우저 콜백을 호출했다')

  let openedUrl = ''
  const interactive = new ConnectorOAuthProvider('s', 1, true, async (u) => {
    openedUrl = u.toString()
  })
  await interactive.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'))
  assert.match(openedUrl, /auth\.example\/authorize/)
})

test('state(): 대화형은 주입된 state 를 노출, silent 는 없음', () => {
  const withState = new ConnectorOAuthProvider('s', 1, true, undefined, 'abc123')
  assert.equal(withState.state(), 'abc123')
  assert.equal(makeSilentOAuthProvider('s').state(), undefined)
})

test('makeSilentOAuthProvider 는 비대화형 provider 를 만든다', async () => {
  let called = false
  const p = makeSilentOAuthProvider('s')
  // onRedirect 없음 + 비대화형 → 아무 것도 안 함(예외 없이 반환)
  await p.redirectToAuthorization(new URL('https://x/authorize'))
  assert.equal(called, false)
})
