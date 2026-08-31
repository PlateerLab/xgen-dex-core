// 서버별 인증서 예외와 SSO 연결 입력 검증을 확인하는 단위 테스트
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
  shouldIgnorePrivateCertificateError,
  xgenWebSocketTlsOptions,
} from '@dex/engine/connection-security';
import { HttpSyncTransport, type NetworkFetch } from '../src/main/sync-transport';
import { MCPManager, type McpHttpFetch } from '@dex/engine/mcp-manager';
import type { McpServerConfig } from '@dex/engine';
import { bindHost, memoryPorts } from '@dex/engine';

// 이 테스트는 MCP 매니저를 쓴다 — 엔진은 호스트가 붙어야 돌고, 안 붙으면 던진다.
bindHost(memoryPorts());

test('사설 CA 오류는 활성화된 동일 hostname에서만 허용한다', () => {
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'xgen.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    true,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      false,
      'xgen.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'other.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'xgen.internal',
      'net::ERR_CERT_DATE_INVALID',
    ),
    false,
  );
});

test('XGEN WebSocket은 옵션이 켜진 경우에만 인증서 검증을 비활성화한다', () => {
  assert.deepEqual(xgenWebSocketTlsOptions(false), { rejectUnauthorized: true });
  assert.deepEqual(xgenWebSocketTlsOptions(true), { rejectUnauthorized: false });
});

test('HTTP MCP 전용 세션은 옵션이 켜진 경우에만 사설 CA 오류를 허용한다', () => {
  assert.equal(shouldIgnorePrivateCertificateError(false, 'net::ERR_CERT_AUTHORITY_INVALID'), false);
  assert.equal(shouldIgnorePrivateCertificateError(true, 'net::ERR_CERT_AUTHORITY_INVALID'), true);
  assert.equal(shouldIgnorePrivateCertificateError(true, 'net::ERR_CERT_DATE_INVALID'), false);
});

function fakeMcpFetch(onCall: () => void): McpHttpFetch {
  return async (_url, init) => {
    onCall();
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion,
          capabilities: {},
          serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
        },
      });
    }
    if (body.method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
      });
    }
    return new Response(null, { status: 202 });
  };
}

test('HTTP MCP는 주입 fetch를 사용하고 인증서 옵션 변경 시 연결을 재생성한다', async () => {
  const manager = new MCPManager();
  const config: McpServerConfig = {
    name: 'private-http',
    transport: 'http',
    url: 'https://mcp.internal/mcp',
  };
  let verifiedCalls = 0;
  let privateCalls = 0;

  manager.configure([config], {
    httpFetch: fakeMcpFetch(() => verifiedCalls++),
    allowPrivateCertificate: false,
  });
  const first = await manager.advertise();
  assert.equal(first[0]?.connected, true, first[0]?.error);
  assert.ok(verifiedCalls > 0);

  manager.configure([config], {
    httpFetch: fakeMcpFetch(() => privateCalls++),
    allowPrivateCertificate: true,
  });
  const second = await manager.advertise();
  assert.equal(second[0]?.connected, true, second[0]?.error);
  assert.ok(privateCalls > 0, '인증서 옵션 변경 후 새 HTTP fetch로 다시 연결해야 한다');
  await manager.closeAll();
});

test('워크스페이스 HTTP 통신은 주입된 Electron fetch를 사용한다', async () => {
  let calledUrl = '';
  const injectedFetch: NetworkFetch = async (input) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({ latest_seq: 0, changes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const transport = new HttpSyncTransport(
    {
      baseUrl: 'https://xgen.internal:8443',
      token: () => 'token',
      workflowId: 'workflow-1',
      deviceId: 'device-1',
      fetch: injectedFetch,
      allowPrivateCertificate: true,
    },
    '/tmp/xgen-dex-test',
  );

  assert.deepEqual(await transport.changes(0), { latest_seq: 0, changes: [] });
  assert.match(calledUrl, /^https:\/\/xgen\.internal:8443\/api\/agentflow\/geny-workspace\//);
});

test('SSO URL은 같은 origin 상대 PATH에 완료 콜백을 추가한다', () => {
  const url = new URL(
    buildSsoUrl('https://xgen.internal:8443', '/sso/signin?skip=true', 'finishSso'),
  );
  assert.equal(url.origin, 'https://xgen.internal:8443');
  assert.equal(url.pathname, '/sso/signin');
  assert.equal(url.searchParams.get('skip'), 'true');
  assert.equal(url.searchParams.get('next'), 'parent.finishSso');
  assert.throws(() => buildSsoUrl('https://xgen.internal', 'https://evil.test/sso', 'finishSso'));
  assert.throws(() => buildSsoUrl('https://xgen.internal', '//evil.test/sso', 'finishSso'));
});

test('SSO 완료 응답은 로그인 토큰 필드만 채택한다', () => {
  assert.deepEqual(
    parseSsoLoginResponse({
      success: true,
      access_token: 'ACCESS.jwt',
      refresh_token: 'REFRESH.jwt',
      token_type: 'bearer',
      user_id: '37',
      username: 'user@example.com',
      ignored: { admin: true },
    }),
    {
      accessToken: 'ACCESS.jwt',
      refreshToken: 'REFRESH.jwt',
      tokenType: 'bearer',
      userId: '37',
      username: 'user@example.com',
    },
  );
  assert.throws(() => parseSsoLoginResponse({ success: true }));
  assert.throws(() => parseSsoLoginResponse({ success: false, message: 'Invalid SSO token' }));
});
