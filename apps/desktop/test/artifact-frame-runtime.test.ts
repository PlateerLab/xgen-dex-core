/**
 * 아티팩트 실행 프레임의 **런타임 계약** — 웹(xgen-frontend)과 같은 사실을 지킨다.
 *
 * 이 프레임 문서는 웹 `apps/web/public/artifact-frame.html` 의 복사본이다. 문서
 * 머리말에 "한쪽을 고치면 다른 쪽도 옮긴다" 고 적혀 있는데, 2026-09-11 에 웹만
 * 고치고 여기를 빠뜨려서 **앱에서는 아티팩트가 계속 깨졌다.** 그래서 같은 성질을
 * 여기서도 못박는다 — 다음에 한쪽만 고치면 이 파일이 막는다.
 *
 * 1. 실행 스코프 — 훅을 new Function 의 **매개변수로 주지 않는다**
 * ----------------------------------------------------------------
 * 매개변수와 본문 최상위의 const/let 은 같은 스코프라, 같은 이름을 다시 선언하면
 * 문법 오류다. 그런데 하필 그 재선언이 CDN React 의 표준 첫 줄이다:
 *
 *     const { useState, useEffect } = React;
 *
 * 즉 드문 입력이 아니라 **모델이 가장 자주 쓰는 첫 줄**이 하드 실패였다. 실제
 * 사용자 화면(크로미움으로 이 문서를 그대로 띄워 재현):
 *
 *     SyntaxError: Identifier 'useState' has already been declared
 *         at run (xgenartifact://frame/:147:21)
 *
 * 전역에 두면 스코프 사슬 한 칸 밖이라 본문의 선언이 **가리기만** 한다.
 *
 * 2. 크기 — 높이 협상을 두지 않는다
 * ---------------------------------
 * 프레임이 내용 높이를 알리고 호스트가 그만큼 iframe 을 키우면, 100vh 를 쓰는
 * 아티팩트(대시보드의 기본 뼈대)에서 내용 높이가 다시 프레임 높이에 의존한다 —
 * 이득 1 이상의 양의 되먹임이라 재는 방법을 고쳐도 멈추지 않는다(웹 실측:
 * minHeight:100vh + padding:32 대시보드가 4초에 15,076px → 상한 20,000px).
 * 그래서 iframe 을 절대 위치로 흐름 밖에 두고, 높이는 바깥에서만 받는다.
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { test } from 'node:test'

const root = join(__dirname, '..')

/** 주석은 걷어낸다 — 위 설명처럼 주석에서 옛 코드를 인용하기 때문이다. */
const read = (p: string): string =>
  readFileSync(join(root, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')

const FRAME_DOC = 'src/main/artifact-frame.html'
const FRAME_COMPONENT = 'src/renderer/src/artifacts/ArtifactFrame.tsx'
const STYLES = 'src/renderer/src/styles.css'

// ── 1. 실행 스코프 ────────────────────────────────────────────────────

const MUST_NOT_BE_PARAMS = [
  'React', 'Fragment', 'xgen',
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'useContext',
]

function frameArgNames(): string[] {
  const m = /var argNames = \[([\s\S]*?)\];/.exec(read(FRAME_DOC))
  assert.ok(m, 'argNames 배열을 찾지 못했다 — 이름이 바뀌었으면 이 테스트도 고쳐라')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

test('훅과 React 를 new Function 매개변수로 주지 않는다', () => {
  const args = frameArgNames()
  for (const name of MUST_NOT_BE_PARAMS) {
    assert.ok(
      !args.includes(name),
      `'${name}' 이 매개변수로 돌아왔다 — 아티팩트가 "const { ${name} } = React" 를 쓰는 순간 ` +
        'SyntaxError 로 한 줄도 못 돈다. 전역(globalThis)에 두어라.',
    )
  }
})

test('매개변수는 CommonJS 출력이 쓰는 셋뿐이다', () => {
  assert.deepStrictEqual(frameArgNames(), ['exports', 'module', 'require'])
})

test('프레임이 훅을 전역에 싣는다', () => {
  const js = read(FRAME_DOC)
  assert.match(js, /globalThis\[k\] = EXPOSED\[k\]/,
    '전역에 싣지 않으면 import 없이 훅을 쓰는 코드가 ReferenceError 로 죽는다')
  assert.match(js, /'useState'/)
})

// ── 2. 크기 ───────────────────────────────────────────────────────────

test('프레임은 자기 높이를 호스트에 알리지 않는다', () => {
  const js = read(FRAME_DOC)
  assert.doesNotMatch(js, /artifact:height/,
    '높이를 알리는 순간 호스트가 그 값으로 프레임을 키우고, 100vh 아티팩트는 다시 커진다')
  assert.doesNotMatch(js, /ResizeObserver/)
})

test('호스트는 아티팩트가 말한 높이로 프레임을 키우지 않는다', () => {
  const host = read(FRAME_COMPONENT)
  assert.doesNotMatch(host, /artifact:height/)
  assert.doesNotMatch(host, /setHeight/)
})

test('iframe 은 흐름 밖에 있다 — 상자 높이에 영향을 줄 수 없다', () => {
  const host = read(FRAME_COMPONENT)
  assert.match(host, /artifact-frame-box/, '절대 위치의 기준이 되는 상자가 필요하다')
  const css = read(STYLES)
  const box = css.slice(css.indexOf('.artifact-frame-box'))
  assert.match(box, /position:\s*absolute/,
    '흐름 안에 있으면 내용이 상자를 밀고, 그 상자가 다시 내용을 민다')
  assert.match(box, /inset:\s*0/)
})

test('프레임을 담는 무대는 flex 열이고 바깥에서 스크롤하지 않는다', () => {
  const css = read(STYLES)
  const stage = css.slice(css.indexOf('.artifacts-stage'), css.indexOf('.artifact-frame-host'))
  assert.match(stage, /display:\s*flex/,
    '블록이면 안쪽 flex 가 높이를 못 받아 프레임이 minHeight 로 주저앉는다')
  assert.match(stage, /flex-direction:\s*column/)
  assert.doesNotMatch(stage, /overflow:\s*auto/,
    '프레임 안이 스크롤하므로 바깥에서 또 스크롤하면 스크롤바가 둘이 된다')
})

test('프레임 문서는 100% 를 받을 수 있다', () => {
  const css = readFileSync(join(root, FRAME_DOC), 'utf8')
  assert.match(css, /html, body \{[^}]*height: 100%/)
  assert.match(css, /#root \{[^}]*min-height: 100%/)
})

// ── 3. 라이브러리 — 앱에서도 차트가 그려져야 한다 ─────────────────────
//
// "'recharts' 은(는) 아티팩트에서 쓸 수 없습니다" 로 화면이 통째로 죽던 자리다.
// 폐쇄망이라 CDN 이 없으니 플랫폼이 미리 만들어 두고, 호스트가 소스에서 필요한
// 것만 골라 프레임에 실어 준다. **웹과 같은 번들·같은 목록**이어야 한다 —
// 갈라지면 "웹에서는 되는데 앱에서는 안 되는" 아티팩트가 생긴다.

const SHIPPED_LIBS = ['recharts', 'lucide-react', 'd3', 'date-fns', 'clsx']

test('프레임이 실어 준 라이브러리를 해석한다', () => {
  const doc = read(FRAME_DOC)
  assert.match(doc, /__ARTIFACT_LIBS__/, '프레임이 라이브러리 레지스트리를 보지 않는다')
  assert.match(doc, /Object\.keys\(libs\)\.forEach/, '프레임이 전달받은 번들을 세우지 않는다')
  assert.match(
    doc,
    /hasOwnProperty\.call\(LIBS, key\)/,
    'requireShim 이 라이브러리를 찾지 않는다 — import 한 순간 죽는다',
  )
})

test('호스트가 소스에 있는 라이브러리만 실어 보낸다', () => {
  const host = read(FRAME_COMPONENT)
  for (const name of SHIPPED_LIBS) {
    assert.ok(host.includes(`'${name}'`), `${name} 로더가 없다`)
    assert.ok(
      host.includes(`runtime/libs/${name}.js.txt?raw`),
      `${name} 번들을 동적 import 하지 않는다 — 앱 시작에 전부 실린다`,
    )
  }
  assert.match(host, /libs,/, 'init 메시지에 libs 를 싣지 않는다')
})

test('실어 보낸다고 적어 놓은 번들이 실제로 있다', () => {
  for (const name of SHIPPED_LIBS) {
    const file = join(root, 'src/renderer/src/artifacts/runtime/libs', `${name}.js.txt`)
    assert.ok(readFileSync(file, 'utf8').length > 100, `${name} 번들이 비었다`)
  }
})

// ── 4. fetch 가 된다 — 프레임의 요청을 호스트가 대신 부른다 ─────────────
//
// 사용자가 본 화면: "⚠️ 오류 발생: Failed to fetch". 프레임에는 네트워크가
// 없어서 fetch 한 줄이 곧 그 오류였다. 네트워크를 열지 않고(그 격리가 토큰을
// 지킨다) 호스트가 대신 부른다. 웹과 같은 성질을 여기서도 못박는다.

test('프레임이 fetch 를 호스트로 넘긴다', () => {
  const doc = read(FRAME_DOC)
  assert.match(doc, /globalThis\.fetch = bridgedFetch/, 'fetch 를 바꿔치지 않으면 아티팩트의 fetch 는 그대로 죽는다')
  assert.match(doc, /type: 'artifact:http'/)
  assert.match(doc, /artifact:http-result/)
  assert.match(doc, /__xgen\/fetch/, '바깥으로 나가려는 요청은 무엇을 쓰면 되는지 말해야 한다')
})

test('호스트가 그 요청을 우리 자격으로 대신 부른다', () => {
  const host = read(FRAME_COMPONENT)
  assert.match(host, /msg\.type === 'artifact:http'/)
  assert.match(host, /xgen\?\.artifacts\?\.http/)
  assert.match(host, /artifact:http-result/)
})

test('대신 부르는 범위는 그 아티팩트의 주소 아래뿐이다', () => {
  // 예전에는 '/api/' 전부였다 — 에이전트가 쓴 코드가 보는 사람의 권한으로 플랫폼 API 에 닿았다.
  const data = readFileSync(join(root, '../../packages/protocol/src/agent-data.ts'), 'utf8')
  assert.match(data, /artifactHttp\(/)
  assert.match(data, /target\.pathname\.startsWith\(base\)/, '아티팩트 주소 밖으로 자격이 나가면 안 된다')
  assert.doesNotMatch(data, /target\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(data, /delete headers\.cookie/, '프레임이 준 헤더에 쿠키가 있어도 넘기지 않는다')
})
