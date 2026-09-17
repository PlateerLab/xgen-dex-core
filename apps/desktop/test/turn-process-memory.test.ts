/**
 * 끝난 턴의 작업 과정을 PC 에 남겼다가 이력으로 다시 연 답에 되붙이기.
 * 짝은 대화 id + 답 글(공백 무시)로만 짓는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMsg } from '../src/renderer/src/session-store';
import {
  answerSignature,
  attachTurnProcesses,
  rememberTurnProcess,
  TURN_PROCESS_CLIP,
  TURN_PROCESS_KEY,
  TURN_PROCESS_MAX,
  type KeyValueStorage,
} from '../src/renderer/src/turn-process-memory';

const memoryStorage = (limit = Infinity): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > limit) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
  };
};

const streamed = (text: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({
  role: 'assistant',
  text,
  flow: [
    { kind: 'text', text: '읽는 중입니다.\n', at: 1000 },
    { kind: 'tool', event: { eventType: 'tool_result', toolName: 'Read', toolInput: { path: 'a.txt' }, result: 'ok' }, at: 1500 },
    { kind: 'text', text: text.slice('읽는 중입니다.\n'.length), at: 2000 },
  ],
  tools: [{ eventType: 'tool_result', toolName: 'Read', result: 'ok' }],
  startedAt: 900,
  lastEventAt: 2000,
  ...extra,
});

test('남긴 과정은 공백만 다른 이력 답에 되붙는다', () => {
  const storage = memoryStorage();
  const live = streamed('읽는 중입니다.\n결과는 3건입니다.');
  rememberTurnProcess(storage, 'conv-1', live, 5000);
  const history: ChatMsg[] = [
    { role: 'user', text: '읽어 주세요' },
    { role: 'assistant', text: '읽는 중입니다.\n\n결과는  3건입니다.\n' },
  ];
  const [, restored] = attachTurnProcesses(storage, 'conv-1', history);
  assert.equal(restored.flow?.length, 3);
  assert.equal(restored.tools?.length, 1);
  assert.equal(restored.startedAt, 900);
  assert.equal(restored.lastEventAt, 2000);
  assert.equal(restored.text, history[1].text, '답 글은 이력 그대로 둔다');
});

test('다른 대화·다른 답에는 붙이지 않는다', () => {
  const storage = memoryStorage();
  rememberTurnProcess(storage, 'conv-1', streamed('읽는 중입니다.\n결과는 3건입니다.'), 5000);
  const other = attachTurnProcesses(storage, 'conv-2', [{ role: 'assistant', text: '읽는 중입니다.\n결과는 3건입니다.' }]);
  assert.equal(other[0].flow, undefined);
  const changed = attachTurnProcesses(storage, 'conv-1', [{ role: 'assistant', text: '읽는 중입니다.\n결과는 4건입니다.' }]);
  assert.equal(changed[0].flow, undefined);
});

test('도구를 안 쓴 턴·빈 답·저장소 없음은 남기지 않는다', () => {
  const storage = memoryStorage();
  rememberTurnProcess(storage, 'conv-1', { role: 'assistant', text: '안녕하세요', flow: [{ kind: 'text', text: '안녕하세요', at: 1 }] }, 1);
  rememberTurnProcess(storage, 'conv-1', streamed('읽는 중입니다.\n', { text: '   ' }), 1);
  rememberTurnProcess(null, 'conv-1', streamed('읽는 중입니다.\n끝'), 1);
  assert.equal(storage.data.has(TURN_PROCESS_KEY), false);
  const msgs: ChatMsg[] = [{ role: 'assistant', text: '끝' }];
  assert.equal(attachTurnProcesses(null, 'conv-1', msgs), msgs);
});

test('같은 답을 다시 남기면 하나로, 최대 개수를 넘으면 오래된 것부터 버린다', () => {
  const storage = memoryStorage();
  rememberTurnProcess(storage, 'conv-1', streamed('읽는 중입니다.\n같은 답'), 1);
  rememberTurnProcess(storage, 'conv-1', streamed('읽는 중입니다.\n같은 답'), 2);
  assert.equal(JSON.parse(storage.data.get(TURN_PROCESS_KEY)!).length, 1);
  for (let i = 0; i < TURN_PROCESS_MAX + 5; i += 1) rememberTurnProcess(storage, 'conv-1', streamed(`읽는 중입니다.\n답 ${i}`), 10 + i);
  const saved = JSON.parse(storage.data.get(TURN_PROCESS_KEY)!);
  assert.equal(saved.length, TURN_PROCESS_MAX);
  assert.equal(saved[saved.length - 1].sig, answerSignature(`읽는 중입니다.\n답 ${TURN_PROCESS_MAX + 4}`));
});

test('저장 용량이 모자라면 오래된 것을 버리고 최근 턴은 남긴다', () => {
  const one = JSON.stringify([{ probe: true }]).length;
  const probe = memoryStorage();
  rememberTurnProcess(probe, 'conv-1', streamed('읽는 중입니다.\n답 0'), 1);
  const entrySize = probe.data.get(TURN_PROCESS_KEY)!.length - one;
  const storage = memoryStorage(entrySize * 3);
  for (let i = 0; i < 6; i += 1) rememberTurnProcess(storage, 'conv-1', streamed(`읽는 중입니다.\n답 ${i}`), i);
  const saved = JSON.parse(storage.data.get(TURN_PROCESS_KEY)!);
  assert.ok(saved.length >= 1 && saved.length <= 3);
  assert.equal(saved[saved.length - 1].sig, answerSignature('읽는 중입니다.\n답 5'));
});

test('긴 도구 입력·결과 문자열은 잘라서 남긴다', () => {
  const storage = memoryStorage();
  const long = 'x'.repeat(TURN_PROCESS_CLIP + 500);
  const msg = streamed('읽는 중입니다.\n끝');
  msg.flow = [{ kind: 'tool', event: { eventType: 'tool_call', toolName: 'Write', toolInput: { content: long } }, at: 1 }, ...msg.flow!];
  rememberTurnProcess(storage, 'conv-1', msg, 1);
  const [restored] = attachTurnProcesses(storage, 'conv-1', [{ role: 'assistant', text: msg.text }]);
  const first = restored.flow![0];
  assert.equal(first.kind, 'tool');
  const content = (first.kind === 'tool' ? (first.event.toolInput as { content: string }).content : '');
  assert.equal(content.length, TURN_PROCESS_CLIP + 1);
});

test('이미 과정이 있는 답은 덮지 않는다', () => {
  const storage = memoryStorage();
  rememberTurnProcess(storage, 'conv-1', streamed('읽는 중입니다.\n끝'), 1);
  const own = streamed('읽는 중입니다.\n끝', { startedAt: 42 });
  assert.equal(attachTurnProcesses(storage, 'conv-1', [own])[0].startedAt, 42);
});
