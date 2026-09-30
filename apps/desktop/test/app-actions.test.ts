/**
 * 앱 동작 버튼의 **소스 계약** — [새 창으로 열기]·[배포 중지]·[공유]·[삭제], 그리고
 * 같은 동작을 카드로 보여 주는 [앱] 탭(AgentAppsPage).
 *
 * 이 중 하나는 성격이 다르다. [공유]는 **회사 밖에 문을 내는 일**이라, 잘못
 * 눌리면 되돌릴 수 없다(이미 본 사람이 있다). 그래서 여기서 지키는 것은
 * "버튼이 있다" 가 아니라 **묻고 나서 연다**와 **무엇이 공개되지 않는지 말한다** 다.
 *
 * 실행 테스트로는 잡히지 않는다 — 확인 문구가 통째로 빠져도 기능은 멀쩡히
 * 돌기 때문이다. 값싸고, 사람이 실수하는 바로 그 지점에 있는 검사다.
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { test } from 'node:test'
import { publicAppUrl } from '../src/main/app-links'

const root = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
/** 주석은 걷어낸 코드만 — 이 파일이 보는 문자열은 주석에서도 불린다. */
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')

const VIEW = 'src/renderer/src/apps/AppsView.tsx'
const PAGE = 'src/renderer/src/apps/AgentAppsPage.tsx'
const MODEL = 'src/renderer/src/apps/app-gallery-model.ts'
const MAIN = 'src/main/index.ts'
const PRELOAD = 'src/preload/index.ts'
const IPC = 'src/main/ipc.ts'

test('네 동작이 모두 있다', () => {
  const v = code(VIEW)
  for (const label of ['새 창으로 열기', '배포 중지', '공유', '삭제']) {
    assert.ok(v.includes(label), `[${label}] 버튼이 없다`)
  }
})

test('공유는 **묻고 나서** 연다', () => {
  const v = code(VIEW)
  const share = v.slice(v.indexOf('onToggleShare'), v.indexOf('onDelete'))
  assert.match(share, /window\.confirm/,
    '확인 없이 공개되면 되돌릴 수 없다 — 이미 본 사람이 있다')
  assert.ok(
    share.indexOf('window.confirm') < share.indexOf('setShare'),
    '묻기 전에 부르면 확인이 장식이다',
  )
})

test('공유 확인 문구가 **무엇이 열리는지**를 말한다', () => {
  const v = code(VIEW)
  const share = v.slice(v.indexOf('onToggleShare'), v.indexOf('onDelete'))
  // 문구는 [앱] 탭과 같이 쓰려고 한 곳(APP_CONFIRM)에 있다 — 두 화면이 다른 말을 하지 않게.
  assert.match(share, /APP_CONFIRM\.share/)
  // 한 줄로 줄였다 — 길게 적으면 아무도 안 읽고, 안 읽히는 확인은 확인이 아니다.
  // 그 한 줄은 **사실**이어야 한다. 예전 문장 "API는 동작하지 않습니다" 는 한 파일 화면에만
  // 맞았고, 앱(백엔드까지 공개 링크에서 그대로 돈다) 주인은 그 말을 "안전하다" 로 읽었다.
  const m = code(MODEL)
  assert.match(m, /share: '[^']*로그인 없이 이 화면을 쓸 수 있습니다/)
  assert.doesNotMatch(m, /API는 동작하지 않습니다/)
})

test('공유를 닫을 때 옛 링크가 되살아나지 않는다고 말한다', () => {
  const v = code(VIEW)
  assert.match(v, /APP_CONFIRM\.unshare/)
  assert.match(code(MODEL), /unshare: '[^']*되살아나지 않습니다/,
    '다시 켜면 새 토큰이다 — 그걸 모르면 옛 링크가 살아 있다고 오해한다')
})

test('배포 중지는 **묻고 나서** 멈춘다 — 앱과 공개 링크가 함께 닫힌다', () => {
  assert.match(code(MODEL), /undeploy: '배포를 중지할까요\?\\n내용은 그대로 두고 앱과 공개 링크를 닫습니다\.'/)
  for (const [file, from, to] of [
    [VIEW, 'onToggleServing', 'onToggleShare'],
    [PAGE, 'const toggleServing', 'const openStoreApp'],
  ]) {
    const src = code(file)
    const body = src.slice(src.indexOf(from), src.indexOf(to))
    assert.match(body, /APP_CONFIRM\.undeploy/, `${file}: 확인 없이 멈춘다`)
    assert.ok(
      body.indexOf('window.confirm') < body.indexOf('setServing'),
      `${file}: 묻기 전에 부르면 확인이 장식이다`,
    )
  }
})

test('[앱] 탭의 공유도 묻고 나서 연다', () => {
  const p = code(PAGE)
  const share = p.slice(p.indexOf('const toggleShare'), p.indexOf('const toggleServing'))
  assert.match(share, /APP_CONFIRM\.share/)
  assert.match(share, /APP_CONFIRM\.unshare/)
  assert.ok(share.indexOf('window.confirm') < share.indexOf('setShare'))
  assert.match(share, /res\.url/, '절대 주소는 main 이 붙여 돌려준다')
})

test('삭제는 되돌릴 수 없다고 말한다', () => {
  const v = code(VIEW)
  const del = v.slice(v.indexOf('onDelete'))
  assert.match(del, /window\.confirm/)
  assert.match(del, /되돌릴 수 없습니다/)
  // 덜 파괴적인 길([배포 중지])은 **바로 옆 버튼**에 이미 있다 — 문장으로 다시
  // 설명하면 정작 읽어야 할 "되돌릴 수 없다" 가 묻힌다.
})

test('렌더러는 공개 주소를 **직접 조립하지 않는다**', () => {
  const v = code(VIEW)
  for (const src of [v, code(PAGE)]) {
    assert.doesNotMatch(src, /serverUrl/,
      '렌더러는 서버 주소를 모른다. 알아내려 하면 설정과 어긋난 주소를 사람에게 준다')
  }
  assert.match(v, /res\.url/, '절대 주소는 main 이 붙여 돌려준다')
  // 스토어의 앱은 서버가 준 경로만 넘긴다 — 절대 주소는 main 이 만든다.
  assert.match(code(PAGE), /openPublic\(app\.path\)/)
})

test('절대 주소는 main 이 만든다 — 서버 주소를 아는 유일한 자리', () => {
  const m = code(MAIN)
  const share = m.slice(m.indexOf('CHANNELS.appSetShare'))
  assert.match(share.slice(0, 800), /loadConfig\(\)\.serverUrl/)
  const openWeb = m.slice(m.indexOf('CHANNELS.appOpenWeb'))
  assert.match(openWeb.slice(0, 600), /shell\.openExternal/)
  const openPublic = m.slice(m.indexOf('CHANNELS.appOpenPublic'))
  assert.match(openPublic.slice(0, 400), /publicAppUrl\(normalizeServerUrl\(loadConfig\(\)\.serverUrl\)/)
  assert.match(openPublic.slice(0, 400), /shell\.openExternal/)
})

test('공개 링크는 서버와 같은 곳만 연다', () => {
  assert.equal(
    publicAppUrl('https://xgen.example.com/', '/share/app/wf/a/tok'),
    'https://xgen.example.com/share/app/wf/a/tok',
  )
  assert.equal(publicAppUrl('https://xgen.example.com/base', '/share/x'), 'https://xgen.example.com/base/share/x')
  // 경로가 아닌 것 — 서버가 아닌 곳을 기본 브라우저로 열게 된다.
  assert.equal(publicAppUrl('https://xgen.example.com', 'https://evil.example/x'), null)
  assert.equal(publicAppUrl('https://xgen.example.com', '//evil.example/x'), null)
  assert.equal(publicAppUrl('https://xgen.example.com', 'share/x'), null)
  assert.equal(publicAppUrl('https://xgen.example.com', 42), null)
  assert.equal(publicAppUrl('', '/share/x'), null)
  assert.equal(publicAppUrl('file:///etc', '/passwd'), null)
})

test('preload 가 네 동작을 모두 건넨다', () => {
  const p = code(PRELOAD)
  for (const fn of ['setServing', 'setShare', 'remove', 'openWeb', 'mine', 'store', 'openPublic']) {
    assert.match(p, new RegExp(`\\b${fn}:`), `apps.${fn} 가 없다`)
  }
})

test('[앱] 은 사이드바가 아니라 탭이다 — main 이 에이전트를 훑던 모음은 없다', () => {
  // 서버가 [내 앱]을 모아 주므로 main 이 에이전트마다 목록을 묻던 훑기는 걷었다.
  for (const file of [MAIN, PRELOAD, IPC]) {
    assert.doesNotMatch(code(file), /appGallery|gallery:/, `${file} 에 옛 모음이 남아 있다`)
  }
  const bar = code('src/renderer/src/views/ActivityBar.tsx')
  assert.doesNotMatch(bar, /id: 'apps'/, '[앱] 이 다시 사이드바 보기가 되었다')
  assert.match(bar, /onClick=\{onOpenApps\}/)
  const ws = code('src/renderer/src/views/Workspace.tsx')
  assert.doesNotMatch(ws, /AppsPanel/)
  assert.match(ws, /<AgentAppsPage/)
})

test('목록은 "배포 중지됨" 과 "열 수 없음" 을 구분한다', () => {
  const v = code(VIEW)
  assert.match(v, /배포 중지됨/)
  assert.match(v, /열 수 없음/)
  // 하나로 묶으면 버튼 한 번이면 되는 일과 에이전트가 고쳐야 하는 일이 같아 보인다.
})

test('배포를 멈추면 상세를 읽지 않고 프레임을 걷는다', () => {
  const v = code(VIEW)
  // 멈춘 앱의 상세는 404 다 — 오류가 아니라 멈춘 상태라 읽지 않는다.
  const effect = v.slice(v.indexOf('const target = itemsRef.current.find'))
  assert.match(effect.slice(0, 300), /!target\.serving/)
  // 토글 응답을 목록과 상세에 곧바로 입히고 상세를 다시 읽는다.
  const serving = v.slice(v.indexOf('onToggleServing'), v.indexOf('onToggleShare'))
  assert.match(serving, /setItems\(/)
  assert.match(serving, /setLoaded\(/)
  assert.match(serving, /setPull\(/)
  // 상태는 목록 항목을 먼저 본다 — 상세는 멈춘 뒤 옛 값을 들고 있을 수 있다.
  assert.match(v, /const serving = current\?\.serving \?\? detail\?\.serving/)
})

test('Dex 화면 문구에 "서빙" 이 없다 — 사람에게는 "배포" 다', () => {
  const files = [
    VIEW,
    PAGE,
    MODEL,
    'src/renderer/src/views/Workspace.tsx',
    'src/renderer/src/views/ActivityBar.tsx',
    'src/renderer/src/views/TabBar.tsx',
    'src/main/artifact-frame.html',
  ]
  for (const file of files) assert.doesNotMatch(code(file), /서빙/, `${file} 에 "서빙" 이 남아 있다`)
})

test('앱 화면 문구에 줄표(—)가 없다', () => {
  for (const file of [VIEW, PAGE, MODEL]) {
    assert.doesNotMatch(code(file), /—/, `${file} 의 화면 문구에 줄표가 있다`)
  }
})

test('공개 중이라는 사실이 화면에 계속 남는다', () => {
  const v = code(VIEW)
  assert.match(v, /apps-share/,
    '토스트만 띄우면 다음 방문 때는 밖에서 보이고 있다는 것을 알 길이 없다')
  assert.match(v, /공개 중/)
})
