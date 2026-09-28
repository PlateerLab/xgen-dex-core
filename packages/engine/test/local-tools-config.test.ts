/**
 * 로컬 도구 설정 — 남은 값은 위험 명령 사전 승인 하나다.
 *
 * 그리고 명령 시간 제한은 이제 설정이 아니라 상수다. 그 상수가 서버의
 * ``MCP_CALL_TIMEOUT_S`` 와 같은 값이라는 사실을 여기서 지킨다: 둘이 갈라지면
 * 짧은 쪽이 이겨서 긴 명령이 결과 없이 끊긴다.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dangerousApprovalFromConfig,
  defaultLocalToolsConfig,
  normalizeLocalToolsConfig,
} from '../src/local-tools-config'
import { LOCAL_COMMAND_TIMEOUT_MS } from '../src/local-tools'

// 2026-09-08 실측: 여기 기본값은 120초, 서버 브릿지도 120초, 그런데 서버의 동기
// 폴백 경로는 130초로 따로 굳어 있었다. 2분이라는 값 자체도 자주 틀렸다 — 설치·
// 빌드·큰 검색은 2분을 넘고, 넘을 때마다 결과 없이 2분을 버렸다.
test('명령 시간 제한은 10분 — 서버 MCP_CALL_TIMEOUT_S 와 같은 값', () => {
  assert.equal(LOCAL_COMMAND_TIMEOUT_MS, 600_000)
})

test('기본은 위험 명령을 미리 승인하지 않는다', () => {
  assert.deepEqual(defaultLocalToolsConfig(), { allowDangerous: false })
  assert.equal(dangerousApprovalFromConfig(defaultLocalToolsConfig()), undefined)
})

test('옛 설정의 켜기·허용 폴더 같은 값은 읽지 않는다 — 범위는 대화의 폴더가 정한다', () => {
  assert.deepEqual(
    normalizeLocalToolsConfig({
      enabled: true,
      shellEnabled: true,
      cwd: '/home/me',
      allowedRoots: ['/'],
      allowDangerous: true,
    }),
    { allowDangerous: true },
  )
  assert.deepEqual(normalizeLocalToolsConfig('garbage'), { allowDangerous: false })
})

test('미리 승인하면 물을 사람이 없어도 "대화 내내 허용"으로 답한다', async () => {
  const approve = dangerousApprovalFromConfig({ allowDangerous: true })
  assert.ok(approve)
  assert.equal(await approve!('rm -rf build'), 'session')
})
