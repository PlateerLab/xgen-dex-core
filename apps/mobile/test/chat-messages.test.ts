/**
 * 대화 한 줄을 고치는 규칙 — 눈으로는 못 지키는 것들.
 *
 * 여기서 막는 사고: 같은 답이 두 번 서는 것, 도구 건수가 호출 수가 아니라
 * 이벤트 수로 세어지는 것, 실패가 도구 기록을 지워 버리는 것.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAssistantText,
  assistantPlaceholder,
  attachTool,
  dropRemotePartials,
  finishStreaming,
  historyMessages,
  setError,
  setRemotePartial,
  userMessage,
  type ChatMessage,
} from '../src/chat/message-model';

const start = (): ChatMessage[] => [userMessage('안녕'), assistantPlaceholder()];

test('스트림 조각은 도는 답변 하나에 이어 붙는다', () => {
  let msgs = start();
  msgs = appendAssistantText(msgs, '안');
  msgs = appendAssistantText(msgs, '녕하세요');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].text, '안녕하세요');
});

test('받을 자리가 없으면 새 답변을 세운다', () => {
  const msgs = appendAssistantText([userMessage('q')], '답');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].streaming, true);
});

test('같은 호출의 시작과 끝은 한 줄로 합쳐진다', () => {
  let msgs = start();
  msgs = attachTool(msgs, { eventType: 'tool_call', toolName: 'Read', toolUseId: 'u1' });
  msgs = attachTool(msgs, { eventType: 'tool_result', toolName: 'Read', toolUseId: 'u1', result: 'ok' });
  const tools = msgs[1].tools ?? [];
  assert.equal(tools.length, 1, '한 호출은 한 건이다');
  assert.equal(tools[0].eventType, 'tool_result');
  assert.equal(tools[0].result, 'ok');
});

test('호출 id 가 없으면 이름으로 짝을 맞추되 끝난 호출은 건드리지 않는다', () => {
  let msgs = start();
  msgs = attachTool(msgs, { eventType: 'tool_start', toolName: 'Bash' });
  msgs = attachTool(msgs, { eventType: 'tool_result', toolName: 'Bash' });
  msgs = attachTool(msgs, { eventType: 'tool_start', toolName: 'Bash' });
  const tools = msgs[1].tools ?? [];
  assert.equal(tools.length, 2, '끝난 호출 뒤의 같은 이름은 새 호출이다');
});

test('도구가 실어 온 출처는 그 답변에 쌓이고 중복되지 않는다', () => {
  let msgs = start();
  const cite = { fileName: '계약서.pdf', pageNumber: 3 };
  msgs = attachTool(msgs, { eventType: 'tool_result', toolName: 'rag', toolUseId: 'a', citations: [cite] });
  msgs = attachTool(msgs, { eventType: 'tool_result', toolName: 'rag', toolUseId: 'b', citations: [cite] });
  assert.equal(msgs[1].citations?.length, 1);
});

test('다른 곳의 진행분은 이어붙이지 않고 덮어쓴다', () => {
  let msgs: ChatMessage[] = [userMessage('웹에서 물어본 것')];
  msgs = setRemotePartial(msgs, '답변 절반');
  msgs = setRemotePartial(msgs, '답변 절반 하고 조금 더');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].text, '답변 절반 하고 조금 더');
  assert.equal(dropRemotePartials(msgs).length, 1);
});

test('정지로 끝난 턴은 그 사실을 남긴다', () => {
  let msgs = appendAssistantText(start(), '받다 만 글');
  msgs = finishStreaming(msgs, { interrupted: true });
  assert.equal(msgs[1].streaming, false);
  assert.equal(msgs[1].interrupted, true);
});

test('실패해도 그 답변의 도구 기록은 남는다', () => {
  let msgs = start();
  msgs = attachTool(msgs, { eventType: 'tool_start', toolName: 'Bash', toolUseId: 'u1' });
  msgs = setError(msgs, { title: '실패', hint: '다시', code: 'E1', detail: 'raw', retryable: true });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].errorInfo?.code, 'E1');
  assert.equal(msgs[1].tools?.length, 1, '무엇을 하다 실패했는지가 여기 있다');
  assert.equal(msgs[1].streaming, false);
});

test('이미 글이 온 답변 뒤의 실패는 새 줄로 선다', () => {
  let msgs = appendAssistantText(start(), '여기까지는 왔다');
  msgs = setError(msgs, { title: '끊김', hint: '', code: 'E2', retryable: true });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].text, '여기까지는 왔다');
  assert.equal(msgs[2].errorInfo?.code, 'E2');
});

test('지난 대화는 빈 쪽을 만들지 않는다', () => {
  const msgs = historyMessages([
    { input: '질문', output: '답' },
    { input: '', output: '트리거 반응' },
    { input: '첨부와 함께', output: '', attachments: [{}, {}] },
  ]);
  assert.deepEqual(
    msgs.map((m) => `${m.role}:${m.text}`),
    ['user:질문', 'assistant:답', 'assistant:트리거 반응', 'user:첨부와 함께'],
  );
  assert.equal(msgs[3].attachmentCount, 2);
});
