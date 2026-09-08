/**
 * 로컬 컨트롤 설정의 기본값과 정규화.
 *
 * 이 파일이 지키는 것은 값 하나가 아니라 **두 값이 같다는 사실**이다: 이쪽
 * 기본 제한과 서버의 ``MCP_CALL_TIMEOUT_S``. 둘이 갈라지면 짧은 쪽이 이기고,
 * 그러면 설정 화면이 사용자에게 거짓말을 한다.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultLocalToolsConfig, normalizeLocalToolsConfig } from '../src/local-tools-config'

// ── 시간 제한: 서버와 이쪽이 **같은 값**을 믿어야 한다 ────────────────
//
// 2026-09-08 실측: 여기 기본값은 120초, 서버 브릿지도 120초, 그런데 서버의 동기
// 폴백 경로는 130초로 따로 굳어 있었다. 값이 갈라지면 **짧은 쪽이 이기고**, 그러면
// 사용자가 설정 화면에서 제한을 올려도 아무 효과가 없다 — 화면이 거짓말을 한다.
//
// 그리고 2분이라는 값 자체가 자주 틀렸다. 설치·빌드·큰 검색은 2분을 넘고, 넘을
// 때마다 **결과 없이** 2분을 버렸다. 모델은 실패 문자열만 받아 같은 것을 다시
// 불렀고, 그런 호출 20건이 한 턴에서 42분을 태웠다.
test('기본 시간 제한은 10분 — 서버 MCP_CALL_TIMEOUT_S 와 같은 값', () => {
  const d = defaultLocalToolsConfig()
  assert.equal(d.timeoutMs, 600_000)
})

test('사용자가 올린 값은 그대로 산다 (상한 안에서)', () => {
  assert.equal(normalizeLocalToolsConfig({ timeoutMs: 900_000 }).timeoutMs, 900_000)
  // 상한/하한은 넘지 않는다 — 무한 대기도, 0초도 도구를 못 쓰게 만든다.
  assert.equal(normalizeLocalToolsConfig({ timeoutMs: 99_999_999 }).timeoutMs, 3_600_000)
  assert.equal(normalizeLocalToolsConfig({ timeoutMs: 1 }).timeoutMs, 1_000)
  // 값이 없거나 쓰레기면 기본값 — 조용히 0 이 되면 모든 명령이 즉시 실패한다.
  assert.equal(normalizeLocalToolsConfig({}).timeoutMs, 600_000)
  assert.equal(normalizeLocalToolsConfig({ timeoutMs: 'x' }).timeoutMs, 600_000)
})
