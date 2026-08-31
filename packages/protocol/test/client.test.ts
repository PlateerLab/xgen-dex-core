import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { XgenClient } from '@dex/protocol';

/**
 * A tiny mock of the XGEN gateway that implements exactly the endpoints the
 * connector uses, with the real wire shapes (SHA-256 password check, paged
 * agent list, SSE chat stream). Lets us verify the whole login→list→chat flow
 * end-to-end without a live XGEN.
 */
function mockXgen(): Promise<{ server: Server; baseUrl: string }> {
  const users = { 'me@corp.com': createHash('sha256').update('pw123').digest('hex') };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
    const readBody = () =>
      new Promise<any>((resolve) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => resolve(b ? JSON.parse(b) : {}));
      });

    (async () => {
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody();
        const ok = users[body.email as keyof typeof users] === body.password;
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            ok
              ? {
                  success: true,
                  access_token: 'ACCESS.jwt',
                  refresh_token: 'REFRESH.jwt',
                  token_type: 'bearer',
                  user_id: '123',
                  username: 'alice',
                }
              : { success: false, message: 'bad credentials', access_token: null },
          ),
        );
        return;
      }
      if (url.pathname === '/api/auth/validate-token' && req.method === 'POST') {
        const body = await readBody();
        const valid = body.token === 'ACCESS.jwt';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            valid,
            user_id: '123',
            username: 'alice',
            is_superuser: false,
            roles: ['main-agent-developer'],
            permissions: ['main.agentflow:read'],
          }),
        );
        return;
      }
      if (url.pathname === '/api/agentflow/list/detail' && req.method === 'GET') {
        if (bearer !== 'ACCESS.jwt') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"detail":"unauthorized"}');
          return;
        }
        const page = Number(url.searchParams.get('page') ?? '1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                id: 42,
                workflow_id: 'wf_abc',
                workflow_name: 'Sales Agent',
                node_count: 7,
                is_shared: false,
                is_deployed: false,
                is_completed: true,
                workflow_type: 'canvas',
                description: 'demo',
                username: 'alice',
                full_name: 'Alice Kim',
                created_at: '2026-06-01T10:00:00',
                updated_at: '2026-06-30T12:00:00',
              },
            ],
            pagination: { page, page_size: 24, total_count: 1, total_pages: 1 },
          }),
        );
        return;
      }
      if (
        url.pathname === '/api/agentflow/geny-workspace/wf_abc/storage/text' &&
        req.method === 'GET'
      ) {
        if (bearer !== 'ACCESS.jwt') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"detail":"unauthorized"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            workflow_id: 'wf_abc',
            path: url.searchParams.get('path'),
            content: 'workspace note',
            encoding: 'utf-8',
          }),
        );
        return;
      }
      if (
        decodeURIComponent(url.pathname) ===
          '/api/agentflow/geny-workspace/wf_abc/storage-raw/workspace/uploads/image 1.png' &&
        req.method === 'GET'
      ) {
        if (bearer !== 'ACCESS.jwt') {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(
          url.searchParams.get('purpose') === 'chat_attachment'
            ? Buffer.from([0x48, 0x49, 0x53, 0x54])
            : Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );
        return;
      }
      if (url.pathname === '/api/agentflow/execute/based-id/stream' && req.method === 'POST') {
        const body = await readBody();
        if (bearer !== 'ACCESS.jwt') {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Echo the input as a couple of text chunks + a tool event + end.
        const input = String(body.input_data ?? '');
        res.write('event: node_status\ndata: {"node_id":"agent","status":"running"}\n\n');
        res.write(
          'event: tool\ndata: {"event_type":"tool_call","tool_name":"echo","tool_input":{"q":"' +
            input +
            '"}}\n\n',
        );
        res.write('data: {"type":"data","content":"You said: "}\n\n');
        res.write('data: {"type":"data","content":"' + input + '"}\n\n');
        res.write('event: execution_io\ndata: {"execution_io_id":99}\n\n');
        res.write('data: {"type":"end"}\n\n');
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"detail":"not found"}');
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('login → list agents → stream chat (e2e against mock)', async () => {
  const { server, baseUrl } = await mockXgen();
  try {
    const xgen = new XgenClient({ baseUrl });

    const login = await xgen.login('me@corp.com', 'pw123');
    assert.equal(login.accessToken, 'ACCESS.jwt');
    assert.equal(xgen.user?.permissions.includes('main.agentflow:read'), true);

    const { items, pagination } = await xgen.agents.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].workflowId, 'wf_abc');
    assert.equal(items[0].isShared, false);
    assert.equal(pagination.totalCount, 1);

    const text = await xgen.agentData.workspaceFile('wf_abc', 'uploads/note.txt');
    assert.equal(text.path, 'workspace/uploads/note.txt');
    assert.equal(text.content, 'workspace note');
    const alreadyPrefixed = await xgen.agentData.workspaceFile(
      'wf_abc',
      'workspace/uploads/note.txt',
    );
    assert.equal(alreadyPrefixed.path, 'workspace/uploads/note.txt');

    const image = await xgen.agentData.workspaceBinary('wf_abc', 'uploads/image 1.png');
    assert.equal(image.contentType, 'image/png');
    assert.deepEqual([...image.bytes], [0x89, 0x50, 0x4e, 0x47]);
    const historyImage = await xgen.agentData.workspaceBinary(
      'wf_abc',
      'uploads/image 1.png',
      'chat_attachment',
    );
    assert.deepEqual([...historyImage.bytes], [0x48, 0x49, 0x53, 0x54]);

    const events: string[] = [];
    const result = await xgen.chat.complete(
      {
        workflowId: items[0].workflowId,
        workflowName: items[0].workflowName,
        input: '안녕하세요',
        interactionId: 'conv-1',
      },
      (e) => events.push(e.kind),
    );
    assert.equal(result.text, 'You said: 안녕하세요');
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].toolName, 'echo');
    assert.equal(result.executionIoId, 99);
    assert.ok(events.includes('node_status'));
    assert.ok(events.includes('end'));
  } finally {
    server.close();
  }
});

test('wrong password rejected', async () => {
  const { server, baseUrl } = await mockXgen();
  try {
    const xgen = new XgenClient({ baseUrl });
    await assert.rejects(() => xgen.login('me@corp.com', 'wrong'));
  } finally {
    server.close();
  }
});

test('onAuthFailure fires on 401 for authed call', async () => {
  const { server, baseUrl } = await mockXgen();
  try {
    let failed = false;
    const xgen = new XgenClient({ baseUrl, onAuthFailure: () => (failed = true) });
    // No token set → list returns 401 → hook fires.
    await assert.rejects(() => xgen.agents.list());
    assert.equal(failed, true);
  } finally {
    server.close();
  }
});
