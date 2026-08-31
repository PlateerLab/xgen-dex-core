/**
 * 진단 로그 — 사용자가 **그대로 복사해 보내는** 것이 목적이다.
 * 그래서 비밀이 섞이면 그 자체가 유출이다. 여기서 그걸 고정한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { clearDiag, diag, diagEntries, diagHeader, diagText, onDiag, redact } from '../src/main/diag-log'

test('WebDAV URL 의 접근 토큰을 가린다 (경로가 곧 비밀번호다)', () => {
  const url = 'http://127.0.0.1:51234/AbCdEfGhIjKlMnOpQr/폴더/파일.txt'
  const out = redact(url)
  assert.ok(!out.includes('AbCdEfGhIjKlMnOpQr'), `토큰이 그대로 남았다: ${out}`)
  // 포트는 진단에 필요하므로 남긴다
  assert.match(out, /127\.0\.0\.1:51234/)
})

test('Bearer 토큰과 자격증명 필드를 가린다', () => {
  assert.match(redact('Authorization: Bearer abc.def.ghi'), /Bearer <redacted>/)
  assert.match(redact('{"access_token":"xyz123"}'), /<redacted>/)
  assert.ok(!redact('{"password": "hunter2"}').includes('hunter2'))
  assert.ok(!redact('api_key=SECRETVALUE').includes('SECRETVALUE'))
})

test('평범한 로그는 건드리지 않는다', () => {
  const s = 'exec /sbin/mount_webdav -S -i <url> /Users/me/XGEN-Workspace'
  assert.equal(redact(s), s)
})

test('링 버퍼가 최근 것을 남기고 오래된 것을 버린다', () => {
  clearDiag()
  for (let i = 0; i < 900; i++) diag('t', `line ${i}`)
  const entries = diagEntries()
  assert.ok(entries.length <= 800, `상한을 넘었다: ${entries.length}`)
  assert.match(entries[entries.length - 1].msg, /line 899/)
  assert.ok(!diagText().includes('line 0 '), '오래된 줄이 남아 있다')
})

test('구조화 데이터도 한 줄로 붙는다', () => {
  clearDiag()
  diag('mount', 'exit=1', { stderr: 'No such file' })
  assert.match(diagText(), /exit=1 .*No such file/)
})

test('직렬화 불가 값이 로깅을 깨지 않는다', () => {
  clearDiag()
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.doesNotThrow(() => diag('t', 'circular', circular))
  assert.match(diagText(), /직렬화 불가/)
})

test('로그를 통해 나가는 데이터도 마스킹된다 (diag 경유)', () => {
  clearDiag()
  diag('mount', 'url', 'http://127.0.0.1:5000/SUPERSECRETTOKEN123/x')
  assert.ok(!diagText().includes('SUPERSECRETTOKEN123'))
})

test('구독자는 새 줄을 받고, 하나가 던져도 로깅이 계속된다', () => {
  clearDiag()
  const seen: string[] = []
  const offBad = onDiag(() => {
    throw new Error('구독자 폭발')
  })
  const off = onDiag((e) => seen.push(e.msg))
  assert.doesNotThrow(() => diag('t', 'hello'))
  assert.deepEqual(seen, ['hello'])
  off()
  offBad()
  diag('t', 'after-off')
  assert.deepEqual(seen, ['hello'], '해지 후에도 받았다')
})

test('머리말에 환경이 들어간다 (없으면 로그를 받아도 추측이 된다)', () => {
  const h = diagHeader({ mount: 'webdav', root: '/Users/me/XGEN-Workspace' })
  assert.match(h, /platform :/)
  assert.match(h, /node     :/)
  assert.match(h, /mount/)
  assert.match(h, /XGEN-Workspace/)
})

test('머리말의 추가 항목도 마스킹된다', () => {
  const h = diagHeader({ url: 'http://127.0.0.1:1234/TOKENTOKENTOKEN/' })
  assert.ok(!h.includes('TOKENTOKENTOKEN'), h)
})
