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

test('렌더러 CSP 는 아티팩트 프레임만 허용한다', () => {
  const html = read(RENDERER_HTML)
  assert.ok(html.includes('frame-src xgenartifact:'), '렌더러 CSP 에서 frame-src 가 사라졌다')
  // 다른 것을 프레임으로 띄울 길을 열어 두지 않는다.
  assert.ok(!/frame-src[^"]*\*/.test(html), '렌더러 frame-src 에 와일드카드가 들어왔다')
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
