/**
 * DeX 자체 명령(fast-act-dex) — 화면 후보 번호, 말에 명령 낱말이 있어야 실행, 말이 끝난 뒤에만, 확신 기준.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEX_COMMANDS, configureDexCommands, dexCommandRefs, runDexCommand } from '../src/main/fast-act-dex';
import type { VoiceAction } from '../src/main/fast-act-voice';
import { FINAL, PARTIAL } from '../src/main/voice-segmenter';

const newChat = DEX_COMMANDS.find((c) => c.id === 'new-chat')!;

function run(said: string, confidence = 1, th = FINAL, guardOk = true) {
  const sent: string[] = [];
  const pushed: VoiceAction[] = [];
  configureDexCommands((id) => {
    sent.push(id);
    return true;
  });
  return runDexCommand(newChat, {
    said,
    th,
    guard: async () => guardOk,
    abort: () => false,
    pick: { ref: 'e9002', confidence },
    t0: performance.now(),
    sessionT0: performance.now(),
    push: (a) => pushed.push(a),
  }).then((outcome) => ({ outcome, sent, pushed }));
}

test('DeX 명령 후보는 받은 번호부터 차례로 붙는다', () => {
  const { refs, commands } = dexCommandRefs(9002);
  assert.deepEqual(Object.keys(refs), ['e9002']);
  assert.equal(refs.e9002.name, newChat.name);
  assert.equal(commands.e9002.id, 'new-chat');
});

test('"새 에이전트 만들어 줘" — 시작 화면을 열고 답 문장을 남긴다', async () => {
  const { outcome, sent, pushed } = await run('새 에이전트 만들어 줘.');
  assert.equal(outcome.acted, true);
  assert.deepEqual(sent, ['new-chat']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].sentence, newChat.sentence);
  assert.equal(pushed[0].app, undefined);
});

test('명령 낱말이 없는 말은 골라도 실행하지 않는다 — 판단 모델은 "해당 없음" 을 고르지 못한다', async () => {
  // 10/28 측정: 후보가 하나뿐이면 아래 말도 새 채팅을 0.99~1.00 으로 골랐다.
  for (const said of ['에이전트 이름 바꿔 줘', '에이전트 목록 보여 줘', '대화 기록 지워 줘']) {
    const { outcome, sent } = await run(said);
    assert.equal(outcome.acted, false, said);
    assert.equal(sent.length, 0, said);
  }
});

test('말하는 도중·확신 낮음·실행 조건 불충족이면 하지 않는다', async () => {
  assert.equal((await run('새 채팅 열어 줘', 1, PARTIAL)).outcome.acted, false);
  assert.equal((await run('새 채팅 열어 줘', 0.85)).outcome.acted, false);
  assert.equal((await run('새 채팅 열어 줘', 1, FINAL, false)).outcome.acted, false);
});

test('창이 없으면 실행한 것으로 치지 않는다', async () => {
  configureDexCommands(() => false);
  const outcome = await runDexCommand(newChat, {
    said: '새 대화 시작해 줘',
    th: FINAL,
    guard: async () => true,
    abort: () => false,
    pick: { ref: 'e9002', confidence: 1 },
    t0: performance.now(),
    sessionT0: performance.now(),
    push: () => assert.fail('push'),
  });
  assert.equal(outcome.acted, false);
});
