/**
 * @cocalc/fuse-native 를 Electron 에서 쓸 수 있게 패치하고 다시 빌드한다.
 *
 * 왜 필요한가: 이 라이브러리는 read/write 의 버퍼를 `napi_create_external_buffer`
 * 로 만든다. **Electron 은 이 API 를 금지한다**(V8 포인터 압축). C 코드가 반환값을
 * 확인하지 않아 argv 슬롯이 채워지지 않은 채 JS 로 넘어오고, JS 는 Buffer 대신
 * 초기화 안 된 값(라이브러리 자기 디스패처 함수)을 받는다.
 *
 * 증상: 목록·읽기는 되는데 **파일을 쓰면 Electron 메인이 SIGSEGV 로 죽는다**.
 * 실기 신고 "클라우드 폴더에 파일을 넣으면 커넥터가 크래시" 가 정확히 이것이다.
 * plain Node 에서는 재현되지 않아 오래 안 드러났다.
 *
 * 패치: 외부 버퍼 대신 복사본을 넘긴다. write 는 JS 가 읽기만 하므로 그대로 되고,
 * read 는 JS 가 채운 내용을 signal 시점에 커널 버퍼로 되돌려 복사한다.
 */
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const dir = join(process.cwd(), 'node_modules', '@cocalc', 'fuse-native')
if (!existsSync(dir)) {
  console.log('[patch-fuse] @cocalc/fuse-native 없음 — 건너뜀 (이 플랫폼은 FUSE 미사용)')
  process.exit(0)
}
if (!readFileSync(join(dir, 'fuse-native.c'), 'utf8').includes('napi_create_external_buffer')) {
  console.log('[patch-fuse] 이미 패치됨')
  process.exit(0)
}
try {
  execFileSync('patch', ['-p0', '-i', join(process.cwd(), 'patches', 'fuse-native.c.patch')], {
    cwd: process.cwd(), stdio: 'inherit',
  })
  execFileSync('npx', ['node-gyp', 'rebuild'], { cwd: dir, stdio: 'inherit' })
  console.log('[patch-fuse] 패치 + 재빌드 완료')
} catch (e) {
  // 빌드 도구가 없는 환경(CI 의 win/mac 잡)에서 설치가 통째로 실패하면 안 된다.
  console.log(`[patch-fuse] 실패(무시): ${e.message}`)
}
