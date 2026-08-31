/**
 * 히스토리 표시 문자열화 — "기존 채팅 불러오기 → 검정 화면" 크래시의 근본 방어.
 *
 * 서버 /api/chat/io-logs 는 `result` 를 그대로 싣는다: 구조화 출력(Schema
 * Provider) 턴은 dict, 멀티모달 입력은 [{type,text},{type,image_url}] 배열이라
 * **문자열이 아니다.** 이를 그대로 {m.text} 로 렌더하면 React 가
 * "Objects are not valid as a React child" 로 죽어 트리 전체가 언마운트되고
 * 화면이 검게 됐다. toDisplayText 로 항상 문자열이 되게 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { toDisplayText, toHistoryAttachments, xgenyHistoryWorkspacePath } from '../src/core/history'

test('문자열은 그대로', () => {
  assert.equal(toDisplayText('안녕하세요'), '안녕하세요')
  assert.equal(toDisplayText(''), '')
})

test('null/undefined 는 빈 문자열', () => {
  assert.equal(toDisplayText(null), '')
  assert.equal(toDisplayText(undefined), '')
})

test('숫자/불리언은 문자열화', () => {
  assert.equal(toDisplayText(42), '42')
  assert.equal(toDisplayText(true), 'true')
})

test('멀티모달 배열은 text 블록만 이어 붙인다', () => {
  const input = [
    { type: 'text', text: '이 화면 봐줘' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]
  const out = toDisplayText(input)
  assert.match(out, /이 화면 봐줘/)
  assert.match(out, /\[이미지\]/)
  assert.ok(!out.includes('base64'), '이미지 원본 데이터는 렌더에 싣지 않는다')
})

test('구조화 출력(dict)은 JSON 으로 — 렌더가 절대 객체를 받지 않는다', () => {
  const result = toDisplayText({ status: 'ok', score: 0.91 })
  assert.equal(typeof result, 'string')
  assert.match(result, /status/)
  assert.match(result, /0\.91/)
})

test('문자열 배열도 안전하게 합친다', () => {
  assert.equal(toDisplayText(['a', 'b']), 'a\nb')
})

test('어떤 입력이든 반환은 항상 string 타입이다 (렌더 안전 계약)', () => {
  for (const v of [null, undefined, 0, false, 'x', {}, [], [{ type: 'text', text: 'y' }], { a: 1 }, [1, 2]]) {
    assert.equal(typeof toDisplayText(v), 'string', `non-string 반환: ${JSON.stringify(v)}`)
  }
})

test('채팅 이력 첨부를 표시용 메타데이터로 정규화한다', () => {
  const [attachment] = toHistoryAttachments([
    {
      id: 17,
      name: 'red drop.png',
      size: 1234,
      contentType: 'image/png',
      type: 'picture',
      minioPath: 'geny-workspace:uploads/users/42/iid-1/att-1/red drop.png',
      bucket: 'geny-workspace',
    },
  ])
  assert.deepEqual(attachment, {
    id: 17,
    name: 'red drop.png',
    size: 1234,
    contentType: 'image/png',
    type: 'picture',
    path: 'geny-workspace:uploads/users/42/iid-1/att-1/red drop.png',
    bucket: 'geny-workspace',
  })
  assert.equal(xgenyHistoryWorkspacePath(attachment), 'uploads/users/42/iid-1/att-1/red drop.png')
})

test('XGeny 사용자 업로드 경로가 아닌 이력 첨부는 workspace 원본으로 열지 않는다', () => {
  const base = {
    name: 'x.png',
    size: 1,
    contentType: 'image/png',
    type: 'picture' as const,
    bucket: 'geny-workspace',
  }
  assert.equal(xgenyHistoryWorkspacePath({ ...base, path: 'geny-workspace:../private/x.png' }), null)
  assert.equal(xgenyHistoryWorkspacePath({ ...base, path: 'geny-workspace:workspace/memory/x.png' }), null)
  assert.equal(xgenyHistoryWorkspacePath({ ...base, path: 'legacy-minio-object', bucket: 'chat' }), null)
})
