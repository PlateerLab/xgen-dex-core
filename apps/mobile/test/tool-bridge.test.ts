// 모바일 도구 브리지 — hello/ready/mcp_call/mcp_result 와이어 계약 (데스크톱
// McpBridge 와 동일 프레임 — 서버 무변경으로 모바일 도구가 실린다).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MobileToolBridge, toolCallContext } from '../src/lib/tool-bridge';
import type { ToolAdvert } from '../src/lib/mobile-tools';

class FakeWs {
  static last: FakeWs | null = null;
  sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWs.last = this;
  }
  open(): void {
    this.readyState = 1;
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
(globalThis as { WebSocket?: unknown }).WebSocket = Object.assign(FakeWs, { OPEN: 1 });

const CATALOG: ToolAdvert[] = [
  { server: 'mobile', name: 'Notify', description: '알림', inputSchema: { type: 'object' } },
];

const tick = () => new Promise((r) => setTimeout(r, 5));
const V2 = { protocol_version: 2, connection_generation: 7 } as const;

test('hello 광고 → ready ACK → mcp_call 실행 → mcp_result 응답', async () => {
  const statuses: string[] = [];
  const calls: Array<{ tool: string; args: unknown; context: unknown }> = [];
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async (tool, args, context) => {
      calls.push({ tool, args, context });
      return { content: [{ type: 'text', text: '완료' }] };
    },
    onStatus: (s) => statuses.push(`${s.state}:${s.toolCount}`),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
    deviceId: 'mob-test',
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  assert.match(ws.url, /\/api\/tools\/ws\/connector-mcp\/7$/);
  ws.open();

  const hello = ws.sent[0] as { type: string; catalog_id: string; tools: ToolAdvert[] };
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.tools, CATALOG);
  assert.deepEqual((hello as unknown as { features: string[] }).features, [
    'workspace_transfer_cap_v1',
  ]);

  // 카탈로그 ACK — 다른 catalog_id 는 무시, 내 것만 connected 전이.
  ws.recv({ type: 'ready', catalog_id: 'stale', tool_count: 99 });
  assert.equal(bridge.current().state, 'connecting');
  ws.recv({ type: 'ready', catalog_id: hello.catalog_id, tool_count: 1, ...V2 });
  assert.equal(bridge.current().state, 'connected');
  assert.equal(bridge.current().toolCount, 1);

  ws.recv({
    type: 'mcp_call',
    request_id: 'r-1',
    server: 'mobile',
    tool: 'Notify',
    args: { title: '안녕', body: '테스트' },
    ...V2,
    request_nonce: 'nonce-1',
    // 서버가 보증하는 호출자 신원 — 도구가 어느 대화의 폴더를 쓸지 정한다.
    context: { workflow_id: 'wf-1', interaction_id: 'chat-9' },
  });
  await tick();
  assert.deepEqual(calls, [
    {
      tool: 'Notify',
      args: { title: '안녕', body: '테스트' },
      context: {
        workflowId: 'wf-1',
        interactionId: 'chat-9',
        request_id: 'r-1',
        request_nonce: 'nonce-1',
        connection_generation: 7,
        protocol: 2,
        device_id: 'mob-test',
      },
    },
  ]);
  const result = ws.sent.find((f) => f.type === 'mcp_result');
  assert.deepEqual(result, {
    type: 'mcp_result',
    request_id: 'r-1',
    ...V2,
    request_nonce: 'nonce-1',
    ok: true,
    result: { content: [{ type: 'text', text: '완료' }] },
  });
  bridge.stop();
});

test('도구 실행 예외 — ok:false 로 오류를 서버에 돌려준다', async () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => {
      throw new Error('권한 거부');
    },
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({
    type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2,
  });
  ws.recv({
    type: 'mcp_call', request_id: 'r-2', server: 'mobile', tool: 'Notify', args: {},
    ...V2, request_nonce: 'nonce-2',
  });
  await tick();
  const result = ws.sent.find((f) => f.type === 'mcp_result');
  assert.deepEqual(result, {
    type: 'mcp_result', request_id: 'r-2', ...V2, request_nonce: 'nonce-2',
    ok: false, error: '권한 거부',
  });
  bridge.stop();
});

test('kick — 끊긴 브리지를 백오프 없이 즉시 재연결한다 (앱 복귀)', () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const first = FakeWs.last as FakeWs;
  first.open();
  first.close(); // 백그라운드 단절 흉내 — 백오프 재시도 예약 상태
  bridge.kick();
  const second = FakeWs.last as FakeWs;
  assert.notEqual(second, first); // 대기 없이 새 소켓
  second.open();
  assert.equal((second.sent[0] as { type: string }).type, 'hello'); // 카탈로그 재광고
  bridge.stop();
});

test('stop — 소켓 종료 + off 상태, 재접속 시도 없음', () => {
  const statuses: string[] = [];
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    onStatus: (s) => statuses.push(s.state),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  (FakeWs.last as FakeWs).open();
  bridge.stop();
  assert.equal(bridge.current().state, 'off');
  assert.equal(statuses[statuses.length - 1], 'off');
});

test('refreshCatalog 는 갱신된 카탈로그로 즉시 재-hello 한다 (스테일 광고 회귀)', async () => {
  // 실사고 회귀: 세션 실행 중 설정에서 [위치] 를 켜도 hello 가 옛 카탈로그를
  // 내보내 에이전트에 Location 이 안 보였다 — catalog() 는 호출 시점 값을
  // 읽어야 하고, refreshCatalog 는 새 목록으로 hello 를 다시 보내야 한다.
  let tools: ToolAdvert[] = [...CATALOG];
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => tools,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  await tick();
  assert.equal(ws.sent.length, 1);
  assert.equal((ws.sent[0].tools as ToolAdvert[]).length, 1);
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2 });

  // 그룹 토글 → 카탈로그에 Location 추가 후 재광고.
  tools = [
    ...CATALOG,
    { server: 'mobile', name: 'Location', description: '위치', inputSchema: { type: 'object' } },
  ];
  bridge.refreshCatalog();
  await tick();
  assert.equal(ws.sent.length, 2);
  const names = (ws.sent[1].tools as ToolAdvert[]).map((t) => t.name);
  assert.deepEqual(names, ['Notify', 'Location']);
  assert.notEqual(ws.sent[1].catalog_id, ws.sent[0].catalog_id);
  ws.recv({
    type: 'ready', catalog_id: ws.sent[1].catalog_id, tool_count: 2,
    protocol_version: 2, connection_generation: 8,
  });
  assert.equal(bridge.current().toolCount, 2);
  bridge.stop();
});

test('연결 전 refreshCatalog 는 kick 으로 즉시 재연결을 시도한다', async () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const first = FakeWs.last as FakeWs;
  first.close(); // 연결 실패 → 백오프 대기 진입
  await tick();
  bridge.refreshCatalog(); // 대기를 건너뛰고 즉시 재연결해야 한다
  await tick();
  const second = FakeWs.last as FakeWs;
  assert.notEqual(second, first);
  second.open();
  await tick();
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].type, 'hello');
  bridge.stop();
});

test('hello 후 ready 미수신이면 워치독이 소켓을 끊어 재연결로 수렴한다', async () => {
  // 서버가 hello 를 놓치는 어떤 경우에도(프록시 유실 등) 광고가 조용히
  // 증발하지 않도록 — ACK 없으면 재연결해 fresh hello.
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  const bridgeAny = bridge as unknown as { ackWatchdog: ReturnType<typeof setTimeout> | null };
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  await tick();
  assert.equal(ws.sent.length, 1);
  assert.ok(bridgeAny.ackWatchdog, 'hello 직후 워치독이 걸려 있어야 한다');
  // ready 대신 침묵 — 워치독을 수동 발화시켜 재연결을 확인한다.
  const timer = bridgeAny.ackWatchdog!;
  clearTimeout(timer);
  bridgeAny.ackWatchdog = null;
  ws.close(); // 워치독이 하는 일과 동일 (소켓 종료 → scheduleRetry)
  await tick();
  assert.equal(bridge.current().state, 'connecting');
  bridge.stop();
});

test('ready 수신 시 워치독이 해제된다', async () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  const bridgeAny = bridge as unknown as { ackWatchdog: ReturnType<typeof setTimeout> | null };
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  await tick();
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2 });
  await tick();
  assert.equal(bridgeAny.ackWatchdog, null);
  assert.equal(bridge.current().state, 'connected');
  bridge.stop();
});

test('hello 에 기기 식별이 실린다 — 멀티 디바이스 슬롯 키', async () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
    deviceId: 'mob-abc',
    deviceName: 'Galaxy · 모바일',
    devicePlatform: 'android',
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  await tick();
  assert.equal(ws.sent[0].device_id, 'mob-abc');
  assert.equal(ws.sent[0].device_name, 'Galaxy · 모바일');
  assert.equal(ws.sent[0].device_platform, 'android');
  bridge.stop();
});

test('다른 화면에서 온 호출이면 그 화면의 이름이 실린다 — 휴대폰이 알리고, 자리 도구는 막는다', () => {
  assert.deepEqual(toolCallContext({ interaction_id: 'c1', remote: '1', origin_device_name: '사무실 PC' }), {
    workflowId: undefined,
    interactionId: 'c1',
    remote: true,
    originName: '사무실 PC',
  });
  assert.equal(toolCallContext({ interaction_id: 'c1', remote: '1' }).originName, '다른 기기');
  assert.equal(toolCallContext({ interaction_id: 'c1' }).remote, undefined);
});

test('kick — 열려 있다고 믿는 소켓도 카탈로그를 다시 알려 살아 있는지 확인한다 (앱 복귀, 2026-10-02)', async () => {
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => ({ content: [{ type: 'text', text: '' }] }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const first = FakeWs.last as FakeWs;
  first.open();
  const hellos = () => first.sent.filter((f) => (f as { type: string }).type === 'hello').length;
  assert.equal(hellos(), 1);
  bridge.kick(); // 뒤에 있던 사이 OS 가 소켓을 놓았을 수 있다 — 이쪽에서는 아직 열려 있다
  assert.equal(hellos(), 2, '다시 알린다 — 서버의 확인(ready)이 살아 있음을 증명한다');
  const bridgeAny = bridge as unknown as { ackWatchdog: ReturnType<typeof setTimeout> | null };
  assert.ok(bridgeAny.ackWatchdog, '확인이 오지 않으면 워치독이 새로 붙는다');
  bridge.stop();
});

test('서버 시한(deadline_ms)보다 먼저 스스로 멈추고 사유를 돌려준다 — 도는 일도 끊긴다', async () => {
  let aborted = false;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: (_tool, _args, _context, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ content: [{ type: 'text', text: 'late' }] });
        });
      }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({
    type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2,
  });
  ws.recv({
    type: 'mcp_call', request_id: 'r-slow', server: 'mobile', tool: '_UserPcRun',
    args: {}, deadline_ms: 1_200, ...V2, request_nonce: 'nonce-slow',
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(ws.sent.some((f) => f.type === 'mcp_result'), false, '아직 시한 전');
  // 이 기기의 시한은 서버 시한보다 1초 짧다(1.2초 → 1초).
  await new Promise((r) => setTimeout(r, 800));
  const result = ws.sent.find((f) => f.type === 'mcp_result') as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /LOCAL_TIMEOUT.*_UserPcRun/);
  assert.equal(aborted, true);
  bridge.stop();
});

test('서버의 mcp_cancel 이 오면 그 호출을 끊는다', async () => {
  let aborted = false;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: (_tool, _args, _context, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ content: [{ type: 'text', text: 'stopped' }], isError: true });
        });
      }),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({
    type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2,
  });
  ws.recv({
    type: 'mcp_call', request_id: 'r-c', server: 'mobile', tool: '_UserPcRun',
    args: {}, deadline_ms: 60_000, ...V2, request_nonce: 'nonce-c',
  });
  await tick();
  ws.recv({
    type: 'mcp_cancel', request_id: 'r-c', reason: 'timeout', ...V2, request_nonce: 'nonce-c',
  });
  await tick();
  assert.equal(aborted, true);
  assert.equal(ws.sent.some((f) => f.type === 'mcp_result' && f.request_id === 'r-c'), false);
  bridge.stop();
});

test('protocol v2 ready 전과 잘못된 generation/nonce 호출은 실행하지 않는다', async () => {
  let calls = 0;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async () => {
      calls++;
      return { content: [{ type: 'text', text: 'unexpected' }] };
    },
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  const catalogId = ws.sent[0].catalog_id;

  ws.recv({ type: 'ready', catalog_id: catalogId, tool_count: 1 });
  ws.recv({
    type: 'mcp_call', request_id: 'legacy', server: 'mobile', tool: 'Notify', args: {},
  });
  ws.recv({
    type: 'ready', catalog_id: catalogId, tool_count: 1,
    protocol_version: 2, connection_generation: 0,
  });
  ws.recv({
    type: 'ready', catalog_id: catalogId, tool_count: 1, ...V2,
  });
  for (const frame of [
    { type: 'mcp_call', request_id: 'missing-nonce', server: 'mobile', tool: 'Notify', ...V2 },
    {
      type: 'mcp_call', request_id: 'stale-generation', server: 'mobile', tool: 'Notify',
      protocol_version: 2, connection_generation: 6, request_nonce: 'nonce-stale',
    },
    {
      type: 'mcp_call', request_id: 'bad-nonce', server: 'mobile', tool: 'Notify',
      ...V2, request_nonce: 123,
    },
  ]) ws.recv(frame);
  await tick();

  assert.equal(calls, 0);
  assert.equal(ws.sent.some((f) => f.type === 'mcp_result'), false);
  bridge.stop();
});

test('duplicate call과 cancel은 exact tuple로 묶이고 취소 뒤 late result를 보내지 않는다', async () => {
  let calls = 0;
  let aborted = false;
  let finish!: (value: { content: Array<{ type: 'text'; text: string }> }) => void;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: (_tool, _args, _context, signal) => {
      calls++;
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise((resolve) => { finish = resolve; });
    },
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2 });
  const call = {
    type: 'mcp_call', request_id: 'r-exact', server: 'mobile', tool: 'Notify', args: {},
    ...V2, request_nonce: 'nonce-exact',
  };
  ws.recv(call);
  await tick();
  ws.recv(call);
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(ws.sent.find((f) => f.error === 'duplicate_request'), {
    type: 'mcp_result', request_id: 'r-exact', ...V2, request_nonce: 'nonce-exact',
    ok: false, error: 'duplicate_request',
  });

  ws.recv({
    type: 'mcp_cancel', request_id: 'r-exact', ...V2, request_nonce: 'wrong',
  });
  ws.recv({
    type: 'mcp_cancel', request_id: 'r-exact', protocol_version: 2,
    connection_generation: 6, request_nonce: 'nonce-exact',
  });
  ws.recv({
    type: 'mcp_cancel', request_id: 'r-exact',
    connection_generation: 7, request_nonce: 'nonce-exact',
  });
  assert.equal(aborted, false);
  ws.recv({
    type: 'mcp_cancel', request_id: 'r-exact', ...V2, request_nonce: 'nonce-exact',
  });
  assert.equal(aborted, true);
  finish({ content: [{ type: 'text', text: 'late' }] });
  await tick();
  assert.equal(ws.sent.some((f) => JSON.stringify(f).includes('late')), false);
  bridge.stop();
});

test('재연결은 이전 socket의 pending 호출을 취소하고 old callback 결과를 버린다', async () => {
  let aborted = false;
  let finish!: (value: { content: Array<{ type: 'text'; text: string }> }) => void;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: (_tool, _args, _context, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise((resolve) => { finish = resolve; });
    },
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const old = FakeWs.last as FakeWs;
  old.open();
  old.recv({ type: 'ready', catalog_id: old.sent[0].catalog_id, tool_count: 1, ...V2 });
  old.recv({
    type: 'mcp_call', request_id: 'r-old', server: 'mobile', tool: 'Notify', args: {},
    ...V2, request_nonce: 'nonce-old',
  });
  await tick();
  old.close();
  bridge.kick();
  const replacement = FakeWs.last as FakeWs;
  replacement.open();
  replacement.recv({
    type: 'ready', catalog_id: replacement.sent[0].catalog_id, tool_count: 1,
    protocol_version: 2, connection_generation: 8,
  });
  assert.equal(aborted, true);
  finish({ content: [{ type: 'text', text: 'old-late' }] });
  await tick();
  assert.equal(old.sent.some((f) => JSON.stringify(f).includes('old-late')), false);
  assert.equal(replacement.sent.some((f) => f.type === 'mcp_result'), false);
  bridge.stop();
});

test('새 generation ACK 뒤에는 이전 generation callback 결과를 보내지 않는다', async () => {
  let aborted = false;
  let finish!: (value: { content: Array<{ type: 'text'; text: string }> }) => void;
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: (_tool, _args, _context, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise((resolve) => { finish = resolve; });
    },
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1, ...V2 });
  ws.recv({
    type: 'mcp_call', request_id: 'r-stale-result', server: 'mobile', tool: 'Notify', args: {},
    ...V2, request_nonce: 'nonce-stale-result',
  });
  await tick();

  bridge.refreshCatalog();
  assert.equal(aborted, true, '새 hello 는 이전 generation 의 로컬 작업도 중단한다');
  const latestHello = ws.sent.filter((frame) => frame.type === 'hello').at(-1)!;
  ws.recv({
    type: 'ready', catalog_id: latestHello.catalog_id, tool_count: 1,
    protocol_version: 2, connection_generation: 8,
  });
  finish({ content: [{ type: 'text', text: 'stale-result' }] });
  await tick();
  assert.equal(ws.sent.some((f) => JSON.stringify(f).includes('stale-result')), false);
  bridge.stop();
});
