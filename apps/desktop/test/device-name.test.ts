/**
 * 이 PC 의 이름 — 클라우드 안에서 폴더가 되는 그 이름.
 *
 *     {XgenCloud} / {PC 이름} / (파일)
 *
 * **로컬 로그인 이름은 여기 들어갈 이유가 없다.** 클라우드는 이미 XGEN 계정으로
 * 갈린다 — A 계정의 클라우드에 닿을 수 있는 것은 A 로 로그인한 커넥터뿐이다.
 * 그 안에서 폴더를 나누는 축은 "누구" 가 아니라 "어느 기기" 다.
 *
 * 그런데 리눅스·맥 설치 과정이 호스트명을 `{로그인이름}-{모델}` 로 만들어 두는
 * 일이 흔하다. 그대로 쓰면 `hrjang-Crosshair-17-HX-D14VGKG` 같은 폴더가
 * 생긴다 — 앞의 `hrjang` 은 이 트리에서 아무것도 구분하지 않는 잡음이다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { defaultDeviceName } from '../src/main/device-name'

test('호스트명 앞의 로컬 로그인 이름을 걷어낸다', () => {
  assert.equal(
    defaultDeviceName('hrjang-Crosshair-17-HX-D14VGKG', 'hrjang'),
    'Crosshair-17-HX-D14VGKG',
  )
})

test('구분자가 무엇이든 걷어낸다', () => {
  assert.equal(defaultDeviceName('hrjang_desktop', 'hrjang'), 'desktop')
  assert.equal(defaultDeviceName('hrjang.local', 'hrjang'), 'local')
  // macOS 가 흔히 만드는 형태
  assert.equal(defaultDeviceName('hrjangs-MacBook-Pro', 'hrjang'), 'MacBook-Pro')
})

test('대소문자가 달라도 알아본다', () => {
  assert.equal(defaultDeviceName('HRJang-Studio', 'hrjang'), 'Studio')
})

test('걷어내면 남는 게 없으면 원래 이름을 쓴다', () => {
  // 이름 없는 폴더는 만들 수 없다 — 잡음이 있는 편이 낫다.
  assert.equal(defaultDeviceName('hrjang', 'hrjang'), 'hrjang')
  assert.equal(defaultDeviceName('hrjang-', 'hrjang'), 'hrjang-')
})

test('로그인 이름과 무관한 호스트명은 건드리지 않는다', () => {
  for (const h of ['DESKTOP-4F2A9', 'office-nas', 'Crosshair-17']) {
    assert.equal(defaultDeviceName(h, 'hrjang'), h, `건드리지 말아야 할 이름을 바꿨다: ${h}`)
  }
})

test('중간에 들어 있는 로그인 이름은 접두사가 아니다', () => {
  // `lab-hrjang-01` 의 `hrjang` 은 기기 이름의 일부일 수 있다. 접두사만 다룬다.
  assert.equal(defaultDeviceName('lab-hrjang-01', 'hrjang'), 'lab-hrjang-01')
})

test('한쪽이 비어도 쓸 수 있는 이름을 낸다', () => {
  assert.equal(defaultDeviceName('', 'hrjang'), 'hrjang')
  assert.equal(defaultDeviceName('box', ''), 'box')
  assert.equal(defaultDeviceName('', ''), 'PC')
})

test('이름을 바꾸는 길을 열어 두지 않는다', () => {
  // 이 이름은 클라우드 안 폴더가 되고, 폴더는 데이터의 주소다. 바꿀 수 있게
  // 하면 주소가 따라 움직이고 그 안의 파일은 예전 자리에 남는다.
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'device-name.ts'), 'utf-8')
  assert.ok(!/resolveDeviceName/.test(src), '사용자 지정 이름 경로가 되살아났다')
  const cfg = readFileSync(join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf-8')
  assert.ok(!/deviceName\?/.test(cfg), '설정에 PC 이름 칸이 되살아났다')
})
