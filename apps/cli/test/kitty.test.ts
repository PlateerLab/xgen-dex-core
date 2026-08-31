/**
 * 한/영 키와 Caps Lock 을 키로 알아본다.
 *
 * 보통 터미널은 글자만 보낸다 — 한/영 키(오른쪽 Alt 자리)나 Caps Lock 처럼 글자를
 * 만들지 않는 키는 어떤 터미널 프로그램에도 도착하지 않는다. Kitty 키보드
 * 프로토콜을 아는 터미널만 그 키들을 사건으로 보고한다.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { QUERY, parseKeyEvents, supportsKittyKeyboard } from '../src/tui/kitty';

const CSI = '\u001B[';

test('한/영 자리와 Caps Lock 을 알아본다', () => {
  assert.deepEqual(parseKeyEvents(`${CSI}57449u`), [
    { name: 'rightalt', capsLock: false, eventType: 1 },
  ]);
  assert.deepEqual(parseKeyEvents(`${CSI}57358u`), [
    { name: 'capslock', capsLock: false, eventType: 1 },
  ]);
});

test('누름과 뗌을 가른다', () => {
  // 뗄 때까지 받으면 한 번 눌러 두 번 바뀐다.
  assert.equal(parseKeyEvents(`${CSI}57449;1:1u`)[0]?.eventType, 1);
  assert.equal(parseKeyEvents(`${CSI}57449;1:3u`)[0]?.eventType, 3);
});

test('수식 값에서 Caps Lock 상태를 읽는다', () => {
  // 프로토콜은 수식을 "실제 값 + 1" 로 싣는다. Caps Lock 은 64 이므로 65 다.
  assert.equal(parseKeyEvents(`${CSI}97;65u`)[0]?.capsLock, true);
  assert.equal(parseKeyEvents(`${CSI}97;1u`)[0]?.capsLock, false);
  assert.equal(parseKeyEvents(`${CSI}97u`)[0]?.capsLock, false, '수식이 없으면 없는 것이다');
});

test('한 덩어리에 여러 사건이 와도 모두 읽는다', () => {
  const events = parseKeyEvents(`${CSI}57449u${CSI}97u${CSI}57358u`);
  assert.deepEqual(
    events.map((event) => event.name),
    ['rightalt', undefined, 'capslock'],
  );
});

test('제어 시퀀스가 아닌 것에는 반응하지 않는다', () => {
  assert.deepEqual(parseKeyEvents('안녕하세요'), []);
  assert.deepEqual(parseKeyEvents(`${CSI}1;2R`), [], '커서 위치 보고는 키가 아니다');
});

function fakeTerminal(answer?: string): {
  stdin: EventEmitter & { isRaw?: boolean; setRawMode?(mode: boolean): void };
  stdout: { isTTY: boolean; write(chunk: string): void };
  written: string[];
  rawModes: boolean[];
} {
  const written: string[] = [];
  const rawModes: boolean[] = [];
  const stdin = new EventEmitter() as EventEmitter & {
    isRaw?: boolean;
    setRawMode?(mode: boolean): void;
  };
  stdin.isRaw = false;
  stdin.setRawMode = (mode: boolean): void => void rawModes.push(mode);
  const stdout = {
    isTTY: true,
    write(chunk: string): void {
      written.push(chunk);
      // 아는 터미널은 곧바로 답한다.
      if (chunk === QUERY && answer !== undefined) setImmediate(() => stdin.emit('data', answer));
    },
  };
  return { stdin, stdout, written, rawModes };
}

test('아는 터미널은 답한다', async () => {
  const terminal = fakeTerminal(`${CSI}?1u`);
  assert.equal(await supportsKittyKeyboard({ ...terminal, isTTY: true }), true);
  assert.deepEqual(terminal.written, [QUERY]);
});

test('모르는 터미널은 기다리다 넘어간다', async () => {
  // 답이 없다고 켜 버리면 모르는 터미널이 우리 질문을 글자로 뱉어 화면에 찍힌다.
  const terminal = fakeTerminal();
  assert.equal(await supportsKittyKeyboard({ ...terminal, isTTY: true }, 30), false);
});

test('물어보는 동안만 원시 모드로 바꾸고 되돌린다', async () => {
  // 답은 줄바꿈 없이 오므로 행 단위 모드에서는 커널이 붙들고 있다 — 그러면 지원하는
  // 터미널도 대답하지 않는 것처럼 보인다.
  const terminal = fakeTerminal(`${CSI}?1u`);
  await supportsKittyKeyboard({ ...terminal, isTTY: true });
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('TTY 가 아니면 묻지 않는다', async () => {
  const terminal = fakeTerminal(`${CSI}?1u`);
  assert.equal(await supportsKittyKeyboard({ ...terminal, isTTY: false }), false);
  assert.deepEqual(terminal.written, [], '파이프에 제어 문자를 뿌릴 이유가 없다');
});

test('끌 수 있다', async () => {
  const terminal = fakeTerminal(`${CSI}?1u`);
  process.env.DEX_NO_KITTY = '1';
  try {
    assert.equal(await supportsKittyKeyboard({ ...terminal, isTTY: true }), false);
  } finally {
    delete process.env.DEX_NO_KITTY;
  }
});
