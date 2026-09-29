// IDE 탐색기 [연결된 폴더] 의 디스크 작업 — 폴더 밖으로 나가지 않고, 연 판을 조건으로 쓴다.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderFsError, folderFsCall, listFolder, readFolderFile, runFolderOp, saveFolderFile } from '../src/main/folder-fs'

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'folder-fs-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'src', 'main.py'), 'print(1)')
  await writeFile(join(root, 'README.md'), '# hi')
  return root
}

test('한 단계씩 보여 주고 .git 같은 것은 감춘다', async () => {
  const root = await project()
  const top = await listFolder(root, '')
  assert.deepEqual(top.map((e) => [e.path, e.isDir]).sort(), [['README.md', false], ['src', true]])
  assert.deepEqual((await listFolder(root, 'src')).map((e) => e.path), ['src/main.py'])
})

test('저장은 연 판을 조건으로 건다 — 그사이 바뀌었으면 changed', async () => {
  const root = await project()
  const read = await readFolderFile(root, 'src/main.py')
  await saveFolderFile(root, 'src/main.py', new TextEncoder().encode('print(2)'), read.sha)
  assert.equal(await readFile(join(root, 'src', 'main.py'), 'utf8'), 'print(2)')
  await assert.rejects(
    () => saveFolderFile(root, 'src/main.py', new TextEncoder().encode('print(3)'), read.sha),
    (e: unknown) => e instanceof FolderFsError && e.code === 'changed',
  )
  await saveFolderFile(root, 'new/deep.txt', new TextEncoder().encode('x'), '')
  assert.equal(await readFile(join(root, 'new', 'deep.txt'), 'utf8'), 'x', '새 파일은 없는 폴더도 만든다')
})

test('폴더 밖은 상대 경로로도 링크로도 닿지 않는다', async () => {
  const root = await project()
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  await writeFile(join(outside, 'secret.txt'), 'no')
  await assert.rejects(() => readFolderFile(root, '../secret.txt'), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
  try {
    await symlink(outside, join(root, 'link'), 'dir')
  } catch {
    return // 링크를 만들 수 없는 환경(권한 없는 윈도)
  }
  await assert.rejects(() => readFolderFile(root, 'link/secret.txt'), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
})

test('지우기는 휴지통으로, 폴더 자체는 지우지도 옮기지도 않는다', async () => {
  const root = await project()
  const trashed: string[] = []
  await runFolderOp(root, { op: 'delete', paths: ['README.md'] }, { trash: async (abs) => void trashed.push(abs) })
  assert.deepEqual(trashed, [join(root, 'README.md')])
  await assert.rejects(() => runFolderOp(root, { op: 'delete', paths: [''] }), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
  await assert.rejects(() => runFolderOp(root, { op: 'rename', src: '', dst: 'x' }), (e: unknown) => e instanceof FolderFsError)
  await runFolderOp(root, { op: 'rename', src: 'src/main.py', dst: 'src/app.py' })
  assert.ok(existsSync(join(root, 'src', 'app.py')))
  await assert.rejects(() => runFolderOp(root, { op: 'rename', src: 'src/app.py', dst: 'src' }), (e: unknown) => e instanceof FolderFsError && e.code === 'exists')
})

test('한 번의 IPC 호출로 모두 닿는다 — 알 수 없는 작업은 거부한다', async () => {
  const root = await project()
  const st = (await folderFsCall(root, 'stat', { paths: ['README.md', 'nope.txt'] })) as Record<string, { kind: string; sha?: string }>
  assert.equal(st['README.md'].kind, 'file')
  assert.ok(st['README.md'].sha)
  assert.equal(st['nope.txt'].kind, 'missing')
  await assert.rejects(() => folderFsCall(root, 'format-disk', {}), (e: unknown) => e instanceof FolderFsError && e.code === 'bad_request')
})
