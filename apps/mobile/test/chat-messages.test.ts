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
  ensureRemotePartial,
  mergeHistory,
  reconcileFlow,
  setError,
  setRemoteLive,
  userMessage,
  type ChatMessage,
  completeRemoteTurn,
  startRemoteTurn,
} from '../src/chat/message-model';

const live = (text: string, events: unknown[] = []) => ({ text, events });

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
  msgs = setRemoteLive(msgs, live('답변 절반'));
  msgs = setRemoteLive(msgs, live('답변 절반 하고 조금 더'));
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
    {
      input: '첨부와 함께',
      output: '',
      attachments: [
        { name: 'a.png', size: 1, contentType: 'image/png', type: 'picture', path: 'p', bucket: '' },
        { name: 'b.pdf', size: 1, contentType: 'application/pdf', type: 'file', path: 'q', bucket: '' },
      ],
    },
  ]);
  assert.deepEqual(
    msgs.map((m) => `${m.role}:${m.text}`),
    ['user:질문', 'assistant:답', 'assistant:트리거 반응', 'user:첨부와 함께'],
  );
  assert.deepEqual(msgs[3].attachments, [
    { name: 'a.png', kind: 'image' },
    { name: 'b.pdf', kind: 'file' },
  ]);
});

// ── 다른 곳의 턴은 한 번만 (2026-09-29 사용자 보고) ─────────────────────
// 서버는 완결 행을 turn_ended 보다 먼저 보낸다. 예전에는 행이 진행분만 걷고 질문과 답을
// 덧붙여 질문이 두 번 보였다.

const shape = (list: ChatMessage[]) => list.map((m) => `${m.role}:${m.text}`);

test('완결 행이 먼저 와도 질문은 한 번이고, 뒤의 종료는 아무것도 바꾸지 않는다', () => {
  let list = startRemoteTurn([], '안녕하세요');
  list = appendAssistantText(list, '안녕');
  list = completeRemoteTurn(list, { ioId: 5, input: '안녕하세요', output: '안녕하세요! 무엇을 도와드릴까요?' }) ?? list;
  assert.deepEqual(shape(list), ['user:안녕하세요', 'assistant:안녕하세요! 무엇을 도와드릴까요?']);
  assert.equal(completeRemoteTurn(list, { ioId: 5, input: '안녕하세요', output: '안녕하세요! 무엇을 도와드릴까요?' }), null);
  assert.ok(list.every((m) => !m.streaming && !m.remotePartial && !m.remoteQuestion));
});

test('종료가 먼저 와도 뒤에 온 행이 덧붙지 않는다', () => {
  let list = startRemoteTurn([], '질문');
  list = completeRemoteTurn(list, { ioId: 6, input: '질문', output: '답' }) ?? list;
  assert.equal(completeRemoteTurn(list, { ioId: 6, input: '질문', output: '답' }), null);
  assert.deepEqual(shape(list), ['user:질문', 'assistant:답']);
});

test('도는 중에 연 대화 — 이력의 질문 위에 답만 붙는다', () => {
  let list = historyMessages([{ input: '앞', output: '앞 답' }, { input: '지금', output: '' }]);
  list = setRemoteLive(list, live('진행'));
  list = completeRemoteTurn(list, { ioId: 7, input: '지금', output: '지금 답' }) ?? list;
  assert.deepEqual(shape(list), ['user:앞', 'assistant:앞 답', 'user:지금', 'assistant:지금 답']);
});

test('다음 턴이 시작되면 완결을 놓친 앞 턴은 받은 만큼으로 굳는다', () => {
  let list = startRemoteTurn([], '첫');
  list = appendAssistantText(list, '첫 답 일부');
  list = startRemoteTurn(list, '둘');
  list = completeRemoteTurn(list, { ioId: 8, input: '둘', output: '둘 답' }) ?? list;
  assert.deepEqual(shape(list), ['user:첫', 'assistant:첫 답 일부', 'user:둘', 'assistant:둘 답']);
});

// ── 어디서 열어도 같은 작업 과정 (2026-10-01 사용자 보고) ───────────────────
// 도는 중에 폰으로 연 대화: 질문 자리에 JSON 이 보였고, 웹이 도구를 24번 부르는 동안 폰에는
// 글 몇 줄만 있었다. 도구 과정은 내 턴에서만 쌓였다.

const bash = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  eventType: type,
  toolName: 'Bash',
  toolUseId: id,
  toolInput: { command: 'ls' },
  ...extra,
});

test('내 스트림은 글과 도구를 온 순서대로 쌓는다', () => {
  let msgs = start();
  msgs = appendAssistantText(msgs, '확인합니다.\n\n', 1);
  msgs = attachTool(msgs, bash('u1', 'tool_call'), 2);
  msgs = attachTool(msgs, bash('u1', 'tool_result', { result: 'ok' }), 3);
  msgs = appendAssistantText(msgs, '끝', 4);
  assert.deepEqual(
    msgs[1].flow?.map((f) => f.kind),
    ['text', 'tool', 'tool', 'text'],
  );
  assert.equal(msgs[1].lastEventAt, 4);
  assert.equal(msgs[1].tools?.length, 1);
});

test('다른 화면의 턴 — 도구도 진행분에 쌓이고, 끝나도 작업 과정이 남는다', () => {
  const photo = [{ name: 'image.png', kind: 'image' as const, mimeType: 'image/png' }];
  let list = startRemoteTurn([], 'LLM 이 안 돼', photo, 10);
  assert.deepEqual(list[0].attachments, [{ name: 'image.png', kind: 'image' }]);
  list = appendAssistantText(list, '로그를 봅니다.', 11);
  list = attachTool(list, bash('u1', 'tool_call'), 12);
  list = attachTool(list, bash('u1', 'tool_error', { error: 'boom', durationMs: 30 }), 13);
  assert.equal(list[1].tools?.length, 1);
  list = completeRemoteTurn(list, { ioId: 9, input: 'LLM 이 안 돼', output: '로그를 봅니다. 원인은 X' }) ?? list;
  assert.deepEqual(shape(list), ['user:LLM 이 안 돼', 'assistant:로그를 봅니다. 원인은 X']);
  assert.deepEqual(list[0].attachments, [{ name: 'image.png', kind: 'image' }], '질문의 첨부가 남는다');
  assert.deepEqual(
    list[1].flow?.map((f) => (f.kind === 'text' ? f.text : f.event.eventType)),
    ['로그를 봅니다.', 'tool_call', 'tool_error', ' 원인은 X'],
    '무엇을 했는지 끝난 뒤에도 펼쳐 보고, 받지 못한 끝부분은 완결 본문으로 채운다',
  );
  assert.equal(list[1].startedAt, 10);
  assert.equal(list[1].tools?.[0].error, 'boom');
});

test('구독 때 받은 진행분 — 도구까지 되살리고, 재연결의 스냅샷은 통째로 덮어쓴다', () => {
  const events = [
    { event: 'tool', data: { event_type: 'tool_call', tool_name: 'Bash', tool_use_id: 'u1' }, text_at: 3, at: 5 },
    { event: 'tool', data: { event_type: 'tool_result', tool_name: 'Bash', tool_use_id: 'u1', result: 'ok' }, text_at: 3, at: 6 },
  ];
  let list = setRemoteLive([userMessage('질문')], { text: '확인중다음', events, textTotal: 5, startedAt: 1 });
  assert.equal(list.length, 2);
  assert.equal(list[1].remotePartial, true);
  assert.equal(list[1].tools?.length, 1);
  assert.deepEqual(list[1].flow?.map((f) => f.kind), ['text', 'tool', 'tool', 'text']);
  assert.equal(list[1].startedAt, 1);
  list = setRemoteLive(list, { text: '확인중다음 더', events, textTotal: 7, startedAt: 1 });
  assert.equal(list.length, 2);
  assert.equal(list[1].text, '확인중다음 더');
  assert.equal(list[1].tools?.length, 1, '같은 도구가 두 번 쌓이지 않는다');
});

test('진행분이 이력보다 먼저 와도 사라지지 않는다', () => {
  const early = setRemoteLive([], live('진행 중인 답'));
  const history = historyMessages([{ input: '앞', output: '앞 답' }, { input: '지금', output: '' }]);
  const merged = mergeHistory(history, early);
  assert.deepEqual(shape(merged), ['user:앞', 'assistant:앞 답', 'user:지금', 'assistant:진행 중인 답']);
  assert.equal(merged[3].remotePartial, true);
});

test('이력이 이미 그린 질문은 다른 화면의 턴 시작과 겹치지 않는다', () => {
  const early = startRemoteTurn([], '지금');
  const history = historyMessages([{ input: '지금', output: '' }]);
  assert.deepEqual(shape(mergeHistory(history, early)), ['user:지금', 'assistant:']);
});

test('이 폰에서 보낸 턴이 먼저 섰으면 이력이 덮어쓰지 않는다', () => {
  const mine = [userMessage('새 질문'), assistantPlaceholder()];
  assert.equal(mergeHistory(historyMessages([{ input: '옛', output: '옛 답' }]), mine).length, 2);
});

test('시작을 못 받은 다른 화면의 턴 — 받을 자리를 임시로 세워 답이 두 번 서지 않는다', () => {
  let list = historyMessages([{ input: '지금', output: '' }]);
  list = ensureRemotePartial(list);
  list = appendAssistantText(list, '진행');
  list = completeRemoteTurn(list, { ioId: 3, input: '지금', output: '진행 끝' }) ?? list;
  assert.deepEqual(shape(list), ['user:지금', 'assistant:진행 끝']);
});

test('지난 대화의 작업 과정은 답에 붙는다', () => {
  const msgs = historyMessages([
    {
      ioId: 4,
      input: '질문',
      output: '답',
      process: [
        { kind: 'text', text: '봅니다', at: 100 },
        { kind: 'tool', event: { eventType: 'tool_call', toolName: 'Read', toolUseId: 'r' }, at: 200 },
        { kind: 'tool', event: { eventType: 'tool_result', toolName: 'Read', toolUseId: 'r', result: 'x' }, at: 300 },
      ],
    },
  ]);
  assert.equal(msgs[1].ioId, 4);
  assert.equal(msgs[1].flow?.length, 3);
  assert.equal(msgs[1].tools?.length, 1);
  assert.equal(msgs[1].startedAt, 100);
  assert.equal(msgs[1].lastEventAt, 300);
});

test('놓친 조각이 있어도 끝난 답은 완결 본문으로 채운다', () => {
  const tool = { kind: 'tool' as const, event: { eventType: 'tool_result', toolName: 'Bash', toolUseId: 'u' }, at: 2 };
  const flow = [{ kind: 'text' as const, text: '봅니다.\n\n', at: 1 }, tool, { kind: 'text' as const, text: '원인은', at: 3 }];
  // 이어진 조각을 못 받았다 → 뒤를 채운다
  assert.deepEqual(
    reconcileFlow(flow, '봅니다.\n\n원인은 X 입니다.').map((f) => (f.kind === 'text' ? f.text : 'T')),
    ['봅니다.\n\n', 'T', '원인은 X 입니다.'],
  );
  // 중간 조각을 놓쳤다 → 마지막 도구 뒤를 본문으로 바꾼다
  assert.deepEqual(
    reconcileFlow(flow, '봅니다.\n\n결론: Y').map((f) => (f.kind === 'text' ? f.text : 'T')),
    ['봅니다.\n\n', 'T', '결론: Y'],
  );
  // 맞출 수 없으면 그대로
  assert.deepEqual(reconcileFlow(flow, '전혀 다른 글'), flow);
});
