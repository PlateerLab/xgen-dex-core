/**
 * FUSE 는 **자식 프로세스**가 건다.
 *
 * 왜: 네이티브 바인딩이 Electron 메인에서 SIGSEGV 를 내면 커넥터가 통째로
 * 사라진다 (실기: 클라우드 폴더에 파일을 넣는 순간 앱이 죽었다). 그리고 FUSE
 * 콜백이 메인 루프에 올라오면 자기 마운트를 만지는 동기 호출 하나가 데드락을
 * 만든다 — 그 문제를 세 번 겪었다. 루프가 아예 다르면 규칙 없이도 성립한다.
 *
 * 여기서 고정하는 것은 **경계가 유지되는지**다. 코드가 다시 메인에서 FUSE 를
 * 직접 잡으면 잡아낸다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', 'src', 'main')
const src = (n: string): string => readFileSync(join(SRC, n), 'utf-8')

test('워크스페이스 매니저는 FUSE 를 직접 마운트하지 않는다', () => {
  const s = src('workspace-manager.ts')
  assert.ok(!s.includes('mountFuse('), '메인에서 mountFuse 를 직접 부른다 — 자식 프로세스 경계가 무너졌다')
  assert.match(s, /spawnFuseHost/, '자식 호스트를 띄우지 않는다')
})

test('자식은 Electron 을 Node 모드로 실행한다 (앱에 별도 Node 가 없다)', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /process\.execPath/, '실행 파일을 지정하지 않는다')
  assert.match(fn, /ELECTRON_RUN_AS_NODE/, 'Node 모드 지정이 없다 — Electron 앱으로 떠 버린다')
  assert.match(fn, /fuse-host\.js/, '자식 진입점을 가리키지 않는다')
})

test('자식이 죽어도 앱은 살고, 무한 재기동은 하지 않는다', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /child\.on\('exit'/, '자식 종료를 감지하지 않는다')
  assert.match(fn, /hostRestarts/, '재기동 횟수를 세지 않는다 — 죽는 자식을 무한히 다시 띄운다')
})

test('자식이 응답하지 않으면 매달리지 않는다', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /setTimeout\(/, '타임아웃이 없다 — 자식이 조용하면 리컨사일이 영영 안 끝난다')
})

test('자식은 부모가 사라지면 스스로 언마운트한다', () => {
  // 부모가 죽었는데 마운트가 남으면 그 폴더는 이후 모든 접근을 거부한다.
  const s = src('fuse-host.ts')
  assert.match(s, /process\.stdin\.on\('end'/, 'stdin 종료(=부모 소멸)를 감지하지 않는다')
  assert.match(s, /SIGTERM/, '종료 신호를 처리하지 않는다')
})

test('자식은 예외로 죽지 않고 부모에게 알린다', () => {
  const s = src('fuse-host.ts')
  assert.match(s, /uncaughtException/, '자식이 예외 하나로 사라진다')
  assert.match(s, /unhandledRejection/, '거부 하나로 사라진다')
})

test('빌드가 자식 진입점을 실제로 낸다', () => {
  const cfg = readFileSync(join(__dirname, '..', 'electron.vite.config.ts'), 'utf-8')
  assert.match(cfg, /'fuse-host':/, '빌드 설정에 자식 진입점이 없다 — 배포본에 파일이 없다')
})

test('자식 진입점은 __dirname 기준이다 (argv[1] 은 패키징에서 다르다)', () => {
  // process.argv[1] 은 패키징된 앱에서 메인 스크립트가 아니다(실행 인자이거나
  // 비어 있다). 그걸 기준으로 잡았더니 자식이 "Cannot find module" 로 즉시
  // 코드 1 로 죽었고, 화면에는 "연결이 끊겼습니다 (코드 1)" 만 보였다.
  const s = readFileSync(join(SRC, 'workspace-manager.ts'), 'utf-8')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.ok(fn.includes("join(__dirname, 'fuse-host.js')"), '진입점을 __dirname 기준으로 찾지 않는다')
  // 주석은 계약을 설명하려고 그 이름을 적는다 — 코드만 본다.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!code.includes('process.argv[1]'), 'argv[1] 을 다시 쓰고 있다')
})

test('자식이 말하기 전에 죽으면 즉시 실패로 끝낸다', () => {
  // 안 그러면 20초를 기다린 뒤에야 "원인 미상" 이 된다.
  const s = readFileSync(join(SRC, 'workspace-manager.ts'), 'utf-8')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /child\.once\('exit'/, '조기 종료를 감지하지 않는다')
  assert.match(fn, /lastStderr/, '자식이 남긴 사유를 화면에 싣지 않는다')
})
