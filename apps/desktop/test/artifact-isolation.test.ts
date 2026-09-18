/**
 * 아티팩트 격리의 **소스 계약** — 실행 테스트가 못 잡는 회귀를 여기서 잡는다.
 *
 * verify/artifact-frame-smoke.cjs 는 진짜 Electron 에서 "렌더된다 · 오리진이 없다 ·
 * 네트워크가 없다 · alias 왕복이 된다" 를 확인한다. 그런데 실측해 보니 그 테스트는
 * **자물쇠 하나가 빠져도 통과한다**:
 *
 *   · `sandbox` 에서 allow-same-origin 을 빼든 넣든 부모 접근은 어차피 막힌다
 *     (프레임이 xgenartifact:// 라 스킴부터 다르다).
 *   · `standard: true` 만 켜도 오리진은 여전히 없다.
 *
 * 프레임이 오리진을 되찾아 `document.cookie` 가 열리는 것은 **둘 다 틀렸을 때**뿐이다.
 * 즉 한 번에 하나씩 들어오는 실수는 실행 테스트에 안 잡히고, 그 상태로 몇 달 뒤
 * 나머지 하나가 들어오면 그때 조용히 열린다. 그래서 각 자물쇠를 개별로 못박는다.
 *
 * 여기서 검사하는 것은 전부 "이 문자열이 소스에 있다/없다" 다 — 값싸고, 사람이
 * 실수하는 바로 그 지점에 있다.
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { test } from 'node:test'

import { stripFrameAncestors, stripFrameAncestorsFromHeaders } from '../src/main/artifact-csp'

const root = join(__dirname, '..')
const raw = (p: string): string => readFileSync(join(root, p), 'utf8')

/**
 * 주석을 걷어낸 **코드만** 돌려준다.
 *
 * 이 파일이 검사하는 것들은 하나같이 주석에서도 이름이 불린다 — 그 자물쇠가 왜
 * 있는지 적어 두는 것이 이 저장소의 방식이라서다. 원문 그대로 검사하면 "왜
 * allow-same-origin 을 쓰지 않는가" 를 설명하는 문장이 곧 위반으로 잡힌다
 * (실제로 처음에 그렇게 잡혔다). 검사는 사실을 봐야지 설명을 보면 안 된다.
 */
const read = (p: string): string =>
  raw(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')

const FRAME_COMPONENT = 'src/renderer/src/artifacts/ArtifactFrame.tsx'
const MAIN = 'src/main/index.ts'
const FRAME_DOC = 'src/main/artifact-frame.html'
const FRAME_CSP = 'src/main/artifact-frame.ts'
const RENDERER_HTML = 'src/renderer/index.html'

test('아티팩트 iframe 에 allow-same-origin 이 없다 — 두 번째 자물쇠', () => {
  const src = read(FRAME_COMPONENT)
  assert.ok(
    src.includes('sandbox="allow-scripts"'),
    'iframe 에서 sandbox="allow-scripts" 가 사라졌다',
  )
  assert.ok(
    !src.includes('allow-same-origin'),
    'allow-same-origin 이 들어왔다 — standard:true 와 함께면 프레임이 쿠키를 얻는다',
  )
})

test('아티팩트 스킴은 standard 도 bypassCSP 도 아니다 — 세 번째 자물쇠', () => {
  const src = read(MAIN)
  const at = src.indexOf("scheme: 'xgenartifact'")
  assert.ok(at > 0, 'xgenartifact 스킴 등록이 사라졌다')
  // **이 스킴 블록만** 본다. 바로 뒤에 오는 xgenavatar 는 일부러 standard·bypassCSP
  // 를 쓰므로(아바타 에셋 프록시), 고정 길이로 잘라 보면 남의 설정을 우리 것으로
  // 읽는다 — 다음 `scheme:` 앞에서 끊는다.
  const rest = src.slice(at + 1)
  const next = rest.indexOf('scheme:')
  const block = next < 0 ? rest : rest.slice(0, next)
  assert.ok(!/standard:\s*true/.test(block), 'xgenartifact 에 standard:true 가 들어왔다')
  assert.ok(!/bypassCSP:\s*true/.test(block), 'xgenartifact 에 bypassCSP 가 들어왔다 — CSP 를 받아야 한다')
})

test('프레임 CSP 는 네트워크를 닫는다 — 헤더와 문서 양쪽', () => {
  const csp = read(FRAME_CSP)
  assert.ok(csp.includes("connect-src 'none'"), '응답 헤더 CSP 에서 connect-src 가 열렸다')
  assert.ok(csp.includes("default-src 'none'"), '응답 헤더 CSP 의 default-src 가 열렸다')

  // 문서 안의 meta 는 헤더가 사라져도 남는 이중 잠금이다.
  const doc = read(FRAME_DOC)
  const meta = doc.slice(doc.indexOf('http-equiv="Content-Security-Policy"'))
  assert.ok(meta.includes("connect-src 'none'"), '프레임 문서의 meta CSP 에서 connect-src 가 열렸다')
})

test('프레임 문서는 외부 리소스를 한 줄도 부르지 않는다', () => {
  const doc = read(FRAME_DOC)
  // 불투명 오리진에서는 'self' 가 아무 것도 안 가리키므로 외부 참조는 전부 죽는다.
  // 조용히 죽는 참조를 남기지 않기 위해 아예 없어야 한다.
  assert.ok(!/<script[^>]+\bsrc=/.test(doc), '프레임 문서가 외부 스크립트를 부른다')
  assert.ok(!/<link[^>]+\bhref=/.test(doc), '프레임 문서가 외부 스타일시트를 부른다')
})

test('렌더러 CSP 는 띄우는 것만 연다 — 프레임은 되고, 네트워크는 안 된다', () => {
  const html = read(RENDERER_HTML)
  const frameSrc = /frame-src([^"]*)/.exec(html)?.[1] ?? ''
  assert.ok(frameSrc.includes('xgenartifact:'), '격리 프레임 스킴이 사라졌다')
  // 에이전트가 띄운 앱은 **설정된 서버 주소 그대로** 연다. 정적 문서인 CSP 는 그
  // 오리진을 미리 적을 수 없어 스킴으로 연다. 이 줄이 없으면 요청조차 나가지 않고
  // 탭이 빈 화면이 된다(2026-09-18 실증).
  assert.ok(frameSrc.includes('https:'), 'frame-src 에서 https 가 빠지면 [아티팩트] 탭이 빈다')
  assert.ok(frameSrc.includes('http:'), '사내망·IP·localhost 서버는 http 다')
  assert.ok(!frameSrc.includes('*'), '렌더러 frame-src 에 와일드카드가 들어왔다')

  // 문서를 **띄우는 것**과 이 창이 네트워크로 **말하는 것**은 다른 일이다.
  // 프레임은 서버 오리진이라 교차 출처이고 window.xgen 에 닿지 못한다. 그러나
  // connect-src 가 열리면 이 창(그 다리가 있는 곳)이 직접 말하게 된다.
  const connectSrc = /connect-src([^;"]*)/.exec(html)?.[1] ?? ''
  assert.ok(connectSrc.length > 0, 'connect-src 가 사라졌다 — default-src 로 흘러가면 안 된다')
  for (const scheme of ['https:', 'http:', '*']) {
    assert.ok(
      !connectSrc.includes(scheme),
      `렌더러 connect-src 에 ${scheme} 가 들어왔다 — 이 창은 네트워크로 직접 말하지 않는다`,
    )
  }
})

test('프레임은 호스트가 준 것만 실행한다 — alias 는 고르지 못한다', () => {
  const doc = read(FRAME_DOC)
  // 프레임이 경로를 스스로 만들어 부르는 길이 없어야 한다. 부탁은 alias 로만 한다.
  assert.ok(doc.includes("type: 'artifact:fetch'"), 'alias 부탁 통로가 사라졌다')
  assert.ok(!doc.includes('XMLHttpRequest'), '프레임이 XHR 을 쓴다')
  // 실제 호출은 호스트(main)가 선언을 확인한 뒤에만 한다.
  const api = readFileSync(join(root, '../../packages/protocol/src/agent-data.ts'), 'utf8')
  assert.ok(
    api.includes('선언되지 않은 alias 입니다'),
    'artifactCallApi 의 선언 검사가 사라졌다',
  )
  assert.ok(api.includes("if (decl.method !== 'GET')"), 'artifactCallApi 가 GET 이외를 허용한다')
})

// ── 사이트 아티팩트 (폴더가 곧 웹사이트인 것) ─────────────────────────
//
// 프레임과 성질이 반대다. 프레임은 오리진도 네트워크도 없어야 하고, 사이트는
// 진짜 웹사이트라 둘 다 필요하다. 그래서 스킴을 따로 판다 — 같은 스킴에 두
// 성질을 섞으면 한쪽의 자물쇠가 다른 쪽에서 풀린다.

test('아티팩트 요청에만 자격을 싣는다 — 다른 호스트로는 한 글자도 나가지 않는다', () => {
  // 주석을 걷어낸 사본으로 보면 안 된다: URL 필터의 `//*` 가 블록 주석 시작으로
  // 읽혀 이 구간이 통째로 지워진다(같은 함정을 Accept 헤더에서 한 번 겪었다).
  const main = raw('src/main/index.ts')
  const at = main.indexOf('WEBREQUEST_URL_FILTER = {')
  assert.ok(at > 0, 'webRequest 필터를 찾지 못했다')
  const hook = [main.slice(at, at + 1400)]
  assert.match(hook[0], /details\.url\.startsWith\(`\$\{server\}\/api\//, '설정된 서버로만 붙여야 한다')
  assert.match(hook[0], /Authorization/)
  assert.match(hook[0], /wss:\/\/\*\/api\/\*/, 'WebSocket 업그레이드에도 붙어야 실시간 앱이 산다')
})

test('회전한 토큰이 아티팩트 요청에도 반영된다', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /onTokensRotated:[\s\S]*?lastAccessToken = access/, '옛 토큰을 붙이면 그 화면만 403 에 갇힌다')
})

test('앱은 아티팩트를 서버 주소 그대로 연다 — 웹과 같은 base·같은 상대 경로', () => {
  const frame = read('src/renderer/src/artifacts/ArtifactSiteFrame.tsx')
  assert.match(frame, /\/api\/agentflow\/agent-artifacts\//)
  assert.match(frame, /serverUrl/, '서버 주소를 모르면 열지 않는다')
  const view = read('src/renderer/src/artifacts/ArtifactsView.tsx')
  assert.match(view, /kind === 'service'/, '에이전트가 띄운 앱을 열지 못하면 빈 화면이 된다')
  assert.match(view, /ArtifactSiteFrame/)
})

// ── 부모가 렌더러라서 생기는 한 줄 (2026-09-18) ──────────────────────
//
// 앱의 [아티팩트] 탭이 **빈 화면**이었다. 새 창으로는 멀쩡히 열렸다. 서버는 사설
// 앱에 `frame-ancestors 'self'` 를 붙이는데, 웹에서는 부모(웹 앱)와 오리진이 같아
// 통과하고 앱에서는 부모가 렌더러라 오리진이 달라 브라우저가 프레임을 거부한다.
// 전용 스킴으로 중계하던 시절에는 그 핸들러가 떼고 있었는데, WebSocket 때문에
// 서버 주소를 그대로 여는 길로 옮기면서 이 한 줄이 같이 오지 않았다.

test('frame-ancestors 만 걷어낸다 — 나머지 CSP 는 그대로', () => {
  assert.equal(stripFrameAncestors("frame-ancestors 'self'"), '')
  assert.equal(
    stripFrameAncestors("sandbox allow-scripts; frame-ancestors 'self'"),
    'sandbox allow-scripts',
    '공개 앱의 sandbox 는 살아 있어야 한다 — 격리를 정하는 쪽은 서버다',
  )
  assert.equal(
    stripFrameAncestors("default-src 'none'; Frame-Ancestors https://x; img-src data:"),
    "default-src 'none'; img-src data:",
    '대소문자가 달라도 같은 지시자다',
  )
  assert.equal(
    stripFrameAncestors("frame-src 'self'"),
    "frame-src 'self'",
    'frame-src 는 이름이 비슷할 뿐 다른 지시자다 — 지우면 안 된다',
  )
})

test('응답 헤더에서도 같은 일을 한다 — 헤더 이름 대소문자와 무관하게', () => {
  const out = stripFrameAncestorsFromHeaders({
    'Content-Security-Policy': ["sandbox allow-scripts; frame-ancestors 'self'"],
    'content-type': ['text/html'],
  })
  assert.deepEqual(out['Content-Security-Policy'], ['sandbox allow-scripts'])
  assert.deepEqual(out['content-type'], ['text/html'], '남의 헤더는 건드리지 않는다')

  // 남길 것이 없으면 헤더 자체를 지운다 — 빈 CSP 를 남기면 브라우저마다 해석이 다르다.
  const gone = stripFrameAncestorsFromHeaders({ 'content-security-policy': ["frame-ancestors 'self'"] })
  assert.ok(!('content-security-policy' in gone), '빈 CSP 헤더가 남았다')
})

test('앱이 여는 아티팩트 응답에서 frame-ancestors 를 뗀다 — 안 떼면 빈 화면이다', () => {
  const main = raw('src/main/index.ts')
  const at = main.indexOf('onHeadersReceived')
  assert.ok(at > 0, 'onHeadersReceived 가 사라졌다 — 서버의 frame-ancestors 가 그대로 오면 탭이 빈다')
  const hook = main.slice(at, at + 900)
  assert.match(hook, /WEBREQUEST_URL_FILTER/, '자격을 싣는 곳과 같은 범위여야 한다')
  assert.match(hook, /details\.url\.startsWith\(`\$\{server\}\/api\//, '설정된 서버의 응답에만 손댄다')
  assert.match(hook, /stripFrameAncestorsFromHeaders/)
})
