// 모바일 도구 브리지 — hello/ready/mcp_call/mcp_result 와이어 계약 (데스크톱
// McpBridge 와 동일 프레임 — 서버 무변경으로 모바일 도구가 실린다).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MobileToolBridge } from '../src/lib/tool-bridge';
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

test('hello 광고 → ready ACK → mcp_call 실행 → mcp_result 응답', async () => {
  const statuses: string[] = [];
  const calls: Array<{ tool: string; args: unknown }> = [];
  const bridge = new MobileToolBridge({
    wsBase: 'wss://gw.example',
    userId: '7',
    catalog: () => CATALOG,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: 'text', text: '완료' }] };
    },
    onStatus: (s) => statuses.push(`${s.state}:${s.toolCount}`),
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    heartbeatMs: 0,
  });
  bridge.start();
  const ws = FakeWs.last as FakeWs;
  assert.match(ws.url, /\/api\/tools\/ws\/connector-mcp\/7$/);
  ws.open();

  const hello = ws.sent[0] as { type: string; catalog_id: string; tools: ToolAdvert[] };
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.tools, CATALOG);

  // 카탈로그 ACK — 다른 catalog_id 는 무시, 내 것만 connected 전이.
  ws.recv({ type: 'ready', catalog_id: 'stale', tool_count: 99 });
  assert.equal(bridge.current().state, 'connecting');
  ws.recv({ type: 'ready', catalog_id: hello.catalog_id, tool_count: 1 });
  assert.equal(bridge.current().state, 'connected');
  assert.equal(bridge.current().toolCount, 1);

  ws.recv({
    type: 'mcp_call',
    request_id: 'r-1',
    server: 'mobile',
    tool: 'Notify',
    args: { title: '안녕', body: '테스트' },
  });
  await tick();
  assert.deepEqual(calls, [{ tool: 'Notify', args: { title: '안녕', body: '테스트' } }]);
  const result = ws.sent.find((f) => f.type === 'mcp_result');
  assert.deepEqual(result, {
    type: 'mcp_result',
    request_id: 'r-1',
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
  ws.recv({ type: 'mcp_call', request_id: 'r-2', server: 'mobile', tool: 'Notify', args: {} });
  await tick();
  const result = ws.sent.find((f) => f.type === 'mcp_result');
  assert.deepEqual(result, { type: 'mcp_result', request_id: 'r-2', ok: false, error: '권한 거부' });
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
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1 });

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
  ws.recv({ type: 'ready', catalog_id: ws.sent[1].catalog_id, tool_count: 2 });
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
  ws.recv({ type: 'ready', catalog_id: ws.sent[0].catalog_id, tool_count: 1 });
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
