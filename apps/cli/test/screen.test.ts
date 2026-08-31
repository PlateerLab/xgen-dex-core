/**
 * Ctrl+Q 로 나간 뒤 터미널이 깨끗한가.
 *
 * 이건 눈으로만 확인되던 것이다 — 틀리면 사용자 스크롤백에 UI 잔해가 남거나,
 * 더 나쁘게는 원래 화면까지 지워진 뒤에야 안다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScreenGuard,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  SHOW_CURSOR,
} from '../src/tui/screen';

function fakeTty(isTTY = true): { isTTY: boolean; write(c: string): void; out: string[] } {
  const out: string[] = [];
  return { isTTY, out, write: (c: string) => void out.push(c) };
}

const written = (tty: { out: string[] }): string => tty.out.join('');
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test('들어갔다 나오면 원래 화면으로 돌아가고 커서가 살아난다', () => {
  const tty = fakeTty();
  const guard = createScreenGuard(tty);
  guard.enter();
  guard.restore();
  const out = written(tty);
  assert.ok(out.startsWith(ENTER_ALT_SCREEN), '대체 화면부터 들어간다');
  assert.ok(out.endsWith(SHOW_CURSOR), '마지막은 커서 복원이다');
  assert.ok(out.indexOf(LEAVE_ALT_SCREEN) > out.indexOf(ENTER_ALT_SCREEN));
});

test('여러 번 되돌려도 대체 화면은 한 번만 벗긴다', () => {
  // Ctrl+C 와 정상 종료가 겹치면 restore 가 두 번 불린다. 두 번 벗기면 사용자가
  // TUI 를 띄우기 전에 보던 화면까지 지워진다.
  const tty = fakeTty();
  const guard = createScreenGuard(tty);
  guard.enter();
  guard.restore();
  guard.restore();
  guard.restore();
  assert.equal(count(written(tty), LEAVE_ALT_SCREEN), 1);
});

test('두 번 들어가도 한 번만 들어간다', () => {
  const tty = fakeTty();
  const guard = createScreenGuard(tty);
  guard.enter();
  guard.enter();
  assert.equal(count(written(tty), ENTER_ALT_SCREEN), 1);
});

test('들어갈 때 포커스·마우스 보고를 끄고 붙여넣기 감싸기를 켠다', () => {
  // 이 보고들은 키가 아닌데 키처럼 도착해 메시지 칸에 타이핑된다. 앞서 실행된
  // 프로그램이 켜 두고 끄지 않았을 수 있어 우리가 직접 꺼야 한다.
  const tty = fakeTty();
  createScreenGuard(tty).enter();
  const out = written(tty);
  for (const mode of ['?1004l', '?1000l', '?1002l', '?1003l', '?1006l']) {
    assert.ok(out.includes(`\u001B[${mode}`), `${mode} 를 꺼야 한다`);
  }
  assert.ok(out.includes('\u001B[?2004h'), '붙여넣기 감싸기를 켠다');
});

test('나올 때 붙여넣기 감싸기를 되돌린다', () => {
  // 우리가 켠 것이므로 우리가 끈다. 남겨 두면 다음 프로그램이 마커를 뒤집어쓴다.
  const tty = fakeTty();
  const guard = createScreenGuard(tty);
  guard.enter();
  const before = written(tty).length;
  guard.restore();
  const tail = written(tty).slice(before);
  assert.ok(tail.includes('\u001B[?2004l'));
  assert.ok(tail.indexOf('\u001B[?2004l') < tail.indexOf(LEAVE_ALT_SCREEN), '화면을 되돌리기 전에 끈다');
});

test('TTY 가 아니면 제어 문자를 쓰지 않는다', () => {
  // 파이프나 CI 로그에 이스케이프가 섞이면 출력이 그대로 오염된다.
  const pipe = fakeTty(false);
  const guard = createScreenGuard(pipe);
  guard.enter();
  guard.restore();
  assert.deepEqual(pipe.out, [SHOW_CURSOR], '커서 복원만 남는다');
});

test('들어가지 않았으면 나오지도 않는다', () => {
  // enter 전에 예외가 나면 restore 만 불린다. 들어간 적 없는 대체 화면을 벗기면
  // 사용자의 현재 화면이 지워진다.
  const tty = fakeTty();
  createScreenGuard(tty).restore();
  assert.ok(!tty.out.includes(LEAVE_ALT_SCREEN));
});
