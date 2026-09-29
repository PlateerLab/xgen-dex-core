/**
 * 파일 저장소 조회 — 데스크톱 탐색기·뷰어가 서버를 그대로 읽는 표면.
 *
 * 서버는 폴더 하나를 **한 쪽씩** 준다. 첫 쪽만 읽으면 파일이 많은 폴더의 뒷부분이
 * 탐색기에 없고, 경로로 항목을 찾을 때도 뒤쪽 파일은 "없다"가 된다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { FilestoreApi } from '@dex/protocol'

function fakeHttp(pages: Record<string, unknown>) {
  const calls: string[] = []
  const http = {
    get<T>(path: string): Promise<T> {
      calls.push(path)
      if (!(path in pages)) return Promise.reject(new Error(`unexpected GET ${path}`))
      return Promise.resolve(pages[path] as T)
    },
    getBinary(path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
      calls.push(path)
      return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'text/plain' })
    },
  }
  return { api: new FilestoreApi(http as never), calls }
}

const item = (id: number, name: string, folder: number | null = null) => ({
  id,
  file_name: name,
  file_size: 10,
  folder_id: folder,
})

test('폴더 목록은 has_more 가 꺼질 때까지 이어 읽는다', async () => {
  const { api, calls } = fakeHttp({
    '/api/filestore/root?page=1&page_size=500': {
      folders: [{ id: 1, folder_name: '보고서', full_path: '보고서', parent_folder_id: null }],
      items: [item(10, 'a.txt')],
      has_more: true,
    },
    '/api/filestore/root?page=2&page_size=500': { folders: [], items: [item(11, 'b.txt')], has_more: false },
  })
  const { folders, items } = await api.list(null)
  assert.deepEqual(folders.map((f) => f.folder_name), ['보고서'])
  assert.deepEqual(items.map((i) => i.file_name), ['a.txt', 'b.txt'])
  assert.equal(calls.length, 2)
})

test('경로로 폴더와 항목을 찾는다 (뒤쪽 쪽에 있는 파일도)', async () => {
  const { api } = fakeHttp({
    '/api/filestore/tree': {
      folders: [
        { id: 1, folder_name: '보고서', full_path: '보고서', parent_folder_id: null },
        { id: 2, folder_name: '2026', full_path: '보고서/2026', parent_folder_id: 1 },
      ],
    },
    '/api/filestore/folders/2/items?page=1&page_size=500': { items: [item(20, '1월.md', 2)], has_more: true },
    '/api/filestore/folders/2/items?page=2&page_size=500': { items: [item(21, '9월.md', 2)], has_more: false },
    '/api/filestore/root?page=1&page_size=500': { folders: [], items: [item(30, '루트.txt')] },
  })
  assert.equal(await api.folderByPath(''), null)
  assert.equal((await api.folderByPath('보고서/2026/'))?.id, 2)
  assert.equal(await api.folderByPath('없음'), undefined)
  assert.equal((await api.resolveItemByPath('보고서/2026/9월.md'))?.id, 21)
  assert.equal((await api.resolveItemByPath('/루트.txt'))?.id, 30)
  assert.equal(await api.resolveItemByPath('없음/x.txt'), null)
})

test('파일 받기는 항목 다운로드 경로를 쓴다', async () => {
  const { api, calls } = fakeHttp({})
  const res = await api.download(42)
  assert.deepEqual([...res.bytes], [1, 2, 3])
  assert.deepEqual(calls, ['/api/filestore/items/42/download'])
})
