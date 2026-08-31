/**
 * 테스트 하네스 자체의 안전장치.
 *
 * `npm test` 는 파일을 하나씩 나열한다 (Windows 의 npm 은 cmd.exe 라 셸
 * 글로브가 확장되지 않는다). 그래서 새 테스트 파일을 만들고 스크립트에
 * 추가하는 걸 잊으면 **CI 가 조용히 그 파일을 건너뛴다** — 실제로 v1.5.1 에서
 * 새 테스트 9개가 3-OS CI 에서 한 번도 돌지 않은 채 통과했다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

test('모든 test/*.test.ts 파일이 npm test 스크립트에 들어 있다', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const script: string = pkg.scripts?.test ?? ''
  const files = readdirSync(here).filter((f) => f.endsWith('.test.ts')).sort()
  assert.ok(files.length > 0, '테스트 파일을 찾지 못했다')
  const missing = files.filter((f) => !script.includes(`test/${f}`))
  assert.deepEqual(
    missing,
    [],
    `npm test 스크립트에 빠진 파일이 있다 (CI 가 조용히 건너뛴다): ${missing.join(', ')}`,
  )
})
