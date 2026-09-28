import assert from 'node:assert/strict';
import test from 'node:test';
import { diagEntries, loggingFetch } from '../src/lib/diag';

test('response and error diagnostics never contain body data or credentials', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'secret-access' }), { status: 200 });
    await loggingFetch('https://example.test/api/auth/login', { method: 'POST' });
    assert.doesNotMatch(diagEntries().at(-1)!.line, /secret-access/);

    await loggingFetch('https://example.test/api/user/profile');
    assert.doesNotMatch(diagEntries().at(-1)!.line, /secret-access/);

    globalThis.fetch = async () => { throw new Error('secret-refresh'); };
    await assert.rejects(loggingFetch('https://example.test/api/auth/refresh', { method: 'POST' }));
    assert.doesNotMatch(diagEntries().at(-1)!.line, /secret-refresh/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
