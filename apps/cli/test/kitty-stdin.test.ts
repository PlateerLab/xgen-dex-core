/**
 * kitty 가 보낸 키를 ink 이 읽을 수 있게 고쳐 넘긴다.
 *
 * 두 번 크게 물렸던 자리라 여기서 못박는다.
 *
 * 하나. 프로토콜을 켜면 kitty 는 수식이 없는 키의 그 자리를 **비워서** 보낸다
 * (`ESC[97;;97u`). 시프트가 걸리면 대체 글쇠까지 붙인다(`ESC[97:65;2;65u`).
 * ink 의 파서는 이 두 모양을 알아보지 못하고 통째로 흘려보내, **글자가 하나도
 * 입력되지 않았다.**
 *
 * 둘. ink 은 `data` 이벤트가 아니라 **`readable` + `read()`** 로 읽는다. 곁에서
 * `data` 리스너를 붙이면 스트림이 흐름 모드로 바뀌어 ink 의 `read()` 가 굶는다 —
 * 역시 글자가 하나도 들어오지 않는다.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createNormalizer, normalizeKeyEvents, normalizedStdin } from '../src/tui/kitty';

const CSI = '\u001B[';

test('빈 수식 자리를 채운다 — 실제 kitty 가 이렇게 보낸다', () => {
  assert.equal(normalizeKeyEvents(`${CSI}97;;97u`), `${CSI}97;1;97u`);
  assert.equal(normalizeKeyEvents(`${CSI}32;;32u`), `${CSI}32;1;32u`);
  assert.equal(normalizeKeyEvents(`${CSI}13;;13u`), `${CSI}13;1;13u`);
});

test('대체 글쇠를 떼어 낸다 — 글자 필드가 진짜 글자를 들고 있다', () => {
  assert.equal(normalizeKeyEvents(`${CSI}97:65;2;65u`), `${CSI}97;2;65u`);
  // 시프트 기호. 대체 글쇠를 떼어도 글자 필드 덕분에 `!` 가 살아난다.
  assert.equal(normalizeKeyEvents(`${CSI}49:33;2;33u`), `${CSI}49;2;33u`);
});

test('이미 읽을 수 있는 모양은 건드리지 않는다', () => {
  // 멀쩡한 것을 고치면 그 자체가 새 위험이다.
  for (const sequence of [
    `${CSI}97u`,
    `${CSI}97;2u`,
    `${CSI}57449u`,
    `${CSI}32;5u`,
    `${CSI}97;2;65u`,
    `${CSI}57449;1:3u`,
  ]) {
    assert.equal(normalizeKeyEvents(sequence), sequence, sequence);
  }
});

test('대체 글쇠만 있고 글자가 없어도 떼어 낸다', () => {
  assert.equal(normalizeKeyEvents(`${CSI}97:65u`), `${CSI}97u`);
  assert.equal(normalizeKeyEvents(`${CSI}97:65;2u`), `${CSI}97;2u`);
});

test('키 사건이 아닌 것은 그대로 둔다', () => {
  assert.equal(normalizeKeyEvents('안녕하세요'), '안녕하세요');
  assert.equal(normalizeKeyEvents(`${CSI}1;2R`), `${CSI}1;2R`, '커서 위치 보고');
  assert.equal(normalizeKeyEvents(`${CSI}200~`), `${CSI}200~`, '붙여넣기 마커');
});

test('덩어리 경계에서 잘려도 이어 붙인다', () => {
  // 터미널 입력은 아무 데서나 쪼개져 도착한다. 잘린 채로 고치면 반쪽이 글자로 샌다.
  const normalize = createNormalizer();
  assert.equal(normalize(`${CSI}97`), '', '아직 끝나지 않았으니 붙들어 둔다');
  assert.equal(normalize(';;97u'), `${CSI}97;1;97u`);
});

test('시퀀스가 아닌 꼬리는 붙들지 않는다', () => {
  const normalize = createNormalizer();
  assert.equal(normalize('안녕'), '안녕');
  assert.equal(normalize(`hi${CSI}97;;97u`), `hi${CSI}97;1;97u`);
});

function fakeStdin(chunks: string[]): NodeJS.ReadStream & { dataListeners: number } {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream & { dataListeners: number };
  const queue = [...chunks];
  Object.defineProperty(stream, 'dataListeners', {
    get: () => stream.listenerCount('data'),
  });
  (stream as unknown as { read: () => string | null }).read = () => queue.shift() ?? null;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  (stream as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = () => undefined;
  return stream;
}

test('read() 가 고쳐진 글자를 돌려준다', () => {
  // ink 이 실제로 읽는 길이다. 여기서 고쳐지지 않으면 아무것도 입력되지 않는다.
  const stdin = fakeStdin([`${CSI}97;;97u`, `${CSI}49:33;2;33u`]);
  const wrapped = normalizedStdin(stdin);
  assert.equal(wrapped.read(), `${CSI}97;1;97u`);
  assert.equal(wrapped.read(), `${CSI}49;2;33u`);
  assert.equal(wrapped.read(), null);
});

test('data 리스너를 붙이지 않는다', () => {
  // 붙이면 스트림이 흐름 모드로 바뀌어 ink 의 read() 가 굶는다.
  const stdin = fakeStdin([`${CSI}97;;97u`]);
  const wrapped = normalizedStdin(stdin, () => undefined);
  wrapped.read();
  assert.equal(stdin.dataListeners, 0);
});

test('지나가는 김에 한/영 키를 알려 준다', () => {
  const seen: string[] = [];
  const stdin = fakeStdin([`${CSI}57449u`, `${CSI}57358u`, `${CSI}97;;97u`]);
  const wrapped = normalizedStdin(stdin, (name) => void seen.push(name));
  while (wrapped.read() !== null) {
    /* 다 읽는다 */
  }
  assert.deepEqual(seen, ['rightalt', 'capslock']);
});

test('키를 뗄 때는 알리지 않는다', () => {
  // 뗄 때까지 받으면 한 번 눌러 두 번 바뀐다.
  const seen: string[] = [];
  const stdin = fakeStdin([`${CSI}57449;1:3u`]);
  const wrapped = normalizedStdin(stdin, (name) => void seen.push(name));
  wrapped.read();
  assert.deepEqual(seen, []);
});

test('나머지는 그대로 흘려보낸다', () => {
  // ink 은 isTTY 를 보고 setRawMode 를 부른다. 감싸면서 잃으면 안 된다.
  const stdin = fakeStdin([]);
  const wrapped = normalizedStdin(stdin);
  assert.equal(wrapped.isTTY, true);
  assert.equal(typeof wrapped.setRawMode, 'function');
  assert.doesNotThrow(() => wrapped.setRawMode(true));
});
