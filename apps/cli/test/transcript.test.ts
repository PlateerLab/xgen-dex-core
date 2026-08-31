/**
 * 대화창이 제 높이 안에 머무는가, 그리고 누가 말했는지 보이는가.
 *
 * 예전에는 마지막 몇 **개의 메시지**를 잘라 보여 줬다. 한 메시지가 한두 줄이라고
 * 친 셈인데 실제로는 수십 줄짜리가 온다. 대화창이 제 높이를 넘어 자라면 ink 이
 * 지우는 자리와 그리는 자리가 어긋나 글자가 테두리 밖으로 새고 입력창까지 밟힌다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type { ChatMessage } from '../src/tui/chat-state';
import {
  maximumScroll,
  renderTranscript,
  viewportOf,
  wrapToWidth,
} from '../src/tui/transcript';

function message(role: ChatMessage['role'], text: string, id = `${role}-${text.slice(0, 6)}`): ChatMessage {
  return { id, role, text } as ChatMessage;
}

test('줄은 폭을 넘지 않는다 — 한글도, 이모지도', () => {
  const cases = [
    'hello world this is a fairly long english sentence that must be wrapped',
    '한글은공백이없어도폭에맞춰끊어야한다그렇지않으면대화창이자란다한번더',
    '섞인 text 와 한글 and emoji 😀😀😀 이 함께 있는 줄도 마찬가지다',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ];
  for (const width of [10, 20, 37, 80]) {
    for (const text of cases) {
      for (const line of wrapToWidth(text, width)) {
        assert.ok(
          stringWidth(line) <= width,
          `폭 ${width} 를 넘었다: ${JSON.stringify(line)} (${stringWidth(line)}칸)`,
        );
      }
    }
  }
});

test('줄바꿈을 넣어도 글자는 하나도 잃지 않는다', () => {
  const text = '첫 줄입니다 그리고 조금 더 긴 내용이 이어집니다';
  const joined = wrapToWidth(text, 12).join('').replace(/\s+/g, '');
  assert.equal(joined, text.replace(/\s+/g, ''));
});

test('빈 줄은 빈 줄로 남는다', () => {
  assert.deepEqual(wrapToWidth('가\n\n나', 10), ['가', '', '나']);
});

test('누가 말했는지 가로줄로 못박는다', () => {
  const lines = renderTranscript(
    [message('user', '안녕하세요'), message('assistant', '네, 무엇을 도와드릴까요?')],
    'Sales Agent',
    40,
  );
  const labels = lines.filter((line) => line.role === 'label');
  assert.equal(labels.length, 2);
  assert.match(labels[0]!.text, /^── You ─+$/);
  assert.match(labels[1]!.text, /^── Sales Agent ─+$/);
  assert.equal(labels[0]!.color, 'cyan');
  assert.equal(labels[1]!.color, 'green');
});

test('가로줄도 폭을 넘지 않는다 — 이름이 아무리 길어도', () => {
  const lines = renderTranscript(
    [message('assistant', '네')],
    '아주 길고 긴 이름을 가진 에이전트입니다 정말로 깁니다',
    30,
  );
  for (const line of lines) {
    assert.ok(stringWidth(line.text) <= 30, `${line.text} (${stringWidth(line.text)}칸)`);
  }
});

test('내용은 이름 아래로 들여쓴다', () => {
  const lines = renderTranscript([message('user', '안녕')], 'Agent', 40);
  const body = lines.find((line) => line.role === 'text' && line.text.trim() !== '');
  assert.equal(body?.text, '  안녕');
});

test('도구 활동은 가로줄 없이 곁다리로 남는다', () => {
  // 도구 호출마다 가로줄을 그으면 진짜 대화가 그 사이에 묻힌다.
  const lines = renderTranscript([message('activity', '파일을 읽는 중')], 'Agent', 40);
  assert.equal(lines.filter((line) => line.role === 'label').length, 0);
  assert.equal(lines[0]?.text, '· 파일을 읽는 중');
});

test('아직 오지 않은 응답은 기다리는 중이라고 말한다', () => {
  const lines = renderTranscript([message('assistant', '')], 'Agent', 40);
  assert.ok(lines.some((line) => line.text.trim() === '…'));
});

test('아무리 긴 대화도 창 높이를 넘지 않는다', () => {
  // 이것이 깨지면 입력창과 안내줄이 밟힌다.
  const messages = Array.from({ length: 200 }, (_, i) =>
    message(i % 2 === 0 ? 'user' : 'assistant', '긴 답변입니다 '.repeat(40), `m${i}`),
  );
  const lines = renderTranscript(messages, 'Agent', 60);
  for (const height of [1, 5, 20, 100]) {
    for (const scroll of [0, 7, 500, 100_000]) {
      const view = viewportOf(lines, height, scroll);
      assert.ok(view.lines.length <= height, `높이 ${height} 인데 ${view.lines.length}줄`);
    }
  }
});

test('맨 아래에 붙어 있으면 늘 최신이 보인다', () => {
  const lines = renderTranscript(
    Array.from({ length: 30 }, (_, i) => message('user', `줄 ${i}`, `m${i}`)),
    'Agent',
    40,
  );
  const view = viewportOf(lines, 5, 0);
  assert.equal(view.below, 0, '아래로 가려진 것이 없어야 한다');
  assert.deepEqual(view.lines, lines.slice(-5));
});

test('올려 두면 그 자리를 지키고, 위아래로 얼마가 남았는지 알려 준다', () => {
  const lines = renderTranscript(
    Array.from({ length: 30 }, (_, i) => message('user', `줄 ${i}`, `m${i}`)),
    'Agent',
    40,
  );
  const view = viewportOf(lines, 5, 7);
  assert.equal(view.below, 7);
  assert.equal(view.above, lines.length - 12);
  assert.deepEqual(view.lines, lines.slice(-12, -7));
});

test('끝을 넘겨 올리려 해도 맨 위에서 멈춘다', () => {
  const lines = renderTranscript([message('user', '한 줄')], 'Agent', 40);
  const view = viewportOf(lines, 3, 9999);
  assert.equal(view.above, 0, '더 올라갈 곳이 없다');
  assert.deepEqual(view.lines, lines.slice(0, 3));
});

test('내용이 창보다 짧으면 스크롤할 것이 없다', () => {
  assert.equal(maximumScroll(3, 10), 0);
  assert.equal(maximumScroll(30, 10), 20);
  assert.equal(maximumScroll(0, 0), 0);
});

test('창이 한 줄도 없으면 아무것도 그리지 않는다', () => {
  // 터미널을 극단적으로 줄이면 실제로 이런 값이 나온다.
  const lines = renderTranscript([message('user', '안녕')], 'Agent', 40);
  assert.deepEqual(viewportOf(lines, 0, 0).lines, []);
});
