/**
 * 터미널이 보내는 것 중 무엇이 사람이 친 글자인가.
 *
 * 이 구분을 놓치면 창을 전환하거나 붙여넣기만 해도 메시지 칸에 `[I`·`[200~` 같은
 * 것이 타이핑된다. 한글은 IME 후보창이 뜨고 닫힐 때마다 포커스가 오가므로 특히
 * 자주 터진다 — 사용자에게는 "한글이 입력되지 않는다" 로 보인다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyInput } from '../src/tui/terminal-input';

test('사람이 친 글자는 그대로 통과한다', () => {
  assert.deepEqual(classifyInput('a'), { kind: 'text', text: 'a' });
  assert.deepEqual(classifyInput('한'), { kind: 'text', text: '한' });
  assert.deepEqual(classifyInput('한글'), { kind: 'text', text: '한글' });
  assert.deepEqual(classifyInput('\u{1F600}'), { kind: 'text', text: '\u{1F600}' });
});

test('터미널이 보내는 보고는 글자가 아니다', () => {
  // ink 이 앞의 ESC 를 떼고 넘겨 주므로 우리에게는 이 꼴로 도착한다.
  for (const report of [
    '[I', // 창에 포커스가 들어옴
    '[O', // 창에서 포커스가 나감
    '[1;2R', // 커서 위치 보고
    '[?1;2c', // 장치 속성 응답
    '[<0;1;1M', // 마우스
    '[<0;1;1m',
    '[3~',
    'OP', // SS3 (F1)
  ]) {
    assert.deepEqual(classifyInput(report), { kind: 'ignore' }, `${report} 는 무시해야 한다`);
  }
});

test('붙여넣기 마커를 알아본다', () => {
  assert.deepEqual(classifyInput('[200~'), { kind: 'paste-start' });
  assert.deepEqual(classifyInput('[201~'), { kind: 'paste-end' });
});

test('붙여넣는 동안에는 제어 시퀀스처럼 생긴 내용도 글자다', () => {
  // 붙인 내용은 키가 아니다. 여기서 걸러 내면 사용자가 실제로 복사한 글이 사라진다.
  assert.deepEqual(classifyInput('[1;2R', true), { kind: 'text', text: '[1;2R' });
  assert.deepEqual(classifyInput('[I', true), { kind: 'text', text: '[I' });
});

test('사람이 친 대괄호 한 글자는 막지 않는다', () => {
  // 실제 키 입력은 한 번에 한 글자씩 온다 — 규칙에 걸릴 수 없다.
  assert.deepEqual(classifyInput('['), { kind: 'text', text: '[' });
  assert.deepEqual(classifyInput('O'), { kind: 'text', text: 'O' });
});

test('제어 시퀀스처럼 생기지 않은 여러 글자는 통과한다', () => {
  assert.deepEqual(classifyInput('[abc]'), { kind: 'text', text: '[abc]' });
  assert.deepEqual(classifyInput('Oh no'), { kind: 'text', text: 'Oh no' });
});

test('보이지 않는 제어문자는 값에 넣지 않는다', () => {
  // 넣으면 화면에는 안 보이는데 커서만 앞으로 가고, 그대로 서버에 실려 나간다.
  assert.deepEqual(classifyInput('\u0007'), { kind: 'ignore' }, 'BEL');
  assert.deepEqual(classifyInput('\u007F'), { kind: 'ignore' }, 'DEL');
  assert.deepEqual(classifyInput('a\u0000b'), { kind: 'text', text: 'ab' });
});

test('여러 줄 붙여넣기는 한 줄로 눕힌다', () => {
  // 한 줄 입력 칸이다. 줄바꿈을 남기면 렌더가 깨지고, 버리면 단어가 붙는다.
  assert.deepEqual(classifyInput('첫 줄\r\n둘째 줄', true), { kind: 'text', text: '첫 줄 둘째 줄' });
  assert.deepEqual(classifyInput('a\nb', true), { kind: 'text', text: 'a b' });
});
