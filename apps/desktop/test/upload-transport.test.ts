/**
 * 업로드 전송 계약 — `HttpSyncTransport.put` 이 지켜야 하는 것.
 *
 * 이 전송 계층은 설정된 XGEN 서버의 인증서 정책을 공유하려고 Electron
 * `net.fetch`(Chromium 네트워크 스택)를 주입받는다. Chromium 의 fetch 는
 * Node(undici)와 받아 주는 것이 다르고, 어긋나면 **요청이 나가기도 전에**
 * 거부되어 사용자에게는 커널의 EIO 한 줄만 도착한다. 실기에서 드라이브 복사가
 * 그렇게 죽었다 (2026-08-06). 소스로 고정한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'

test('업로드가 스트림 바디를 쓰지 않는다 (Electron net.fetch 는 못 받는다)', () => {
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(!/duplex\s*:/.test(src), "duplex 옵션이 있다 — Node 전용 스트림 업로드다")
  assert.ok(
    !/body\s*:\s*Readable\.toWeb/.test(src),
    'body 로 ReadableStream 을 보낸다 — net.fetch 가 거부한다',
  )
})

test('업로드 실패는 서버가 준 이유를 메시지에 남긴다', () => {
  // 조립 방식이 아니라 **의도**를 고정한다: 실패 경로는 전부 httpError() 를
  // 지나야 하고(서버 본문을 읽어 메시지에 싣는다), 상태코드만 남기는 직접
  // 조립이 남아 있으면 안 된다.
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.match(src, /throw await httpError\('put', res\)/, '업로드 실패가 헬퍼를 안 지난다')
  const bare = src.match(/new Error\(`\w[\w ]* HTTP \$\{[^}]+\}`\)/g) ?? []
  assert.deepEqual(bare, [], `서버 사유를 버리는 지점이 남았다: ${bare.join(', ')}`)
})

test('업로드가 Chromium 금지 헤더를 붙이지 않는다 (net.fetch 가 요청을 거부한다)', () => {
  // Electron net.fetch(Chromium 네트워크 스택)는 Content-Length 같은 *금지
  // 헤더*가 붙으면 요청을 **보내기도 전에** 거부한다:
  //     net::ERR_INVALID_ARGUMENT
  // 실기에서 단일 PUT 이 전부 이렇게 죽었고, 헤더를 안 붙이는 청크 업로드
  // 경로만 멀쩡했다. 드라이브 복사가 close() 에서 EIO 로 끝난 원인이다.
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const FORBIDDEN = ['Content-Length', 'Host', 'Connection', 'Transfer-Encoding']
  for (const h of FORBIDDEN) {
    assert.ok(
      !new RegExp(`['"\`]${h}['"\`]\\s*:`, 'i').test(src),
      `${h} 헤더를 직접 설정한다 — net.fetch 가 요청을 거부한다`,
    )
  }
})
