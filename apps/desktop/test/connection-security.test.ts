// 서버별 인증서 예외와 SSO 연결 입력 검증을 확인하는 단위 테스트
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
  xgenWebSocketTlsOptions,
} from '@dex/engine/connection-security';
import { MCPManager, type McpHttpFetch } from '@dex/engine/mcp-manager';
import type { McpServerConfig } from '@dex/engine';
import { bindHost, memoryPorts } from '@dex/engine';

// 이 테스트는 MCP 매니저를 쓴다 — 엔진은 호스트가 붙어야 돌고, 안 붙으면 던진다.
bindHost(memoryPorts());

const here = dirname(fileURLToPath(import.meta.url));
const tlsFixtures = join(here, '../../../packages/engine/test/fixtures/tls');

function tlsGet(port: number, hostname: string, options: ReturnType<typeof xgenWebSocketTlsOptions>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname, port, path: '/', method: 'GET', agent: false, ...options }, (res) => {
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', reject);
    req.end();
  });
}

test('Electron 사설 CA 예외는 실제 PEM의 exact origin, SAN, 유효기간, pin을 모두 검사한다', () => {
  const certificatePem = readFileSync(join(tlsFixtures, 'server.pem'), 'utf8');
  const certificate = new X509Certificate(certificatePem);
  const validStartSeconds = Math.floor(Date.parse(certificate.validFrom) / 1_000);
  const validExpirySeconds = Math.floor(Date.parse(certificate.validTo) / 1_000);
  const trust = [{
    origin: 'https://localhost:8443',
    certificateSha256: [certificate.fingerprint256],
    expiresAt: Date.now() + 60_000,
  }];
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      trust,
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    true,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      [],
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://127.0.0.1:8443/api/health',
      [{ ...trust[0], origin: 'https://127.0.0.1:8443' }],
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    false,
    'wrong SAN is rejected even when origin and pin are approved',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:9443/api/health',
      trust,
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    false,
    'same hostname on a different port is a different origin',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      trust,
      'net::ERR_CERT_DATE_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      [{ ...trust[0], certificateSha256: ['00', certificate.fingerprint256] }],
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    true,
    'pin rotation overlap accepts either explicitly approved pin',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      [{ ...trust[0], expiresAt: Date.now() - 1 }],
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificatePem,
      validStartSeconds,
      validExpirySeconds,
    ),
    false,
    'expired trust approval fails closed',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health', trust,
      'net::ERR_CERT_AUTHORITY_INVALID', certificatePem,
      validStartSeconds, Math.floor(Date.now() / 1_000) - 1,
    ),
    false,
    'expired leaf certificate fails closed',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health', trust,
      'net::ERR_CERT_AUTHORITY_INVALID', certificatePem,
      Math.floor(Date.now() / 1_000) + 60, validExpirySeconds,
    ),
    false,
    'not-yet-valid Electron certificate seconds fail closed',
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://localhost:8443/api/health',
      [{ ...trust[0], certificateSha256: ['00'] }],
      'net::ERR_CERT_AUTHORITY_INVALID', certificatePem,
      validStartSeconds, validExpirySeconds,
    ),
    false,
    'pin is calculated from PEM rather than trusting Electron fingerprint metadata',
  );
});

test('Electron hostname-only verify proc은 사용자 지정 예외를 승인하지 않는다', () => {
  const source = readFileSync(join(here, '../src/main/index.ts'), 'utf8');
  assert.match(source, /app\.on\('certificate-error'/);
  assert.match(source, /setCertificateVerifyProc\(null\)/);
  assert.doesNotMatch(source, /setCertificateVerifyProc\(\(request, callback\)/);
});

test('XGEN WebSocket trust는 항상 표준 검증을 유지하고 exact origin에만 CA/pin을 적용한다', () => {
  assert.deepEqual(xgenWebSocketTlsOptions('https://xgen.internal'), { rejectUnauthorized: true });
  assert.deepEqual(xgenWebSocketTlsOptions('https://xgen.internal', [{
    origin: 'https://other.internal', ca: ['CA'], expiresAt: Date.now() + 60_000,
  }]), { rejectUnauthorized: true });
  const scoped = xgenWebSocketTlsOptions('https://xgen.internal', [{
    origin: 'https://xgen.internal', ca: ['CA'], certificateSha256: ['AABB'], expiresAt: Date.now() + 60_000,
  }]);
  assert.equal(scoped.rejectUnauthorized, true);
  assert.deepEqual(scoped.ca, ['CA']);
  assert.equal(typeof scoped.checkServerIdentity, 'function');
  assert.deepEqual(xgenWebSocketTlsOptions('wss://xgen.internal/socket', [{
    origin: 'https://xgen.internal', ca: ['CA'], expiresAt: Date.now() + 60_000,
  }]).ca, ['CA']);
  assert.equal(xgenWebSocketTlsOptions('wss://xgen.internal:8443/socket', [{
    origin: 'https://xgen.internal', ca: ['CA'], expiresAt: Date.now() + 60_000,
  }]).ca, undefined);
});

test('실제 TLS handshake는 승인 CA+pin만 통과하고 hostname/origin/pin 오류를 거부한다', async () => {
  const ca = readFileSync(join(tlsFixtures, 'ca.pem'), 'utf8');
  const certificate = readFileSync(join(tlsFixtures, 'server.pem'), 'utf8');
  const key = readFileSync(join(tlsFixtures, 'server-key.pem'), 'utf8');
  const fingerprint = new X509Certificate(certificate).fingerprint256;
  const server = createHttpsServer({ key, cert: certificate }, (_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const origin = `https://localhost:${port}`;
  const trust = [{ origin, ca: [ca], certificateSha256: [fingerprint], expiresAt: Date.now() + 60_000 }];
  try {
    await tlsGet(port, 'localhost', xgenWebSocketTlsOptions(origin, trust));
    await tlsGet(port, 'localhost', xgenWebSocketTlsOptions(`wss://localhost:${port}/socket`, trust));
    await assert.rejects(
      () => tlsGet(
        port,
        '127.0.0.1',
        xgenWebSocketTlsOptions(
          `https://127.0.0.1:${port}`,
          [{ ...trust[0], origin: `https://127.0.0.1:${port}` }],
        ),
      ),
      /IP address|certificate|Hostname/i,
    );
    await assert.rejects(
      () => tlsGet(port, 'localhost', xgenWebSocketTlsOptions(origin, [])),
      /certificate|self-signed|unable to verify/i,
    );
    await assert.rejects(
      () => tlsGet(port, 'localhost', xgenWebSocketTlsOptions(origin, [{ ...trust[0], certificateSha256: ['00'] }])),
      /pin mismatch/i,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
