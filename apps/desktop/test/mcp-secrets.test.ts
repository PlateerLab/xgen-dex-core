/** MCP 시크릿 분리/병합/복원 (G8a) — 평문 config 에 시크릿을 안 남기는 규칙. */
import assert from 'assert'
import { test } from 'node:test'
import {
  redactKv,
  mergeSecretKv,
  resolveSecretKv,
  splitServerSecrets,
  withResolvedSecrets,
} from '../src/main/mcp-secrets'
import type { McpServerConfig } from '../src/main/config'

test('redactKv: 키는 남기고 값만 비운다', () => {
  assert.deepEqual(redactKv({ API_TOKEN: 'real', X: 'y' }), { API_TOKEN: '', X: '' })
  assert.equal(redactKv(undefined), undefined)
  assert.equal(redactKv({}), undefined)
})

test('mergeSecretKv: 비어있는 입력은 저장값 유지, 채워진 입력은 교체, 없는 키는 삭제', () => {
  const stored = { API_TOKEN: 'old', KEEP: 'kept' }
  // 입력이 redacted('')면 저장값 유지; 새 값이면 교체; MISSING 키는 사라짐
  const merged = mergeSecretKv(stored, { API_TOKEN: '', KEEP: 'kept' })
  assert.deepEqual(merged, { API_TOKEN: 'old', KEEP: 'kept' })
  const changed = mergeSecretKv(stored, { API_TOKEN: 'new', KEEP: '' })
  assert.deepEqual(changed, { API_TOKEN: 'new', KEEP: 'kept' })
  // 저장값 없던 키를 비워 저장하면 '' 유지(값 없음)
  assert.deepEqual(mergeSecretKv(undefined, { A: '' }), { A: '' })
})

test('resolveSecretKv: 비어있지 않은 config(새로 입력/평문) 우선, redacted 면 시크릿', () => {
  // redacted('') config → 저장 시크릿 사용 (마이그레이션 후 connect)
  assert.deepEqual(resolveSecretKv({ T: '' }, { T: 'secret' }), { T: 'secret' })
  // 마이그레이션 전 평문 config, 시크릿 없음 → 평문
  assert.deepEqual(resolveSecretKv({ T: 'plain' }, undefined), { T: 'plain' })
  // 폼에 새 값 입력 후 테스트: config 값이 저장 시크릿을 이긴다 (옛 값으로 테스트 방지)
  assert.deepEqual(resolveSecretKv({ T: 'newtyped' }, { T: 'oldstored' }), { T: 'newtyped' })
  // 둘 다 없음 → undefined
  assert.equal(resolveSecretKv({ T: '' }, undefined), undefined)
})

test('splitServerSecrets: 실제값 → (redacted config + 시크릿)', () => {
  const cfg: McpServerConfig = {
    name: 's1', transport: 'sse', url: 'https://x', headers: { Authorization: 'Bearer TOKEN' },
  }
  const { redacted, secrets } = splitServerSecrets(cfg, null)
  assert.deepEqual(redacted.headers, { Authorization: '' })   // config 에 값 없음
  assert.deepEqual(secrets.headers, { Authorization: 'Bearer TOKEN' }) // 키체인에 실제값
  assert.equal(redacted.url, 'https://x') // 비밀 아닌 필드는 그대로
})

test('splitServerSecrets: redacted 재저장 시 저장된 시크릿 유지', () => {
  const stored = { headers: { Authorization: 'Bearer TOKEN' } }
  // UI 가 redacted('') 를 그대로 다시 저장 → 저장된 값 유지
  const cfg: McpServerConfig = {
    name: 's1', transport: 'sse', url: 'https://x', headers: { Authorization: '' },
  }
  const { redacted, secrets } = splitServerSecrets(cfg, stored)
  assert.deepEqual(secrets.headers, { Authorization: 'Bearer TOKEN' })
  assert.deepEqual(redacted.headers, { Authorization: '' })
})

test('withResolvedSecrets: connect 용으로 실제값 채워 넣는다', () => {
  const cfg: McpServerConfig = {
    name: 's1', transport: 'stdio', command: 'x', env: { API: '' },
  }
  const out = withResolvedSecrets(cfg, { env: { API: 'realkey' } })
  assert.deepEqual(out.env, { API: 'realkey' })
  // 시크릿 없고 env 도 비면 env 제거
  const bare = withResolvedSecrets({ name: 's', transport: 'stdio', command: 'x', env: { API: '' } }, null)
  assert.equal(bare.env, undefined)
})
