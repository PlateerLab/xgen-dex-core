/**
 * 대화 소켓 — 다른 기기의 턴이 **도구 과정까지** 이 화면에 오는가(2026-10-01 사용자 보고).
 *
 * 완결 행(message)에는 서버가 실행 기록에서 되살린 작업 과정(process)이 실린다. 그리고 소켓이 끊겼다 다시
 * 붙으면 끊긴 사이에 시작해 끝난 턴은 어떤 프레임으로도 오지 않으므로, 화면이 이력으로 메우도록 구멍을 알린다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { ConversationWatchHub, type ConversationTurn, type PeerTurnEvent } from '../src/conversation-watch';

function until(check: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function server(onSubscribe: (ws: ServerSocket, count: number) => void) {
  const wss = new WebSocketServer({ port: 0 });
  let subscribes = 0;
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe') onSubscribe(ws, ++subscribes);
    });
  });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  return { wss, base: `http://127.0.0.1:${port}`, subscribes: () => subscribes };
}

test('완결 행의 작업 과정을 화면에 넘긴다', async () => {
  const srv = await server((ws) => {
    ws.send(JSON.stringify({ type: 'subscribed', data: { cursor: 1, seq: 0, running: false } }));
    ws.send(JSON.stringify({
      type: 'message',
      data: {
        io_id: 2, input_data: '앱 상태?', output_data: '정상입니다.', updated_at: '', source: 'user',
        process: [
          { kind: 'tool', at: 1, event: { event_type: 'tool_call', tool_name: 'AppList', tool_use_id: 'a' } },
          { kind: 'tool', at: 2, event: { event_type: 'tool_result', tool_name: 'AppList', tool_use_id: 'a', result: '- app' } },
          { kind: 'text', at: 3, text: '정상입니다.' },
        ],
      },
    }));
  });
  const turns: ConversationTurn[] = [];
  const hub = new ConversationWatchHub((t) => turns.push(t));
  hub.setDeps({ baseUrl: () => srv.base, token: async () => 't', allowPrivateCertificate: () => false });
  hub.watch('wf', 'wf', 'iid');
  try {
    await until(() => turns.length === 1);
    assert.equal(turns[0].ioId, 2);
    assert.deepEqual(turns[0].process?.map((p) => (p.kind === 'tool' ? `${p.event.toolName}:${p.event.eventType}` : p.text)), [
      'AppList:tool_call', 'AppList:tool_result', '정상입니다.',
    ]);
  } finally {
    hub.stopAll();
    srv.wss.close();
  }
});

test('과정이 없는 옛 행은 예전 모양 그대로다', async () => {
  const srv = await server((ws) => {
    ws.send(JSON.stringify({ type: 'subscribed', data: { cursor: 0, seq: 0, running: false } }));
    ws.send(JSON.stringify({ type: 'message', data: { io_id: 3, input_data: 'q', output_data: 'a', updated_at: '', source: 'user' } }));
  });
  const turns: ConversationTurn[] = [];
  const hub = new ConversationWatchHub((t) => turns.push(t));
  hub.setDeps({ baseUrl: () => srv.base, token: async () => 't', allowPrivateCertificate: () => false });
  hub.watch('wf', 'wf', 'iid');
  try {
    await until(() => turns.length === 1);
    assert.equal(turns[0].process, undefined);
  } finally {
    hub.stopAll();
    srv.wss.close();
  }
});

test('끊겼다 다시 붙으면 구멍을 알린다 — 첫 구독은 알리지 않는다', async () => {
  const srv = await server((ws, count) => {
    ws.send(JSON.stringify({ type: 'subscribed', data: { cursor: 0, seq: 0, running: false } }));
    // 첫 연결은 곧 끊는다 — 서버 재배포·망 끊김
    if (count === 1) setTimeout(() => ws.terminate(), 30);
  });
  const peers: PeerTurnEvent[] = [];
  const hub = new ConversationWatchHub(() => {}, () => {}, (e) => peers.push(e));
  hub.setDeps({ baseUrl: () => srv.base, token: async () => 't', allowPrivateCertificate: () => false });
  hub.watch('wf', 'wf', 'iid');
  try {
    await until(() => srv.subscribes() >= 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(peers, [], '첫 구독은 화면이 막 이력을 읽었다');
    await until(() => peers.length === 1, 8000);
    assert.deepEqual(peers[0], { kind: 'gap', interactionId: 'iid' });
  } finally {
    hub.stopAll();
    srv.wss.close();
  }
});
