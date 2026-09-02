// 채팅 WS — 구독/실행/스트리밍/종료/unsupported 계약 (가짜 WebSocket).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChat, dispatchExec, stripAgentMarkers } from '../src/lib/chat-ws';

class FakeWs {
  static last: FakeWs | null = null;
  sent: unknown[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWs.last = this;
  }

  open(): void {
    this.readyState = 1; // OPEN (WebSocket.OPEN)
    this.onopen?.();
  }

  recv(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

// node 환경엔 WebSocket.OPEN 상수 접근이 필요하다 (핸들이 비교에 사용).
(globalThis as { WebSocket?: unknown }).WebSocket = Object.assign(FakeWs, { OPEN: 1 });

function makeChat(collect: { data: string[]; tools: string[]; errors: string[] }) {
  return createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-1',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    callbacks: {
      onData: (t) => collect.data.push(t),
      onTool: (ev) => collect.tools.push(ev.toolName ?? ''),
      onError: (m) => collect.errors.push(m),
    },
  });
}

test('구독 → 실행 → 스트리밍 → 종료 — 전체 왕복', async () => {
  const got = { data: [] as string[], tools: [] as string[], errors: [] as string[] };
  const chat = makeChat(got);
  const ws = FakeWs.last as FakeWs;

  assert.match(ws.url, /\/api\/agentflow\/ws\/geny-chat\/mob-wf-1-1$/);
  ws.open();
  // 구독 프레임 — workflow 식별자 포함.
  assert.deepEqual(ws.sent[0], {
    type: 'subscribe',
    data: { workflow_id: 'wf-1', workflow_name: '리서치봇', after: null },
  });
  ws.recv({ type: 'subscribed' });
  assert.equal(chat.state(), 'connected');

  const done = chat.execute('안녕');
  const exec = ws.sent[1] as { type: string; data: Record<string, unknown> };
  assert.equal(exec.type, 'execute');
  assert.equal(exec.data.input_data, '안녕');
  // 모바일 도구 주입 게이트 + 서버 sandbox 강제 — 이 두 값이 제품 정의다.
  assert.equal(exec.data.client_surface, 'connector');
  assert.equal(exec.data.execution_target, 'sandbox');

  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'data', content: '안녕하' } } });
  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'data', content: '세요' } } });
  ws.recv({ type: 'exec', data: { event: 'tool', data: { event_type: 'tool_start', tool_name: 'mcp_mobile_Notify' } } });
  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'end' } } });
  await done;

  assert.deepEqual(got.data, ['안녕하', '세요']);
  assert.deepEqual(got.tools, ['mcp_mobile_Notify']);
  assert.deepEqual(got.errors, []);
  chat.close();
});

test('unsupported — geny 아님은 재접속 없이 명확히 종료', async () => {
  const got = { data: [] as string[], tools: [] as string[], errors: [] as string[] };
  const chat = makeChat(got);
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'unsupported' });
  assert.equal(chat.state(), 'unsupported');
  await assert.rejects(chat.execute('x'));
  chat.close();
});

test('실행 중 연결 단절 — 실행은 오류로 끝나고 원인이 전달된다', async () => {
  const got = { data: [] as string[], tools: [] as string[], errors: [] as string[] };
  const chat = makeChat(got);
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'subscribed' });
  const done = chat.execute('질문');
  ws.close();
  await assert.rejects(done);
  assert.deepEqual(got.errors, ['연결이 끊어졌습니다.']);
  chat.close();
});

test('dispatchExec — summary/quota/error 이벤트 매핑', () => {
  const got: string[] = [];
  const errs: string[] = [];
  const cb = { onData: (t: string) => got.push(t), onError: (m: string) => errs.push(m) };

  assert.equal(dispatchExec('message', { type: 'summary', data: { outputs: ['요약'] } }, cb), null);
  assert.deepEqual(got, ['요약']);
  assert.equal(dispatchExec('quota_exceeded', {}, cb), 'error');
  assert.equal(dispatchExec('message', { type: 'error', message: '노드 실패' }, cb), 'error');
  assert.deepEqual(errs, ['토큰 한도를 초과했습니다.', '노드 실패']);
  assert.equal(dispatchExec('log', {}, cb), null); // 미소비 이벤트는 무해 무시
});

test('stripAgentMarkers — 상태 마커/think 블록 제거 (누적본 적용)', () => {
  assert.equal(
    stripAgentMarkers('앞[AGENT_STATUS]{"a":1}[/AGENT_STATUS]<think>추론</think>뒤'),
    '앞뒤',
  );
});

test('stripAgentMarkers — 청크 경계에서 잘린(미폐쇄) 블록은 숨긴다', () => {
  // 스트리밍 중간: 열림만 도착 — 마커 절반이 새면 안 된다.
  assert.equal(stripAgentMarkers('답변[AGENT_STATUS]{"진행'), '답변');
  assert.equal(stripAgentMarkers('먼저 <think>이건 아직'), '먼저 ');
  // 닫힘이 도착한 누적본 — 정식 제거로 수렴한다.
  assert.equal(stripAgentMarkers('답변[AGENT_STATUS]{"진행":1}[/AGENT_STATUS] 끝'), '답변 끝');
});

test('스트리밍 청크가 마커를 반으로 갈라도 — 누적 후 렌더가 온전하다', async () => {
  const got = { data: [] as string[], tools: [] as string[], errors: [] as string[] };
  const chat = makeChat(got);
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'subscribed' });
  const done = chat.execute('q');
  // 마커가 청크 경계에서 갈라진다 — 전송 계층은 원문 그대로 전달해야 한다.
  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'data', content: '결과[AGENT_ST' } } });
  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'data', content: 'ATUS]x[/AGENT_STATUS]끝' } } });
  ws.recv({ type: 'exec', data: { event: 'message', data: { type: 'end' } } });
  await done;
  const accumulated = got.data.join('');
  assert.equal(accumulated, '결과[AGENT_STATUS]x[/AGENT_STATUS]끝'); // 원문 보존
  assert.equal(stripAgentMarkers(accumulated), '결과끝'); // 렌더 시 온전 제거
  chat.close();
});
