/** args 배열이 실제 프로세스 spawn 까지 손실 없이 전달되는지 (실기동 검증). */
import assert from 'assert'
import { test } from 'node:test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { getMcpManager, tailLines } from '../src/main/mcp-manager'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'fake-mcp-server.mjs')

test('args 의 공백 포함 인자와 env 가 그대로 서버에 도달한다', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,           // node 실행 파일 (경로에 공백이 있어도 안전)
    args: [FIXTURE, '--path', '/Users/me/My Docs', '--json={"a":1}'],
    env: { FAKE_TOKEN: 'tok-123' },
  })
  assert.ok(res.ok, `연결 실패: ${res.error ?? ''}`)
  const tool = (res.tools ?? []).find((t) => t.name === 'echo_argv')
  assert.ok(tool, `도구 목록에 echo_argv 없음: ${JSON.stringify(res.tools)}`)
  const desc = (tool as { description?: string }).description ?? ''
  assert.ok(desc.includes('"/Users/me/My Docs"'), `공백 인자 손실: ${desc}`)
  assert.ok(desc.includes('--json={\\"a\\":1}') || desc.includes('--json={"a":1}'), `따옴표 인자 손실: ${desc}`)
  assert.ok(desc.includes('tok-123'), `env 전달 실패: ${desc}`)
  await mgr.closeAll()
})

test('args 없이 한 줄 명령이면 따옴표 인식 분해로 동작한다 (기존 경로)', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'fake2',
    transport: 'stdio',
    command: `"${process.execPath}" "${FIXTURE}" --path "/tmp/a b"`,
  })
  assert.ok(res.ok, `연결 실패: ${res.error ?? ''}`)
  const desc = (res.tools ?? []).find((t) => t.name === 'echo_argv')?.description ?? ''
  assert.ok(desc.includes('/tmp/a b'), `한 줄 명령의 인용 인자 손실: ${desc}`)
  await mgr.closeAll()
})

test('PATH 에 없는 명령은 ENOENT 대신 안내 오류를 준다', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'missing',
    transport: 'stdio',
    command: 'definitely-not-installed-xyz',
  })
  assert.equal(res.ok, false)
  assert.ok(
    /찾을 수 없습니다/.test(res.error ?? '') && !/ENOENT/.test(res.error ?? ''),
    `안내 오류가 아니라 raw 오류였다: ${res.error}`,
  )
  assert.ok((res.hints?.length ?? 0) > 0, '해결 방법을 함께 줘야 한다')
  await mgr.closeAll()
})

test('미설치 런타임(uvx 류)은 설치 안내까지 UI 로 전달된다', async () => {
  // 사용자의 mac 재현: `zsh: command not found: uvx`.
  // 이 머신에 uvx 가 실제로 깔려 있어도 진단 경로를 타도록, 존재하지 않는
  // 디렉터리를 붙인 경로형 명령을 쓴다 (경로형은 PATH 를 뒤지지 않는다).
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'atlassian',
    transport: 'stdio',
    command: join(tmpdir(), '__xgen_absent__', 'uvx'),
    args: ['mcp-atlassian'],
  })
  assert.equal(res.ok, false)
  assert.ok(/uv/.test(res.error ?? ''), `런타임 이름을 알려야 한다: ${res.error}`)
  assert.ok(/설치가 필요합니다/.test(res.error ?? ''), `미설치임을 말해야 한다: ${res.error}`)
  const hints = res.hints ?? []
  assert.ok(hints.some((h) => h.startsWith('설치: ')), `설치 방법이 없다: ${JSON.stringify(hints)}`)
  assert.ok(hints.some((h) => h.includes('astral.sh')), '공식 안내 링크가 있어야 한다')
  await mgr.closeAll()
})

test('PATH 없이 이름만으로도 사용자 설치 경로에서 해석된다', async () => {
  // node 는 PATH 에 있으므로 절대경로 없이 이름만으로 기동되는지 확인
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'byname',
    transport: 'stdio',
    command: process.platform === 'win32' ? 'node.exe' : 'node',
    args: [FIXTURE],
  })
  assert.ok(res.ok, `이름만으로 해석 실패: ${res.error ?? ''}`)
  await mgr.closeAll()
})

test('기동 실패 시 서버 stderr 의 진짜 원인이 UI 까지 올라온다', async () => {
  // 'MCP error -32000: Connection closed' 만 보여주면 사용자는 고칠 수 없다.
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'failing',
    transport: 'stdio',
    command: process.execPath,
    args: [join(here, 'fixtures', 'failing-mcp-server.mjs')],
  })
  assert.equal(res.ok, false)
  assert.ok(/기동하지 못했습니다/.test(res.error ?? ''), `요약이 없다: ${res.error}`)
  const hints = res.hints ?? []
  assert.ok(
    hints.some((h) => h.includes('ModuleNotFoundError')),
    `stderr 원인이 유실됐다: ${JSON.stringify(hints)}`,
  )
  assert.ok(hints.some((h) => h.includes('pip install mcp-server-thing')), '해결 힌트 줄도 살아야 한다')
  await mgr.closeAll()
})

test('tailLines: 마지막 줄만, 길이 상한을 지켜 남긴다', () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const tail = tailLines(many, 5)
  assert.deepEqual(tail, ['line 35', 'line 36', 'line 37', 'line 38', 'line 39'])
  // 빈 줄/공백 꼬리는 버리고, 너무 긴 줄은 잘라 UI 를 깨뜨리지 않는다
  assert.deepEqual(tailLines('a\n\n  \nb  \n'), ['a', 'b'])
  const [long] = tailLines('x'.repeat(500), 1, 50)
  assert.equal(long.length, 51, '잘라낸 뒤 말줄임 한 글자')
})
