/**
 * 사용자 PC 접속(UserPc)의 내장 셸 — 휴대폰·브라우저가 연결 폴더에서 bash 명령을 돌린다.
 *
 * 가짜 폴더는 휴대폰처럼 글로만 읽어 준다(바이트를 주지 못한다). 그래서 바이너리를 옮기는 cp·mv 가
 * 읽어서 쓰지 않고 기기의 복사로 가는지가 중요하다 — 사진이 깨지면 안 된다.
 */
import assert from 'assert'
import { test } from 'node:test'
import * as jb from 'just-bash/browser'
import {
  FolderShell,
  USER_PC_JOB_TOOL,
  USER_PC_RUN_TOOL,
  outcomeText,
  uniqueMountNames,
  userPcToolSchemas,
  type JustBashModule,
  type ShellFolderEntry,
  type ShellFolderOps,
} from '@dex/protocol/user-pc-shell'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** 글로만 읽어 주는 폴더(휴대폰과 같다). 지운 것·복사한 것을 적어 둔다. */
function phoneFolder(files: Record<string, string | Uint8Array>) {
  const data = new Map<string, Uint8Array>()
  const dirs = new Set<string>([''])
  const copies: string[] = []
  const addDirs = (rel: string) => {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const [rel, body] of Object.entries(files)) {
    data.set(rel, typeof body === 'string' ? encoder.encode(body) : body)
    addDirs(rel)
  }
  const children = (rel: string): ShellFolderEntry[] => {
    const prefix = rel ? `${rel}/` : ''
    const out = new Map<string, ShellFolderEntry>()
    for (const d of dirs) {
      if (d && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        out.set(d.slice(prefix.length), { name: d.slice(prefix.length), isDir: true, size: 0 })
      }
    }
    for (const [f, body] of data) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.set(f.slice(prefix.length), { name: f.slice(prefix.length), isDir: false, size: body.length })
      }
    }
    return [...out.values()]
  }
  const ops: ShellFolderOps = {
    async list(rel) {
      if (!dirs.has(rel)) throw new Error(`폴더를 찾을 수 없습니다: ${rel}`)
      return children(rel)
    },
    async stat(rel) {
      if (dirs.has(rel)) return { exists: true, isDir: true, size: 0 }
      const body = data.get(rel)
      return body ? { exists: true, isDir: false, size: body.length } : { exists: false, isDir: false, size: 0 }
    },
    async read(rel) {
      const body = data.get(rel)
      if (!body) throw new Error(`파일이 없습니다: ${rel}`)
      return decoder.decode(body) // 휴대폰은 글로만 준다
    },
    async write(rel, body, append) {
      const bytes = typeof body === 'string' ? encoder.encode(body) : body
      const prev = append ? (data.get(rel) ?? new Uint8Array()) : new Uint8Array()
      const next = new Uint8Array(prev.length + bytes.length)
      next.set(prev)
      next.set(bytes, prev.length)
      data.set(rel, next)
      addDirs(rel)
    },
    async remove(rel) {
      for (const f of [...data.keys()]) if (f === rel || f.startsWith(`${rel}/`)) data.delete(f)
      for (const d of [...dirs]) if (d === rel || d.startsWith(`${rel}/`)) dirs.delete(d)
    },
    async mkdir(rel) {
      dirs.add(rel)
      addDirs(`${rel}/x`)
    },
    async copy(from, to) {
      copies.push(`${from}->${to}`)
      data.set(to, data.get(from)!)
      addDirs(to)
    },
  }
  return { ops, data, dirs, copies }
}

const shellInfo = { label: 'bash (built in: file and text commands)', note: 'folders appear as /<folder name>' }
const shell = () => new FolderShell(async () => jb as unknown as JustBashModule, shellInfo)

test('도구 이름·스키마는 데스크톱과 같은 약속이고 셸은 meta 로 알린다', () => {
  const [run, job] = userPcToolSchemas(shellInfo)
  assert.equal(run.name, USER_PC_RUN_TOOL)
  assert.deepEqual(run.meta, { shell: shellInfo.label, shell_note: shellInfo.note })
  assert.equal(job.name, USER_PC_JOB_TOOL)
  assert.deepEqual(uniqueMountNames(['docs', 'docs', '', 'a/b']), ['docs', 'docs (2)', 'folder3', 'a_b'])
})

test('연결 폴더에서 찾고 고치고 만든다(파일·글 명령)', async () => {
  const phone = phoneFolder({
    'notes.txt': 'hello\nTODO: 제목\n',
    'sub/깊은폴더/결과발표_1장.pptx': new Uint8Array([0x50, 0x4b, 3, 4]),
  })
  const sh = shell()
  const run = (command: string) => sh.run({ command, mounts: [{ name: 'Docs', ops: phone.ops }], key: 'c1', waitMs: 10_000 })

  const found = await run("find . -iname '*결과발표*'")
  assert.equal(found.exit_code, 0, found.stderr)
  assert.equal(found.stdout, './sub/깊은폴더/결과발표_1장.pptx\n')
  assert.equal(found.cwd, '/Docs')
  assert.equal((await run('pwd')).stdout, '/Docs\n')

  const edited = await run("sed -i 's/hello/HELLO/' notes.txt && grep -n TODO notes.txt")
  assert.equal(edited.exit_code, 0, edited.stderr)
  assert.equal(edited.stdout, '2:TODO: 제목\n')
  assert.equal(decoder.decode(phone.data.get('notes.txt')), 'HELLO\nTODO: 제목\n')

  const made = await run('mkdir -p out/logs && echo done > out/logs/a.txt && cat out/logs/a.txt && ls out')
  assert.equal(made.exit_code, 0, made.stderr)
  assert.equal(made.stdout, 'done\nlogs\n')

  const failed = await run('cat nope.txt')
  assert.notEqual(failed.exit_code, 0)
  assert.match(failed.stderr, /No such file/)
})

test('cp·mv 는 기기의 복사로 바이트를 그대로 옮긴다(사진이 깨지지 않는다)', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x80, 0x81])
  const phone = phoneFolder({ 'DCIM/a.jpg': jpeg })
  const sh = shell()
  const out = await sh.run({
    command: 'mkdir -p backup && cp DCIM/a.jpg backup/a.jpg && mv DCIM/a.jpg DCIM/b.jpg && ls DCIM backup',
    mounts: [{ name: 'Phone', ops: phone.ops }],
    key: 'c2',
    waitMs: 10_000,
  })
  assert.equal(out.exit_code, 0, out.stderr)
  assert.deepEqual(phone.data.get('backup/a.jpg'), jpeg)
  assert.deepEqual(phone.data.get('DCIM/b.jpg'), jpeg)
  assert.equal(phone.data.has('DCIM/a.jpg'), false)
  assert.deepEqual(phone.copies, ['DCIM/a.jpg->backup/a.jpg', 'DCIM/a.jpg->DCIM/b.jpg'])
})

test('폴더 여럿은 /<이름> 으로 나란히 붙고, 그 밖은 보이지 않는다', async () => {
  const a = phoneFolder({ 'x.txt': 'from a\n' })
  const b = phoneFolder({ 'x.txt': 'from b\n' })
  const sh = shell()
  const mounts = [
    { name: 'docs', ops: a.ops },
    { name: 'docs', ops: b.ops },
  ]
  const out = await sh.run({ command: 'cat "/docs (2)/x.txt"; ls /', mounts, key: 'c3', waitMs: 10_000 })
  assert.equal(out.exit_code, 0, out.stderr)
  const lines = out.stdout.split('\n')
  assert.equal(lines[0], 'from b')
  assert.ok(lines.includes('docs') && lines.includes('docs (2)'))
  await assert.rejects(
    sh.run({ command: 'ls', cwd: '/elsewhere', mounts, key: 'c3' }),
    /PATH_DOMAIN_MISMATCH/,
  )
  const second = await sh.run({ command: 'pwd', cwd: '/docs (2)', mounts, key: 'c3', waitMs: 10_000 })
  assert.equal(second.stdout, '/docs (2)\n')
})

test('기다리는 시간을 넘긴 명령은 작업으로 이어지고 확인·멈춤이 된다', async () => {
  const phone = phoneFolder({})
  const sh = shell()
  const mounts = [{ name: 'p', ops: phone.ops }]
  const started = await sh.run({ command: 'sleep 1.5; echo end', mounts, key: 'c4', waitMs: 1_000 })
  assert.equal(started.running, true)
  assert.ok(started.job_id)
  assert.match(outcomeText(started), /still running as job/)
  const done = await sh.job(started.job_id!, 'c4', 'poll', 5_000)
  assert.equal(done.running, false)
  assert.equal(done.exit_code, 0)
  assert.equal(done.stdout, 'end\n')
  await assert.rejects(sh.job(started.job_id!, 'other', 'poll'), /No job/)

  const long = await sh.run({ command: 'sleep 30', mounts, key: 'c4', waitMs: 1_000 })
  const stopped = await sh.job(long.job_id!, 'c4', 'stop')
  assert.equal(stopped.running, false)
  assert.match(stopped.stderr, /stopped/)

  const again = await sh.run({ command: 'sleep 30', mounts, key: 'c4', waitMs: 1_000 })
  assert.equal(sh.stopOutside('c4', ['other-folder']), 1)
  const after = await sh.job(again.job_id!, 'c4', 'poll', 3_000)
  assert.equal(after.running, false)
})

test('취소 신호가 오면 기다리지 않고 끝낸다', async () => {
  const sh = shell()
  const abort = new AbortController()
  const t0 = Date.now()
  setTimeout(() => abort.abort(), 300)
  const out = await sh.run({
    command: 'sleep 30',
    mounts: [{ name: 'p', ops: phoneFolder({}).ops }],
    key: 'c5',
    waitMs: 20_000,
    signal: abort.signal,
  })
  assert.ok(Date.now() - t0 < 5_000)
  assert.equal(out.running, false)
})

test('기기가 싣지 않은 명령은 등록하지 않는다(which 가 없다고 답한다)', async () => {
  const sh = new FolderShell(async () => jb as unknown as JustBashModule, shellInfo, ['html-to-markdown', 'gzip'])
  const out = await sh.run({
    command: 'which gzip html-to-markdown; echo rc=$?; which grep',
    mounts: [{ name: 'p', ops: phoneFolder({}).ops }],
    key: 'c6',
    waitMs: 10_000,
  })
  assert.equal(out.stdout, 'rc=1\n/usr/bin/grep\n')
})
