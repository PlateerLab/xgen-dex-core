/**
 * 아티팩트 동작 버튼의 **소스 계약** — [새 창으로 열기]·[서빙 중지]·[공유]·[삭제].
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

const root = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
/** 주석은 걷어낸 코드만 — 이 파일이 보는 문자열은 주석에서도 불린다. */
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')

const VIEW = 'src/renderer/src/artifacts/ArtifactsView.tsx'
const MAIN = 'src/main/index.ts'
const PRELOAD = 'src/preload/index.ts'

test('네 동작이 모두 있다', () => {
  const v = code(VIEW)
  for (const label of ['새 창으로 열기', '서빙 중지', '공유', '삭제']) {
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

test('공유 확인 문구가 **공개되지 않는 것**을 말한다', () => {
  const v = code(VIEW)
  const share = v.slice(v.indexOf('onToggleShare'), v.indexOf('onDelete'))
  // 한 줄로 줄였다 — 길게 적으면 아무도 안 읽고, 안 읽히는 확인은 확인이 아니다.
  // 그래도 **이 한 가지**는 반드시 남는다: 선언한 API 가 공개 화면에서 안 된다는
  // 사실. 이걸 말하지 않으면 사람은 되는 줄 알고 공유한다.
  assert.match(share, /API는 동작하지 않습니다/)
})

test('공유를 닫을 때 옛 링크가 되살아나지 않는다고 말한다', () => {
  const v = code(VIEW)
  assert.match(v, /되살아나지 않습니다/,
    '다시 켜면 새 토큰이다 — 그걸 모르면 옛 링크가 살아 있다고 오해한다')
})

test('삭제는 되돌릴 수 없다고 말한다', () => {
  const v = code(VIEW)
  const del = v.slice(v.indexOf('onDelete'))
  assert.match(del, /window\.confirm/)
  assert.match(del, /되돌릴 수 없습니다/)
  // 덜 파괴적인 길([서빙 중지])은 **바로 옆 버튼**에 이미 있다 — 문장으로 다시
  // 설명하면 정작 읽어야 할 "되돌릴 수 없다" 가 묻힌다.
})

test('렌더러는 공개 주소를 **직접 조립하지 않는다**', () => {
  const v = code(VIEW)
  assert.doesNotMatch(v, /serverUrl/,
    '렌더러는 서버 주소를 모른다. 알아내려 하면 설정과 어긋난 주소를 사람에게 준다')
  assert.match(v, /res\.url/, '절대 주소는 main 이 붙여 돌려준다')
})

test('절대 주소는 main 이 만든다 — 서버 주소를 아는 유일한 자리', () => {
  const m = code(MAIN)
  const share = m.slice(m.indexOf('CHANNELS.artifactSetShare'))
  assert.match(share.slice(0, 800), /loadConfig\(\)\.serverUrl/)
  const openWeb = m.slice(m.indexOf('CHANNELS.artifactOpenWeb'))
  assert.match(openWeb.slice(0, 600), /shell\.openExternal/)
})

test('preload 가 네 동작을 모두 건넨다', () => {
  const p = code(PRELOAD)
  for (const fn of ['setServing', 'setShare', 'remove', 'openWeb']) {
    assert.match(p, new RegExp(`\\b${fn}:`), `artifacts.${fn} 가 없다`)
  }
})

test('목록은 "서빙 중지됨" 과 "열 수 없음" 을 구분한다', () => {
  const v = code(VIEW)
  assert.match(v, /서빙 중지됨/)
  assert.match(v, /열 수 없음/)
  // 하나로 묶으면 버튼 한 번이면 되는 일과 에이전트가 고쳐야 하는 일이 같아 보인다.
})

test('공개 중이라는 사실이 화면에 계속 남는다', () => {
  const v = code(VIEW)
  assert.match(v, /artifacts-share/,
    '토스트만 띄우면 다음 방문 때는 밖에서 보이고 있다는 것을 알 길이 없다')
  assert.match(v, /공개 중/)
})
