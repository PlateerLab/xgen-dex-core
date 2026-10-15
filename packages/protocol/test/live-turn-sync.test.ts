/**
 * 다른 화면에서 도는 턴을 이 화면이 같게 그리는가 — 질문 본문·첨부·작업 과정.
 *
 * 2026-10-01 모바일 실측: 첨부를 함께 보낸 턴을 도는 중에 열면 질문 말풍선에 `{"input_str": …}` JSON 이
 * 통째로 보였고, 웹에서 도구를 24번 부른 턴이 폰에서는 글 몇 줄로만 보였다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTurnFlow, liveTurnProcess, parseSubscribed } from '../src/chat';
import { HistoryApi, turnAttachments, turnInputText } from '../src/history';
import { appendFlowItem, buildSteps } from '../src/process-timeline';
import type { HttpClient } from '../src/client';

const ENVELOPE = {
  input_str: 'LLM 기능이 전혀 동작하지 않아.\n원인을 찾아 줘',
  attachments: [
    {
      kind: 'image',
      attachment_id: 'conn-1',
      name: 'image.png',
      mime_type: 'image/png',
      size: 68439,
      sha256: 'abc',
      workspace_path: 'uploads/users_130/conn-wf/image(3).png',
    },
  ],
};

test('봉투는 본문만 남긴다 — dict 도, 옛 전파의 JSON 문자열도', () => {
  assert.equal(turnInputText(ENVELOPE), ENVELOPE.input_str);
  assert.equal(turnInputText(JSON.stringify(ENVELOPE, null, 2)), ENVELOPE.input_str);
  assert.equal(turnInputText({ input: '옛 키' }), '옛 키');
});

test('사람이 붙여 넣은 JSON 과 평범한 글은 건드리지 않는다', () => {
  const pasted = '{"input_str": "a", "model": "haiku"}';
  assert.equal(turnInputText(pasted), pasted);
  assert.equal(turnInputText('그냥 질문'), '그냥 질문');
  assert.equal(turnInputText({ member_nm: '홍길동' }), JSON.stringify({ member_nm: '홍길동' }, null, 2));
});

test('첨부는 턴 프레임에서도 봉투에서도 같은 모양으로 읽힌다', () => {
  const expected = [
    {
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      size: 68439,
      workspacePath: 'uploads/users_130/conn-wf/image(3).png',
    },
  ];
  assert.deepEqual(turnAttachments(ENVELOPE), expected);
  assert.deepEqual(turnAttachments(JSON.stringify(ENVELOPE)), expected);
  assert.deepEqual(
    turnAttachments([{ name: 'q3.pdf', kind: 'file', mime_type: 'application/pdf' }, null, { size: 3 }]),
    [{ name: 'q3.pdf', kind: 'file', mimeType: 'application/pdf' }],
  );
  assert.deepEqual(turnAttachments('평범한 글'), []);
});

test('도는 턴의 기록 — 질문은 본문, 첨부는 봉투에서 되살린다', async () => {
  const http = {
    get: async () => ({
      running: true,
      in_out_logs: [
        {
          log_id: 1,
          io_id: 7,
          interaction_id: 'iid',
          workflow_id: 'wf',
          workflow_name: 'wf',
          input_data: ENVELOPE,
          output_data: '',
          attachments: [],
          updated_at: '',
        },
      ],
    }),
  } as unknown as HttpClient;
  const snap = await new HistoryApi(http).snapshot('wf', 'iid');
  assert.equal(snap.running, true);
  assert.equal(snap.turns[0].input, ENVELOPE.input_str);
  assert.deepEqual(snap.turns[0].attachments, [
    {
      name: 'image.png',
      size: 68439,
      contentType: 'image/png',
      type: 'picture',
      path: 'geny-workspace:uploads/users_130/conn-wf/image(3).png',
      bucket: 'geny-workspace',
    },
  ]);
});

const tool = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  event: 'tool',
  data: { event_type: type, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' }, ...extra },
});

test('진행분의 글과 도구를 온 순서대로 되살린다', () => {
  const live = parseSubscribed({
    running: true,
    live: {
      text: '로그를 확인합니다.\n\n원인을 찾았습니다.',
      text_total: 22,
      started_at: 1000,
      events: [
        { ...tool('u1', 'tool_call'), text_at: 12, at: 1100 },
        { ...tool('u1', 'tool_result', { result: 'ok', duration_ms: 40 }), text_at: 12, at: 1140 },
        { event: 'node_status', data: { node_id: 'n', status: 'running' }, text_at: 12, at: 1150 },
      ],
    },
  }).live;
  assert.ok(live);
  assert.equal(live.startedAt, 1000);
  const flow = liveTurnFlow(live);
  assert.deepEqual(
    flow.map((f) => (f.kind === 'text' ? `T:${f.text}` : `U:${f.event.eventType}`)),
    ['T:로그를 확인합니다.\n\n', 'U:tool_call', 'U:tool_result', 'T:원인을 찾았습니다.'],
  );
  const steps = buildSteps(flow);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].rows.length, 1);
  assert.equal(steps[0].rows[0].phase, 'ok');
  assert.equal(steps[0].rows[0].durationMs, 40);
});

test('본문 앞이 잘린 진행분도 눈금을 맞춘다', () => {
  const flow = liveTurnFlow({
    text: '56789',
    textTotal: 10,
    events: [{ ...tool('u1', 'tool_call'), text_at: 7, at: 5 }],
  });
  assert.deepEqual(
    flow.map((f) => (f.kind === 'text' ? f.text : f.event.eventType)),
    ['56', 'tool_call', '789'],
  );
});

test('눈금은 코드 포인트다 — 이모지 뒤에서도 어긋나지 않는다', () => {
  const flow = liveTurnFlow({ text: '👍 좋아요', textTotal: 5, events: [{ ...tool('u1', 'tool_call'), text_at: 2, at: 1 }] });
  assert.deepEqual(
    flow.map((f) => (f.kind === 'text' ? f.text : f.event.eventType)),
    ['👍 ', 'tool_call', '좋아요'],
  );
});

test('순서 정보가 없는 옛 서버 — 도구 먼저, 지금 쓰는 글은 뒤에', () => {
  const flow = liveTurnFlow({ text: '작성 중', events: [tool('u1', 'tool_call')] });
  assert.deepEqual(
    flow.map((f) => f.kind),
    ['tool', 'text'],
  );
});

test('글 조각은 한 칸으로 합친다', () => {
  let flow = appendFlowItem(undefined, { kind: 'text', text: '가', at: 1 });
  flow = appendFlowItem(flow, { kind: 'text', text: '나', at: 2 });
  flow = appendFlowItem(flow, { kind: 'tool', event: { eventType: 'tool_call', toolName: 'Bash' }, at: 3 });
  flow = appendFlowItem(flow, { kind: 'text', text: '다', at: 4 });
  assert.deepEqual(
    flow.map((f) => (f.kind === 'text' ? f.text : 'tool')),
    ['가나', 'tool', '다'],
  );
});

test('웹이 쓰는 서버 모양 — 도구 원문 그대로, 같은 순서', () => {
  const data = { event_type: 'tool_call', tool_name: 'Bash', run_id: 'r1', indicator: { render_hint: 'chip' } };
  const items = liveTurnProcess({ text: '가나다', textTotal: 3, events: [{ event: 'tool', data, text_at: 2, at: 9 }, { event: 'node_status', data: {} }] });
  assert.deepEqual(items, [
    { kind: 'text', text: '가나', at: 9 },
    { kind: 'tool', event: data, at: 9 },
    { kind: 'text', text: '다', at: 9 },
  ]);
});
