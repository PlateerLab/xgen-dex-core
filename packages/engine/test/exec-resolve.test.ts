/** 실행 파일 해석 — GUI 실행에서 uvx/npx 를 못 찾던 ENOENT 의 방어선. */
import assert from 'assert'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { delimiter, join } from 'path'
import {
  buildChildEnv,
  commonBinDirs,
  diagnoseMissing,
  ExecNotFoundError,
  mergePaths,
  parseEnvPath,
  resolveExecutable,
  runtimeFor,
} from '@dex/engine/exec-resolve'
import { bindTestHost, recordingInteraction } from './_host';

// 엔진은 호스트가 붙어야 돈다 — 안 붙이면 명확히 던진다(조용한 폴백 없음).
bindTestHost({ interaction: recordingInteraction('session').port });

const isWin = process.platform === 'win32'

function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, isWin ? `${name}.cmd` : name)
  writeFileSync(file, isWin ? '@echo off\n' : '#!/bin/sh\nexit 0\n')
  if (!isWin) chmodSync(file, 0o755)
  return file
}

test('PATH 에 있는 실행 파일을 절대 경로로 해석한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  const target = fakeBin(bin, 'uvx')
  const resolved = resolveExecutable('uvx', [join(root, 'nope'), bin].join(delimiter))
  // Windows 는 경로 대소문자를 구분하지 않는다 — 비교도 그렇게.
  const norm = (p: string | null) => (p && isWin ? p.toLowerCase() : p)
  assert.equal(norm(resolved), norm(target), 'PATH 순회로 찾지 못했다')
})

test('PATH 에 없으면 null 과 진단', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const p = join(root, 'empty')
  mkdirSync(p, { recursive: true })
  assert.equal(resolveExecutable('uvx', p), null)
  const d = diagnoseMissing('uvx', p)
  assert.ok(d.summary.includes('uvx'), '어떤 명령인지 알려야 한다')
  assert.ok(d.hints.some((h) => /절대 경로/.test(h)), '해결 방법을 안내해야 한다')
})

// ── 미설치 런타임 진단 (사용자 mac: `zsh: command not found: uvx`) ──

test('알려진 런타임을 명령 이름으로 식별한다 (확장자·경로 무시)', () => {
  assert.equal(runtimeFor('uvx')?.label, 'uv')
  assert.equal(runtimeFor('uv')?.label, 'uv')
  assert.equal(runtimeFor('npx')?.label, 'Node.js')
  assert.equal(runtimeFor('NPX.CMD')?.label, 'Node.js', '대소문자/확장자를 흡수해야 한다')
  assert.equal(runtimeFor('/opt/homebrew/bin/node')?.label, 'Node.js', '경로가 붙어도 식별')
  assert.equal(runtimeFor('docker')?.label, 'Docker')
  assert.equal(runtimeFor('my-custom-server'), null, '모르는 명령은 null')
})

test('미설치 런타임이면 설치 방법과 링크를 안내한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })

  const d = diagnoseMissing('uvx', empty)
  assert.ok(/설치가 필요합니다/.test(d.summary), '미설치임을 분명히 말해야 한다')
  assert.ok(d.summary.includes('uv'), '어떤 런타임인지 알려야 한다')
  assert.ok(d.hints.some((h) => h.startsWith('설치: ')), '설치 명령이 있어야 한다')
  assert.ok(d.hints.some((h) => h.includes('astral.sh')), '공식 안내 링크가 있어야 한다')
  assert.ok(
    d.hints.some((h) => /다시 누르면/.test(h)),
    '설치 후 재시도 방법을 알려야 한다 (앱 재시작 불필요)',
  )
})

test('모르는 명령도 경로 지정 방법은 안내한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  const d = diagnoseMissing('totally-unknown-bin', empty)
  assert.ok(d.summary.includes('totally-unknown-bin'))
  assert.ok(d.hints.some((h) => /절대 경로/.test(h)))
  assert.ok(!d.hints.some((h) => h.startsWith('설치: ')), '모르는 런타임에 엉뚱한 설치 명령을 주면 안 된다')
})

test('형제 명령이 있으면 더 정확한 원인을 짚는다 (uv 는 있는데 uvx 가 없음)', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  fakeBin(bin, 'uv') // uv 만 설치된 상태
  assert.equal(resolveExecutable('uvx', bin), null)
  const d = diagnoseMissing('uvx', bin)
  assert.ok(
    d.hints.some((h) => /같은 런타임의 "uv" 는 찾았습니다/.test(h)),
    `형제 명령 발견 사실을 알려야 한다: ${JSON.stringify(d.hints)}`,
  )
})

test('ExecNotFoundError 는 진단을 그대로 실어 나른다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  const err = new ExecNotFoundError(diagnoseMissing('uvx', empty))
  assert.ok(err instanceof Error)
  assert.equal(err.command, 'uvx')
  assert.ok(err.message.includes('uvx'), 'message 가 요약이어야 한다')
  assert.ok(err.hints.length >= 2)
})

test('경로가 포함된 명령은 그대로 검증만 한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const target = fakeBin(join(root, 'bin'), 'tool')
  // 절대 경로 → 그대로 반환
  assert.equal(resolveExecutable(target, ''), target)
  // 존재하지 않는 절대 경로 → null (PATH 를 뒤지지 않는다)
  assert.equal(resolveExecutable(join(root, 'bin', 'ghost'), join(root, 'bin')), null)
})

test('디렉터리는 실행 파일로 취급하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  mkdirSync(join(bin, 'uvx'), { recursive: true }) // 같은 이름의 디렉터리
  assert.equal(resolveExecutable('uvx', bin), null)
})

test('실행 권한이 없는 파일은 건너뛴다 (posix)', (ctx) => {
  if (isWin) return ctx.skip('windows: 실행 권한 개념이 다름')
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const noexec = join(bin, 'uvx')
  writeFileSync(noexec, '#!/bin/sh\n')
  chmodSync(noexec, 0o644)
  assert.equal(resolveExecutable('uvx', bin), null)
  chmodSync(noexec, 0o755)
  assert.equal(resolveExecutable('uvx', bin), noexec)
})

test('mergePaths 는 순서를 지키며 중복/빈 항목을 제거한다', () => {
  const merged = mergePaths('/a', `/b${delimiter}/a`, '', undefined, `/c${delimiter}`)
  assert.deepEqual(merged.split(delimiter), ['/a', '/b', '/c'])
})

test('commonBinDirs 는 사용자 설치 위치를 포함한다', () => {
  const dirs = commonBinDirs(homedir())
  const joined = dirs.join(delimiter)
  // uv/uvx 의 기본 설치 위치 — ENOENT 사고의 주인공
  assert.ok(joined.includes(join(homedir(), '.local', 'bin')), '~/.local/bin 이 빠졌다')
  assert.ok(dirs.length >= 5)
})

test('실제 시스템 명령을 해석할 수 있다 (스모크)', () => {
  const known = isWin ? 'cmd' : 'sh'
  const resolved = resolveExecutable(known, process.env.PATH ?? '')
  assert.ok(resolved, `${known} 를 PATH 에서 찾지 못했다`)
})

// ── 셸 PATH 수집 (fish 처럼 $PATH 가 리스트인 셸까지) ──────────────────

test('env 출력에서 PATH 를 뽑는다 — rc 잡음이 앞에 있어도', () => {
  const real = process.env.PATH ?? ''
  const out = ['Welcome to fish!', 'HOME=/home/me', `PATH=${real}`, 'TERM=xterm'].join('\n')
  assert.equal(parseEnvPath(out), real)
})

test('PATH 줄이 여러 번 나오면 마지막(=실제 env) 을 택한다', () => {
  const real = process.env.PATH ?? ''
  const out = ['PATH=/bogus/from/rc/echo', 'HOME=/home/me', `PATH=${real}`].join('\n')
  assert.equal(parseEnvPath(out), real)
})

test('실재 디렉터리가 하나도 없으면 잘못 파싱한 것으로 보고 버린다', () => {
  // fish 에서 `printf "$PATH"` 를 쓰면 공백으로 이어져 이런 값이 나왔다.
  assert.equal(parseEnvPath('PATH=/nope/a /nope/b'), null)
  assert.equal(parseEnvPath('PATH='), null)
  assert.equal(parseEnvPath('HOME=/home/me'), null)
})

// ── 자식 프로세스 환경 ────────────────────────────────────────────────

test('보강된 PATH 를 자식 env 에 넣고 나머지는 보존한다', () => {
  const env = buildChildEnv('/x/bin', { API_TOKEN: 'secret' }, { HOME: '/home/me', PATH: '/old' })
  assert.equal(env.API_TOKEN, 'secret')
  assert.equal(env.HOME, '/home/me')
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  assert.equal(pathKeys.length, 1, `path 키가 하나여야 한다: ${pathKeys.join(',')}`)
  assert.equal(env[pathKeys[0]], '/x/bin')
})

test('서버 설정이 PATH 를 직접 지정하면 그 값을 존중한다', () => {
  const env = buildChildEnv('/x/bin', { PATH: '/only/this' }, { PATH: '/old' })
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  assert.equal(pathKeys.length, 1)
  assert.equal(env[pathKeys[0]], '/only/this')
})

test('Windows 대소문자 혼용(Path/PATH)이 섞여도 키는 하나만 남는다', (ctx) => {
  if (!isWin) return ctx.skip('windows 전용 — 환경변수 대소문자 무시 규칙')
  // 실제 Windows 의 process.env 는 'Path' 로 들어온다. 여기에 'PATH' 를 더하면
  // cross-spawn(path-key)이 어느 쪽을 볼지 알 수 없어진다.
  const env = buildChildEnv('C:\\x\\bin', undefined, { Path: 'C:\\old', PATH: 'C:\\other' })
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  assert.equal(pathKeys.length, 1, `path 키가 하나여야 한다: ${pathKeys.join(',')}`)
  assert.equal(env[pathKeys[0]], 'C:\\x\\bin')
})

test('undefined 값은 자식 env 에 넣지 않는다', () => {
  const env = buildChildEnv('/x/bin', undefined, { A: 'a', B: undefined })
  assert.equal(env.A, 'a')
  assert.ok(!('B' in env), 'undefined 는 빈 문자열로 새어 들어가면 안 된다')
})
