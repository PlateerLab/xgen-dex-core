/**
 * CLI 안에서 한글을 조합한다.
 *
 * 예전에는 터미널의 IME 에 맡겼다. 잘 되는 조합도 있지만 터미널마다 다르고, SSH 나
 * tmux 를 거치면 아예 안 온다 — 우리 쪽에서 고칠 수 없는 자리였다. 이제 `r k s`
 * 세 번의 키를 `ㄱ → 가 → 간` 으로 우리가 만든다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY, back, compose, display, feed, flush, jamoOf } from '../src/tui/hangul';

test('키 하나가 낱자 하나로', () => {
  assert.equal(jamoOf('r'), 'ㄱ');
  assert.equal(jamoOf('k'), 'ㅏ');
  assert.equal(jamoOf('R'), 'ㄲ', '시프트는 된소리');
  assert.equal(jamoOf('A'), 'ㅁ', '된소리가 없는 대문자는 소문자와 같다');
  assert.equal(jamoOf('1'), undefined);
  assert.equal(jamoOf(' '), undefined);
  assert.equal(jamoOf('한'), undefined);
});

test('초성 → 중성 → 종성으로 자라난다', () => {
  let state = EMPTY;
  const seen: string[] = [];
  for (const jamo of ['ㄱ', 'ㅏ', 'ㄴ']) {
    state = feed(state, jamo).state;
    seen.push(display(state));
  }
  assert.deepEqual(seen, ['ㄱ', '가', '간'], '누를 때마다 보여야 무엇이 들어가는지 안다');
});

test('겹모음과 겹받침', () => {
  assert.equal(compose('ghk'), '화', 'ㅎ + ㅗㅏ');
  assert.equal(compose('rml'), '긔', 'ㄱ + ㅡㅣ');
  assert.equal(compose('ekfr'), '닭', '겹받침 ㄺ');
  assert.equal(compose('QkQt'), '빠ㅃㅅ', 'ㅃ 은 받침이 될 수 없어 낱자로 남는다');
});

test('받침 뒤에 모음이 오면 받침이 다음 글자로 넘어간다', () => {
  // 한글 입력에서 가장 자주 틀리는 자리다.
  assert.equal(compose('dhsp'), '오네', 'ㅇㅗㄴ 뒤에 ㅔ 가 오면 ㄴ 이 넘어간다');
  assert.equal(compose('dnfl'), '우리');
});

test('겹받침은 뒤쪽만 넘어간다', () => {
  // `앉` + `ㅏ` → `안` + `자`. 겹받침을 통째로 넘기면 `아` + `ㄵㅏ` 가 되어 깨진다.
  assert.equal(compose('dkswk'), '안자');
  assert.equal(compose('dkfrh'), '알고');
});

test('실제 문장을 친 그대로 만든다', () => {
  assert.equal(compose('gksrmf'), '한글');
  assert.equal(compose('dkssudgktpdy'), '안녕하세요');
  assert.equal(compose('rjsrkdgktpdy'), '건강하세요');
  assert.equal(compose('tkfkdgo'), '사랑해');
  assert.equal(compose('godqhr'), '행복');
  assert.equal(compose('tjdrhd'), '성공');
  assert.equal(compose('rlacl'), '김치');
  assert.equal(compose('vlfdygks'), '필요한');
});

test('한글이 아닌 키는 조합을 끝내고 그대로 들어간다', () => {
  assert.equal(compose('gks 1'), '한 1');
  assert.equal(compose('rk!'), '가!');
});

test('백스페이스는 글자를 되짚는다', () => {
  // 완성된 글자를 통째로 지우면 오타 하나에 다시 처음부터 쳐야 한다.
  let state = EMPTY;
  for (const jamo of ['ㅎ', 'ㅏ', 'ㄴ']) state = feed(state, jamo).state;
  assert.equal(display(state), '한');

  const steps: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const result = back(state);
    state = result.state;
    steps.push(result.handled ? display(state) : '(값에서 지움)');
  }
  assert.deepEqual(steps, ['하', 'ㅎ', '', '(값에서 지움)']);
});

test('겹받침·겹모음도 한 단계씩 되짚는다', () => {
  let state = EMPTY;
  for (const jamo of ['ㅇ', 'ㅏ', 'ㄴ', 'ㅈ']) state = feed(state, jamo).state;
  assert.equal(display(state), '앉');
  state = back(state).state;
  assert.equal(display(state), '안', '겹받침은 앞 자음만 남는다');

  let vowel = EMPTY;
  for (const jamo of ['ㄱ', 'ㅗ', 'ㅏ']) vowel = feed(vowel, jamo).state;
  assert.equal(display(vowel), '과');
  vowel = back(vowel).state;
  assert.equal(display(vowel), '고', '겹모음도 앞 모음만 남는다');
});

test('조합 중이 아니면 백스페이스를 넘긴다', () => {
  // 값에 이미 들어간 글자를 지우는 일은 조합기가 할 일이 아니다.
  assert.equal(back(EMPTY).handled, false);
});

test('조합을 끝내면 남은 글자가 확정된다', () => {
  let state = EMPTY;
  for (const jamo of ['ㅎ', 'ㅏ']) state = feed(state, jamo).state;
  const flushed = flush(state);
  assert.equal(flushed.commit, '하');
  assert.deepEqual(flushed.state, EMPTY);
  assert.equal(flush(EMPTY).commit, '', '조합 중이 아니면 확정할 것도 없다');
});

test('자음만 잇달아 치면 낱자로 남는다', () => {
  assert.equal(compose('rsel'), 'ㄱㄴ디', 'ㄱ · ㄴ 다음 ㄷ+ㅣ');
  assert.equal(compose('ss'), 'ㄴㄴ');
});

test('모음만 잇달아 치면 낱자로 남는다', () => {
  assert.equal(compose('kk'), 'ㅏㅏ', '합쳐지지 않는 짝은 따로 남는다');
  assert.equal(compose('hk'), 'ㅘ', 'ㅗ + ㅏ 는 겹모음이 된다');
});
