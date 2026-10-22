// IDE 탐색기 [연결된 폴더] 의 디스크 작업 — 폴더 밖으로 나가지 않고, 연 판을 조건으로 쓴다.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { chmodSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'
import { configureNativeFsStage } from '@dex/engine/rooted-fs'
import {
  FolderFsError,
  closeFolderFsRoot,
  folderFsCall,
  listFolder,
  readFolderFile,
  runFolderOp,
  saveFolderFile,
} from '../src/main/folder-fs'

const privateStage = mkdtempSync(join(tmpdir(), 'folder-fs-stage-'))
chmodSync(privateStage, 0o700)
configureNativeFsStage(privateStage)

const directoryLinkType = platform === 'win32' ? 'junction' : 'dir'

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
  if (platform !== 'win32') {
    assert.equal((await stat(join(root, 'new'))).mode & 0o777, 0o777 & ~process.umask())
    assert.equal((await stat(join(root, 'new', 'deep.txt'))).mode & 0o777, 0o666 & ~process.umask())
  }
})

test('폴더 밖은 상대 경로로도 링크로도 닿지 않는다', async () => {
  const root = await project()
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  await writeFile(join(outside, 'secret.txt'), 'no')
  await assert.rejects(() => readFolderFile(root, '../secret.txt'), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
  try {
    await symlink(outside, join(root, 'link'), directoryLinkType)
  } catch {
    return // 링크를 만들 수 없는 환경(권한 없는 윈도)
  }
  await assert.rejects(() => readFolderFile(root, 'link/secret.txt'), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
})

test('지우기는 휴지통으로, 폴더 자체는 지우지도 옮기지도 않는다', async () => {
  const root = await project()
  const trashed: string[] = []
  await runFolderOp(root, { op: 'delete', paths: ['README.md'] }, { trash: async (abs) => void trashed.push(abs) })
  assert.equal(trashed.length, 1)
  assert.equal(dirname(trashed[0]), await realpath(privateStage))
  assert.equal(existsSync(join(root, 'README.md')), false)
  await assert.rejects(() => runFolderOp(root, { op: 'delete', paths: [''] }), (e: unknown) => e instanceof FolderFsError && e.code === 'forbidden')
  await assert.rejects(() => runFolderOp(root, { op: 'rename', src: '', dst: 'x' }), (e: unknown) => e instanceof FolderFsError)
  await runFolderOp(root, { op: 'rename', src: 'src/main.py', dst: 'src/app.py' })
  assert.ok(existsSync(join(root, 'src', 'app.py')))
  await assert.rejects(() => runFolderOp(root, { op: 'rename', src: 'src/app.py', dst: 'src' }), (e: unknown) => e instanceof FolderFsError && e.code === 'exists')
})

test('root 경로가 바뀌어도 승인한 객체를 유지하고 새 경로의 파일은 읽지 않는다', async () => {
  const root = await project()
  await readFolderFile(root, 'README.md') // pin the approved root object
  const moved = `${root}-moved`
  const outside = await mkdtemp(join(tmpdir(), 'folder-fs-outside-'))
  await writeFile(join(outside, 'README.md'), 'outside')
  await rename(root, moved)
  await symlink(outside, root, directoryLinkType)
  try {
    const value = await readFolderFile(root, 'README.md')
    assert.equal(Buffer.from(value.bytes).toString(), '# hi')
  } finally {
    closeFolderFsRoot(root)
    await rm(root, { force: true })
    await rm(moved, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('재귀 복사는 링크를 건너뛰고 두 rename 경합은 한 대상만 얻는다', async () => {
  const root = await project()
  const outside = await mkdtemp(join(tmpdir(), 'folder-fs-copy-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await symlink(outside, join(root, 'src', 'outside-link'), directoryLinkType)
  await runFolderOp(root, { op: 'copy', src: 'src', dst: 'copy' })
  assert.equal(await readFile(join(root, 'copy', 'main.py'), 'utf8'), 'print(1)')
  assert.equal(existsSync(join(root, 'copy', 'outside-link')), false)
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  const results = await Promise.allSettled([
    runFolderOp(root, { op: 'rename', src: 'a.txt', dst: 'winner.txt' }),
    runFolderOp(root, { op: 'rename', src: 'b.txt', dst: 'winner.txt' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.match(await readFile(join(root, 'winner.txt'), 'utf8'), /^[ab]$/)
})

test('한 번의 IPC 호출로 모두 닿는다 — 알 수 없는 작업은 거부한다', async () => {
  const root = await project()
  const st = (await folderFsCall(root, 'stat', { paths: ['README.md', 'nope.txt'] })) as Record<string, { kind: string; sha?: string }>
  assert.equal(st['README.md'].kind, 'file')
  assert.ok(st['README.md'].sha)
  assert.equal(st['nope.txt'].kind, 'missing')
  await assert.rejects(() => folderFsCall(root, 'format-disk', {}), (e: unknown) => e instanceof FolderFsError && e.code === 'bad_request')
})

test('기존 파일 저장과 복사에서 파일 객체와 실행 권한을 보존한다', { skip: platform === 'win32' }, async () => {
  const root = await project()
  const path = join(root, 'src', 'main.py')
  await chmod(path, 0o751)
  await chmod(join(root, 'src'), 0o751)
  const before = await stat(path)
  const opened = await readFolderFile(root, 'src/main.py')
  await saveFolderFile(root, 'src/main.py', Buffer.from('print(3)'), opened.sha)
  const saved = await stat(path)
  assert.equal(saved.ino, before.ino)
  assert.equal(saved.mode & 0o777, 0o751)
  await runFolderOp(root, { op: 'copy', src: 'src', dst: 'copy' })
  assert.equal((await stat(join(root, 'copy'))).mode & 0o777, 0o751)
  assert.equal((await stat(join(root, 'copy', 'main.py'))).mode & 0o777, 0o751)
})

test('조건 없는 저장은 쓰기 전용 기존 파일에도 성공한다', { skip: platform === 'win32' }, async () => {
  const root = await project()
  const path = join(root, 'write-only.txt')
  await writeFile(path, 'before')
  await chmod(path, 0o200)
  const before = await stat(path)
  await saveFolderFile(root, 'write-only.txt', Buffer.from('after'), null)
  const after = await stat(path)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mode & 0o777, 0o200)
  await chmod(path, 0o600)
  assert.equal(await readFile(path, 'utf8'), 'after')
})

test('같은 폴더의 연결 해제는 해당 대화의 grant만 닫는다', async () => {
  const root = await project()
  const one = 'scope-one'
  const two = 'scope-two'
  await folderFsCall(root, 'read', { path: 'README.md' }, {}, one)
  await folderFsCall(root, 'read', { path: 'README.md' }, {}, two)
  const moved = `${root}-scope-moved`
  const outside = await mkdtemp(join(tmpdir(), 'folder-fs-other-scope-'))
  await writeFile(join(outside, 'README.md'), 'outside')
  await rename(root, moved)
  await symlink(outside, root, directoryLinkType)
  try {
    closeFolderFsRoot(root, one)
    const kept = await folderFsCall(root, 'read', { path: 'README.md' }, {}, two) as { bytes: Uint8Array }
    assert.equal(Buffer.from(kept.bytes).toString(), '# hi')
  } finally {
    closeFolderFsRoot(root)
    await rm(root, { force: true })
    await rm(moved, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('휴지통 실패는 연결 해제 중에도 원본을 되돌린다', async () => {
  const root = await project()
  try {
    await assert.rejects(() => runFolderOp(root, { op: 'delete', paths: ['README.md'] }, {
      trash: async () => {
        closeFolderFsRoot(root)
        throw new Error('trash failed')
      },
    }), /trash failed/)
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# hi')
  } finally {
    closeFolderFsRoot(root)
    await rm(root, { recursive: true, force: true })
  }
})

test('휴지통 실패와 대상 이름 경합은 두 파일을 보존하고 복구 경로를 보고한다', async () => {
  const root = await project()
  let staged = ''
  try {
    await assert.rejects(() => runFolderOp(root, { op: 'delete', paths: ['README.md'] }, {
      trash: async (path) => {
        staged = path
        await writeFile(join(root, 'README.md'), 'new')
        throw new Error('trash failed')
      },
    }), (error: unknown) => {
      assert.ok(error instanceof FolderFsError)
      assert.equal(error.code, 'io_error')
      assert.equal(error.detail.recovery_path, staged)
      return true
    })
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'new')
    assert.equal(await readFile(staged, 'utf8'), '# hi')
  } finally {
    closeFolderFsRoot(root)
    if (staged) await rm(staged, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})
