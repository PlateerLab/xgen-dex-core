/** 마크다운 코어 — 인라인·링크 위생·코드펜스 분할·unglue·자막 인라인. */
import assert from 'assert'
import { test } from 'node:test'
import {
  escapeHtml,
  inlineMarkdownHtml,
  processInlineMarkdown,
  sanitizeLinkHref,
  splitFences,
  ungluMarkdownMarkers,
} from '../src/renderer/src/markdown-core'

test('escapeHtml 이 raw HTML 을 무력화한다', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('processInlineMarkdown: 볼드/이탤릭/코드/취소선', () => {
  assert.match(processInlineMarkdown('**굵게**'), /<strong>굵게<\/strong>/)
  assert.match(processInlineMarkdown('_기울임_ 아님'), /_기울임_/) // __/_ 는 bold(__)만, 단일 _ 는 미처리
  assert.match(processInlineMarkdown('*기울임*'), /<em>기울임<\/em>/)
  assert.match(processInlineMarkdown('`code`'), /<code class="md-inline-code">code<\/code>/)
  assert.match(processInlineMarkdown('~~취소~~'), /<del>취소<\/del>/)
})

test('링크는 escape 후 안전한 스킴만 통과', () => {
  const ok = processInlineMarkdown('[네이버](https://naver.com)')
  assert.match(ok, /<a href="https:\/\/naver\.com\/"/)
  assert.match(ok, /target="_blank"/)
  // 위험 스킴은 # 로 차단
  assert.equal(sanitizeLinkHref('javascript:alert(1)'), '#')
  assert.equal(sanitizeLinkHref('//evil.com'), '#')
  assert.match(sanitizeLinkHref('https://ok.com'), /https:\/\/ok\.com/)
})

test('코드 안의 마크다운 특수문자는 코드 안에서 처리되지 않는다(인라인 코드)', () => {
  const html = processInlineMarkdown('`**not bold**`')
  assert.match(html, /<code class="md-inline-code">\*\*not bold\*\*<\/code>/)
})

test('splitFences: 닫힌 펜스를 코드 세그먼트로 분리', () => {
  const segs = splitFences('앞\n```bash\necho hi\n```\n뒤')
  const kinds = segs.map((s) => s.kind)
  assert.deepEqual(kinds, ['text', 'code', 'text'])
  const code = segs.find((s) => s.kind === 'code') as any
  assert.equal(code.language, 'bash')
  assert.equal(code.code, 'echo hi')
  assert.equal(code.closed, true)
})

test('splitFences: 스트리밍 중 안 닫힌 펜스도 코드로(원문 백틱 노출 방지)', () => {
  const segs = splitFences('설명\n```python\nprint(1)')
  const code = segs.find((s) => s.kind === 'code') as any
  assert.ok(code, '열린 펜스가 코드로 잡히지 않음')
  assert.equal(code.language, 'python')
  assert.equal(code.closed, false)
  assert.match(code.code, /print\(1\)/)
})

test('splitFences: 펜스 없으면 통째로 text', () => {
  const segs = splitFences('그냥 텍스트')
  assert.deepEqual(segs.map((s) => s.kind), ['text'])
})

test('ungluMarkdownMarkers: 문장에 붙은 헤더/리스트를 분리한다', () => {
  const s = ungluMarkdownMarkers('설명입니다.### 제목')
  assert.match(s, /\n\n#{3} 제목/)
  // 콜론(:) 앞은 표 구분선(:--) 보호 위해 의도적으로 분리 안 함 — 마침표 케이스로 검증.
  const l = ungluMarkdownMarkers('요약이다.- 항목')
  assert.match(l, /\n[*+-] 항목/)
})

test('ungluMarkdownMarkers: 정상 볼드 스팬은 리스트로 오인·분리되지 않는다', () => {
  const s = ungluMarkdownMarkers('이것은 **중요 강조** 입니다')
  assert.match(s, /\*\*중요 강조\*\*/) // 마스킹으로 보존 — 내부 쪼갬 없음
  assert.ok(!s.includes('\n'), '정상 볼드가 줄바꿈으로 쪼개졌다')
})

test('inlineMarkdownHtml(자막): 블록 마커 정리 + 인라인 렌더', () => {
  const html = inlineMarkdownHtml('### 안녕\n- 첫째\n**굵게**')
  assert.ok(!html.includes('###'), '헤더 마커가 남아있다')
  assert.match(html, /• 첫째/, '불릿으로 변환 안 됨')
  assert.match(html, /<strong>굵게<\/strong>/)
  assert.match(html, /<br\/>/, '줄바꿈이 <br> 로 안 됨')
})

test('inlineMarkdownHtml: 펜스 라인은 드롭한다(말풍선)', () => {
  const html = inlineMarkdownHtml('```bash\necho hi\n```')
  assert.ok(!html.includes('```'), '펜스 마커가 자막에 남았다')
  assert.match(html, /echo hi/)
})
