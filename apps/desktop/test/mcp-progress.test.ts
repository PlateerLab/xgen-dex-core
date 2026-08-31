/**
 * 첫 실행 대기 규칙 — `uvx mcp-atlassian` 은 처음 한 번 CPython(24MB)과
 * lxml·cryptography 를 내려받는다. 고정 20초 타임아웃으로는 절대 성공할 수
 * 없었다(사용자 신고). "출력이 나오는 동안은 기다리고, 멈추면 끊는다".
 */
import assert from 'assert'
import { test } from 'node:test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { getMcpManager, tailLines, throttle, waitWhileProgressing } from '../src/main/mcp-manager'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'fake-mcp-server.mjs')
const SLOW = join(here, 'fixtures', 'slow-start-mcp-server.mjs')

const never = new Promise<never>(() => {})

test('출력이 계속 나오면 유휴 한도를 넘겨도 기다린다', async () => {
  let last = Date.now()
  const beat = setInterval(() => (last = Date.now()), 20) // 20ms 마다 '진행 중'
  const done = new Promise<string>((r) => setTimeout(() => r('완료'), 500))
  // 유휴 한도 100ms — 심장박동이 없으면 진작 끊겼을 시간이다.
  const got = await waitWhileProgressing(done, () => last, '테스트', 100, 5000)
  clearInterval(beat)
  assert.equal(got, '완료')
})

test('출력이 멈추면 유휴 한도에서 끊는다', async () => {
  const frozen = Date.now()
  const started = Date.now()
  await assert.rejects(
    () => waitWhileProgressing(never, () => frozen, '연결', 200, 5000),
    /200초|초 동안 아무 응답이 없어 중단/,
  )
  assert.ok(Date.now() - started < 1500, '유휴 한도 근처에서 끊겨야 한다')
})

test('아무리 진행 중이어도 전체 상한은 넘지 않는다', async () => {
  const alive = () => Date.now() // 항상 방금 출력한 것처럼
  await assert.rejects(
    () => waitWhileProgressing(never, alive, '연결', 100_000, 400),
    /분을 넘겨 중단/,
  )
})

test('이미 끝난 작업은 대기 규칙과 무관하게 즉시 반환한다', async () => {
  const frozen = 0 // 아주 오래전 = 즉시 유휴 판정될 값
  assert.equal(await waitWhileProgressing(Promise.resolve(7), () => frozen, 'x', 1, 1), 7)
})

test('throttle: 몰아치는 진행 로그를 간격으로 눌러 준다', async () => {
  const seen: number[] = []
  const push = throttle<number>((v) => seen.push(v), 50)
  for (let i = 0; i < 100; i++) push(i)
  assert.equal(seen.length, 1, '첫 호출은 즉시 통과')
  assert.equal(seen[0], 0)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(seen.length, 2, '나머지는 하나로 합쳐 뒤늦게 한 번')
  assert.equal(seen[1], 99, '가장 최근 값이어야 한다')
})

test('느리게 기동하는 서버도 출력만 있으면 끝까지 붙는다 (실기동)', async () => {
  // fixture 는 1.2초 동안 진행 로그를 뱉은 뒤 정상 MCP 서버가 된다.
  const mgr = getMcpManager()
  const progress: string[][] = []
  const res = await mgr.test(
    { name: 'slow', transport: 'stdio', command: process.execPath, args: [SLOW] },
    (lines) => progress.push(lines),
  )
  assert.ok(res.ok, `느린 기동에서 실패했다: ${res.error} ${JSON.stringify(res.hints)}`)
  assert.ok(progress.length > 0, '진행 상황이 UI 로 전달돼야 한다')
  assert.ok(
    progress.at(-1)!.some((l) => /Downloading/.test(l)),
    `다운로드 진행 줄이 보여야 한다: ${JSON.stringify(progress.at(-1))}`,
  )
  await mgr.closeAll()
})

test('빠른 서버는 여전히 즉시 붙는다 (회귀 방지)', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({ name: 'fast', transport: 'stdio', command: process.execPath, args: [FIXTURE] })
  assert.ok(res.ok, res.error)
  await mgr.closeAll()
})

test('tailLines 는 진행 로그의 마지막 상태만 남긴다', () => {
  const log = ['Downloading cpython (24.0MiB)', 'Downloading lxml (8.2MiB)', 'Downloaded lxml'].join('\n')
  assert.deepEqual(tailLines(log, 2), ['Downloading lxml (8.2MiB)', 'Downloaded lxml'])
})

test('여러 서버를 병렬로 붙인다 — 느린 하나가 나머지를 막지 않는다', async () => {
  const mgr = getMcpManager()
  mgr.configure([
    { name: 'slow1', transport: 'stdio', command: process.execPath, args: [SLOW] },
    { name: 'slow2', transport: 'stdio', command: process.execPath, args: [SLOW] },
    { name: 'slow3', transport: 'stdio', command: process.execPath, args: [SLOW] },
  ])
  const t0 = Date.now()
  const adverts = await mgr.advertise()
  const elapsed = Date.now() - t0
  assert.equal(adverts.length, 3)
  assert.ok(adverts.every((a) => a.connected), JSON.stringify(adverts))
  // fixture 하나가 ~1.2초. 순차라면 3.6초 이상 걸린다.
  assert.ok(elapsed < 3000, `순차로 붙고 있다 (${elapsed}ms)`)
  assert.deepEqual(adverts.map((a) => a.name), ['slow1', 'slow2', 'slow3'], '설정 순서를 지켜야 한다')
  await mgr.closeAll()
})

test('한 번 실패한 서버도 다시 붙으면 오류가 지워진다', async () => {
  // 사용자 사례: uv 를 나중에 설치했는데 예전 실패 문구가 계속 떠 있었다.
  const marker = join(mkdtempSync(join(tmpdir(), 'flaky-')), 'installed')
  const mgr = getMcpManager()
  mgr.configure([
    {
      name: 'flaky',
      transport: 'stdio',
      command: process.execPath,
      args: [join(here, 'fixtures', 'flaky-mcp-server.mjs')],
      env: { FLAKY_MARKER: marker },
    },
  ])

  const first = await mgr.advertise()
  assert.equal(first[0].connected, false)
  assert.ok(first[0].error, '첫 시도는 실패해야 한다')

  writeFileSync(marker, 'ok') // ← 사용자가 런타임을 설치한 시점

  const second = await mgr.advertise()
  assert.equal(second[0].connected, true, `재시도가 안 됐다: ${second[0].error}`)
  assert.equal(second[0].error, undefined, '낡은 오류 문구가 남아 있다')
  assert.equal(second[0].tools.length, 1)
  await mgr.closeAll()
})
