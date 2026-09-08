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

test('실행 중 연결 단절 — 실패가 아니라 분리다 (턴은 서버에서 계속 돈다)', async () => {
  /**
   * 예전에는 여기서 곧장 실패로 접었다 — `onError('연결이 끊어졌습니다.')` +
   * promise reject. 그런데 서버 실행은 연결이 아니라 **대화**에 매여 있어서,
   * 폰이 잠기거나 지하철에 들어가거나 게이트웨이가 시간 제한으로 자른 뒤에도
   * 그 턴은 계속 돈다. 실패로 접으면 멀쩡히 도는 턴이 끝난 것처럼 보이고,
   * 진짜 답은 아무 데도 안 보인다(2026-09-08 실측).
   *
   * 이제: 오류 없음, promise 는 정상 종료, running 은 켜진 채로 재연결에 맡긴다.
   */
  const got = { data: [] as string[], tools: [] as string[], errors: [] as string[] };
  const detached: number[] = [];
  const running: boolean[] = [];
  const chat = createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-cut',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    onRunning: (r) => running.push(r),
    callbacks: {
      onData: (t) => got.data.push(t),
      onError: (m) => got.errors.push(m),
      onDetached: () => detached.push(1),
    },
  });
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'subscribed' });
  const done = chat.execute('질문');
  ws.close();

  await done; // 던지지 않는다 — 실패가 아니다
  assert.deepEqual(got.errors, [], '끊김을 오류로 그리면 안 된다');
  assert.deepEqual(detached, [1], '분리를 알려야 화면이 [진행 중] 을 유지한다');
  assert.equal(running.at(-1), true, '턴은 아직 돈다');
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

// ── 다른 기기에서 도는 턴 ──────────────────────────────────────────────
//
// 서버 실행은 연결이 아니라 대화에 매여 있다 — 연결을 끊어도 계속 돈다. 그래서
// 웹이나 앱에서 시작한 턴이 이 폰을 켠 순간에도 돌 수 있고, 그 사실을 모르면
// 화면에는 끝난 대화처럼 보인 채 그 위에 새 턴을 얹게 된다.

test('구독 확립이 지금 도는 턴을 알려 준다 — 재연결마다 다시', () => {
  const seen: boolean[] = [];
  const chat = createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-1',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    onRunning: (r) => seen.push(r),
    callbacks: {},
  });
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'subscribed', data: { cursor: 0, running: true } });
  assert.deepEqual(seen, [true], '도는 턴이 있다는 사실이 전달되지 않았다');

  // 그 턴이 끝나면 — 우리 스트림이 아니어도 상태는 내려가야 한다.
  ws.recv({ type: 'exec_done', data: {} });
  assert.deepEqual(seen, [true, false]);
  chat.close();
});

test('도는 턴이 없으면 running=false 로 알려 준다', () => {
  const seen: boolean[] = [];
  const chat = createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-2',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    onRunning: (r) => seen.push(r),
    callbacks: {},
  });
  const ws = FakeWs.last as FakeWs;
  ws.open();
  // 구버전 서버는 running 을 안 싣는다 — 모르면 false 여야 한다(작성기가 잠기면 안 된다).
  ws.recv({ type: 'subscribed', data: { cursor: 0 } });
  assert.deepEqual(seen, [false]);
  chat.close();
});

test('하트비트가 지금 도는 턴을 되풀이해 말한다 — 분리 뒤의 유일한 근거', () => {
  /**
   * subscribed 는 **구독 시점**만, message 는 **완결**만 알려 준다. 그 사이에
   * 다른 기기에서 새 턴이 시작되면 완결까지 아무도 몰랐다.
   *
   * 엣지 이벤트(exec_started) 대신 하트비트에 실은 이유: 시작을 한 번만 알리는
   * 신호는 그 순간 연결이 끊겨 있으면 영영 놓친다. 하트비트는 10초마다 현재
   * 사실을 다시 말하므로, 끊겼다 붙어도·늦게 들어와도 저절로 맞춰진다.
   */
  const seen: boolean[] = []
  const chat = createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-hb',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    onRunning: (r) => seen.push(r),
    callbacks: {},
  })
  const ws = FakeWs.last as FakeWs
  ws.open()
  ws.recv({ type: 'subscribed', data: { cursor: 0, running: false } })
  // 다른 기기에서 턴이 시작됐다 — 다음 하트비트가 그 사실을 나른다.
  ws.recv({ type: 'heartbeat', data: { ts: 1, running: true } })
  ws.recv({ type: 'heartbeat', data: { ts: 2, running: true } })
  ws.recv({ type: 'heartbeat', data: { ts: 3, running: false } })
  assert.deepEqual(seen, [false, true, true, false])
  chat.close()
})

test('running 없는 하트비트는 상태를 건드리지 않는다 (구버전 서버)', () => {
  const seen: boolean[] = []
  const chat = createChat({
    wsBase: 'wss://gw.example',
    workflowId: 'wf-1',
    workflowName: '리서치봇',
    interactionId: 'mob-wf-1-old',
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    onRunning: (r) => seen.push(r),
    callbacks: {},
  })
  const ws = FakeWs.last as FakeWs
  ws.open()
  ws.recv({ type: 'subscribed', data: { cursor: 0 } })
  ws.recv({ type: 'heartbeat', data: { ts: 1 } })
  // subscribed 의 false 하나뿐 — 하트비트가 없는 값을 지어내면 안 된다.
  assert.deepEqual(seen, [false])
  chat.close()
})
