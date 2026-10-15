/**
 * 대화의 폴더 API — 서버 사본을 읽고 올리고 맞춘다.
 *
 * 다른 기기에 폴더가 있으면 409 가 "옮길까요" 의 재료(그 기기·폴더 이름)로 돌아와야 하고,
 * 옛 서버(404)에서는 조용히 예전처럼 동작해야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { ApiError } from '@dex/protocol/client'
import {
  ConversationFoldersApi,
  folderDeviceLabel,
  folderOwnership,
  parseConversationFolders,
} from '@dex/protocol/conversation-folders'

const SERVER_STATE = {
  interaction_id: 'chat_1',
  device: { device_id: 'desk-a', name: '사무실 PC', platform: 'win32', online: true },
  folders: [{ id: 'f1', name: 'report' }],
  updated_at: '2026-09-29T10:00:00',
}

function http(reply: (method: string, path: string, body?: unknown) => unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const run = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body })
    const out = reply(method, path, body)
    if (out instanceof Error) throw out
    return out as T
  }
  return {
    calls,
    get: <T>(path: string) => run<T>('GET', path),
    put: <T>(path: string, body?: unknown) => run<T>('PUT', path, body),
    post: <T>(path: string, body?: unknown) => run<T>('POST', path, body),
  }
}

const DEVICE = { deviceId: 'desk-b', deviceName: '집 PC · 데스크톱', devicePlatform: 'darwin' }

test('서버 모양을 화면 모양으로 읽고 소유를 가른다', () => {
  const state = parseConversationFolders(SERVER_STATE)
  assert.deepEqual(state.device, { deviceId: 'desk-a', name: '사무실 PC', platform: 'win32', online: true })
  assert.deepEqual(state.folders, [{ id: 'f1', name: 'report' }])
  assert.equal(folderOwnership(state, 'desk-a'), 'mine')
  assert.equal(folderOwnership(state, 'desk-b'), 'other')
  assert.equal(folderOwnership(parseConversationFolders({ device: null, folders: [] }), 'desk-b'), 'none')
  assert.equal(folderDeviceLabel(state.device!), '사무실 PC(켜짐)')
})

test('올릴 때 기기와 경로를 싣고, 다른 기기에 있으면 옮기기 재료를 돌려준다', async () => {
  const h = http((method) =>
    method === 'PUT' ? new ApiError(409, 'conflict', { detail: { code: 'other_device', ...SERVER_STATE } }) : null,
  )
  const api = new ConversationFoldersApi(h)
  const out = await api.put('chat_1', DEVICE, [{ id: 'f9', name: 'docs', path: '/Users/me/docs' }])
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.code, 'other_device')
  assert.equal(out.ok === false && out.code === 'other_device' && out.state.device?.name, '사무실 PC')
  assert.deepEqual(h.calls[0].body, {
    device_id: 'desk-b',
    device_name: '집 PC · 데스크톱',
    device_platform: 'darwin',
    folders: [{ id: 'f9', name: 'docs', path: '/Users/me/docs' }],
    workflow_id: '',
    take_over: false,
  })
  assert.equal(h.calls[0].path, '/api/agentflow/conversations/chat_1/folders')
})

test('옮기기는 take_over 를 싣는다', async () => {
  const h = http(() => SERVER_STATE)
  const out = await new ConversationFoldersApi(h).put('chat_1', DEVICE, [], { takeOver: true })
  assert.equal(out.ok, true)
  assert.equal((h.calls[0].body as { take_over: boolean }).take_over, true)
})

test('옛 서버에서는 조용히 예전처럼', async () => {
  const api = new ConversationFoldersApi(http(() => new ApiError(404, 'nf')))
  assert.equal(await api.get('chat_1'), null)
  assert.deepEqual(await api.put('chat_1', DEVICE, []), { ok: false, code: 'unsupported' })
  assert.equal(await api.reconcile(DEVICE, []), null)
})

test('맞추기는 장부 전체를 올리고 잊을 대화를 받는다', async () => {
  const h = http(() => ({ drop: ['chat_2'] }))
  const out = await new ConversationFoldersApi(h).reconcile(DEVICE, [
    { interactionId: 'chat_1', folders: [{ id: 'a', name: 'a', path: '/a' }] },
  ])
  assert.deepEqual(out, { drop: ['chat_2'] })
  assert.equal(h.calls[0].path, '/api/agentflow/conversations/folders/reconcile')
  assert.deepEqual((h.calls[0].body as { conversations: unknown[] }).conversations, [
    { interaction_id: 'chat_1', workflow_id: '', folders: [{ id: 'a', name: 'a', path: '/a' }] },
  ])
})
