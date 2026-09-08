/**
 * 브릿지가 핸드셰이크 실패로 **프로세스를 죽이지 않는지**.
 *
 * 서버가 WS 업그레이드 대신 평범한 HTTP 로 답하면(401·403·404 — 토큰이 폐기됐거나
 * 경로가 없거나 게이트웨이가 막았을 때) `ws` 는 'unexpected-response' 를 낸다.
 * 그때 소켓은 아직 CONNECTING 이고, 정리하려고 `removeAllListeners()` 뒤에
 * `close()` 를 부르면 ws 가 'error' 를 낸다 —
 * "WebSocket was closed before the connection was established".
 *
 * 받을 리스너가 없는 'error' 는 EventEmitter 가 **던진다.** 앱에서는 Electron main
 * 프로세스가 죽고, CI 에서는 관계없는 테스트가 무작위로 깨진다(실제로 그렇게
 * 깨졌다 — apps/cli 의 RPC 테스트가 이 예외를 뒤집어썼다).
 *
 * 같은 실수를 stop·reconnect 경로에서는 이미 고쳐 뒀는데 이 경로만 빠져 있었다.
 * 세 곳이 같은 규칙을 지켜야 하므로 여기서 함께 못박는다.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { getMcpBridge } from '../src/mcp-bridge';

/** WS 업그레이드를 거절하고 평범한 HTTP 로 답하는 서버. */
async function startRejectingServer(status: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end('no upgrade here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

for (const status of [401, 404]) {
  test(`핸드셰이크가 HTTP ${status} 로 떨어져도 프로세스가 죽지 않는다`, async () => {
    const { server, url } = await startRejectingServer(status);
    const uncaught: Error[] = [];
    const onUncaught = (e: Error): void => {
      uncaught.push(e);
    };
    // 이 테스트가 지키는 것이 정확히 이 예외이므로, 여기서만 직접 받아 본다.
    process.on('uncaughtException', onUncaught);

    const bridge = getMcpBridge();
    try {
      bridge.start({
        serverUrl: url,
        userId: 'u1',
        allowPrivateCertificate: false,
        getToken: async () => 'token-that-will-be-rejected',
        // 401 자가치유 경로까지 함께 태운다 — 그 갈래가 close() 를 부르는 쪽이다.
        refreshAuth: async () => 'still-rejected',
      });
      // 핸드셰이크 왕복 + 정리까지 지켜본다.
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      bridge.stop();
      await new Promise((r) => setTimeout(r, 200));
      process.off('uncaughtException', onUncaught);
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }

    assert.deepEqual(
      uncaught.map((e) => e.message),
      [],
      '핸드셰이크 실패가 미처리 예외로 새어 나왔다 — close() 앞에 error 싱크가 빠졌다',
    );
  });
}
