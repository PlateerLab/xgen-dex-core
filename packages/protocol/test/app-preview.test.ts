/**
 * 앱 카드의 미리보기 그림과 모바일 첨부 — 2026-10-02.
 *
 * - 미리보기는 서버가 준 주소(`preview_url`)만 받는다. 화면이 넘긴 임의의 주소를 사용자 자격으로 부르면
 *   그 자격이 엉뚱한 곳으로 나간다.
 * - 올리기는 그림 바이트를 그대로 PUT 한다.
 * - 첨부는 바이트 또는 파일 참조(`{ uri }`) — React Native 의 Blob 은 바이트로 만들 수 없어서
 *   모바일의 사진·파일 첨부가 전부 업로드 직전에 실패했다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { AgentDataApi, appendUploadFile, isAppPreviewPath } from '@dex/protocol/agent-data'

test('미리보기 주소는 앱 API 아래의 /preview 만', () => {
  assert.equal(isAppPreviewPath('/api/agentflow/agent-apps/wf/map/preview?v=12'), true)
  assert.equal(isAppPreviewPath('/api/agentflow/agent-apps/public/wf/map/tok/preview'), true)
  assert.equal(isAppPreviewPath('/api/agentflow/agent-artifacts/wf/map/preview'), true)
  for (const bad of [
    'https://evil.example/api/agentflow/agent-apps/wf/map/preview',
    '//evil.example/api/agentflow/agent-apps/wf/map/preview',
    '/api/agentflow/agent-apps/wf/map/app/index.html',
    '/api/agentflow/agent-apps/wf/../../auth/preview',
    '/api/admin/users/preview',
    '',
    undefined,
  ]) {
    assert.equal(isAppPreviewPath(bad), false, String(bad))
  }
})

test('미리보기 그림은 그 주소 그대로 받고, 아닌 주소는 부르지 않는다', async () => {
  const calls: string[] = []
  const http = {
    getBinary(path: string) {
      calls.push(path)
      return Promise.resolve({ bytes: new Uint8Array([1]), contentType: 'image/jpeg' })
    },
  }
  const api = new AgentDataApi(http as never)
  const got = await api.appPreviewImage('/api/agentflow/agent-apps/wf/map/preview?v=3')
  assert.equal(got.contentType, 'image/jpeg')
  await assert.rejects(api.appPreviewImage('/api/agentflow/auth/me'))
  assert.deepEqual(calls, ['/api/agentflow/agent-apps/wf/map/preview?v=3'])
})

test('미리보기 올리기는 그림 바이트를 PUT 한다', async () => {
  const seen: Array<[string, Uint8Array, string]> = []
  const http = {
    putBytes(path: string, bytes: Uint8Array, type: string) {
      seen.push([path, bytes, type])
      return Promise.resolve({ ok: true, slug: 'map', preview_url: '/x', preview_at: 1 })
    },
  }
  const api = new AgentDataApi(http as never)
  await api.appPreviewUpload('wf 1', 'map', new Uint8Array([0xff, 0xd8, 0xff]))
  assert.equal(seen[0][0], '/api/agentflow/agent-apps/wf%201/map/preview')
  assert.equal(seen[0][2], 'image/jpeg')
})

test('첨부: 바이트는 Blob 으로, 파일 참조는 RN FormData 의 { uri, name, type } 으로', () => {
  const parts: Array<[string, unknown, string | undefined]> = []
  const form = { append: (k: string, v: unknown, n?: string) => parts.push([k, v, n]) } as unknown as FormData
  appendUploadFile(form, 'file', new Uint8Array([1, 2]), 'a.png', 'image/png')
  appendUploadFile(form, 'file', { uri: 'file:///cache/photo.jpg' }, '사진.jpg', 'image/jpeg')
  assert.ok(parts[0][1] instanceof Blob)
  assert.equal(parts[0][2], 'a.png')
  assert.deepEqual(parts[1][1], { uri: 'file:///cache/photo.jpg', name: '사진.jpg', type: 'image/jpeg' })
})
