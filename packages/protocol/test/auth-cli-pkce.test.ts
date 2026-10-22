import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XgenClient } from '@dex/protocol';

test('CLI PKCE exchange sends state and requires an exact echoed state', async () => {
  const bodies: unknown[] = [];
  const client = new XgenClient({
    baseUrl: 'https://xgen.example.com',
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      return Response.json({
        success: true,
        access_token: 'access',
        refresh_token: 'refresh',
        state: body.state,
      });
    },
  });
  const result = await client.auth.exchangeCliCode('code', 'verifier', 'state-123');
  assert.deepEqual(bodies, [{ authorization_code: 'code', code_verifier: 'verifier', state: 'state-123' }]);
  assert.equal(result.accessToken, 'access');

  const mismatch = new XgenClient({
    baseUrl: 'https://xgen.example.com',
    fetch: async () => Response.json({ success: true, access_token: 'access', state: 'other' }),
  });
  await assert.rejects(
    () => mismatch.auth.exchangeCliCode('code', 'verifier', 'state-123'),
    /state가 일치하지 않습니다/,
  );
});
