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
