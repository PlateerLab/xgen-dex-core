import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { XgenClient } from '@dex/protocol';
// 아티팩트 alias 실행 규칙은 AgentDataApi 안에 있다 — 클라이언트 전체를 세우지 않고
// 그 계층만 직접 세워 본다(index 는 이 둘을 밖으로 내보내지 않는다).
import { AgentDataApi } from '../src/agent-data';
import { HttpClient } from '../src/client';
import { ChatApi } from '../src/chat';

test('trace summaries forward pagination and preserve legacy defaults', async () => {
  const seen: URL[] = [];
  const api = new AgentDataApi(new HttpClient({
    baseUrl: 'https://x.example',
    fetch: async (url: string) => {
      seen.push(new URL(String(url)));
      return new Response('{"traces":[]}', { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  await api.traceList('wf / &?');
  await api.traceList('wf', 2, 20);
  await api.traceList('wf', 1, 5);
  await api.traceList('wf', Number.NaN, Number.POSITIVE_INFINITY);
  await api.traceList('wf', -2, 500);
  assert.equal(seen[0].pathname, '/api/agentflow/trace/list');
  assert.equal(seen[0].searchParams.get('workflow_id'), 'wf / &?');
  assert.deepEqual(seen.map((url) => [url.searchParams.get('page'), url.searchParams.get('page_size')]),
    [['1', '50'], ['2', '20'], ['1', '5'], ['1', '50'], ['1', '50']]);
});

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

// ── 아티팩트 alias 호출 ────────────────────────────────────────────────
//
// 프레임에는 네트워크가 없다. 무엇을 부를지도 프레임이 고르지 못하고 alias 만
// 말할 수 있으며, 그 alias 가 어떤 경로인지는 서버가 검증해 내려준 선언에만 있다.
// 여기서 지키는 것은 그 선언을 **실행하는 쪽**의 규칙이다.

test('선언되지 않은 alias 는 거절한다', async () => {
  const api = new AgentDataApi(new HttpClient({ baseUrl: 'https://x.example' }));
  await assert.rejects(
    () => api.artifactCallApi([{ alias: 'rows', path: '/api/a', method: 'GET' }], 'other'),
    /선언되지 않은 alias/,
  );
});

test('GET 이 아니거나 /api/ 밖이면 거절한다', async () => {
  const api = new AgentDataApi(new HttpClient({ baseUrl: 'https://x.example' }));
  await assert.rejects(
    () =>
      api.artifactCallApi(
        [{ alias: 'w', path: '/api/a', method: 'POST' as 'GET' }],
        'w',
      ),
    /읽기\(GET\)만/,
  );
  await assert.rejects(
    () => api.artifactCallApi([{ alias: 'x', path: '/etc/passwd', method: 'GET' }], 'x'),
    /허용되지 않은 경로/,
  );
});

test('선언된 path 에 이미 쿼리가 있으면 & 로 잇는다', async () => {
  const seen: string[] = [];
  const http = new HttpClient({
    baseUrl: 'https://x.example',
    fetch: async (url: string) => {
      seen.push(String(url));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const api = new AgentDataApi(http);
  await api.artifactCallApi(
    [{ alias: 'a', path: '/api/list?page_size=5', method: 'GET' }],
    'a',
    { limit: 3 },
  );
  // '?' 를 한 번 더 붙이면 주소가 깨지고, 아티팩트는 이유 모를 실패를 본다.
  assert.ok(seen[0].endsWith('/api/list?page_size=5&limit=3'), seen[0]);

  await api.artifactCallApi([{ alias: 'b', path: '/api/list', method: 'GET' }], 'b', { limit: 3 });
  assert.ok(seen[1].endsWith('/api/list?limit=3'), seen[1]);

  // 파라미터가 없으면 물음표도 붙이지 않는다.
  await api.artifactCallApi([{ alias: 'c', path: '/api/list', method: 'GET' }], 'c');
  assert.ok(seen[2].endsWith('/api/list'), seen[2]);
});

// ── 끊김은 종료가 아니다 ───────────────────────────────────────────────
//
// 게이트웨이는 스트리밍 응답을 1시간에 자른다(proxy.rs). 절전·네트워크 전환·
// 프록시도 같은 모양으로 끊는다. 그때 서버의 턴은 **계속 돈다** — 실행은 연결이
// 아니라 대화에 매여 있기 때문이다.
//
// 예전에는 구분할 방법이 없었다: 본문이 그냥 끝나면 `end` 와 똑같이 보였고
// (받다 만 텍스트가 최종 답이 됐다), 예외로 떨어지면 오류로 보였다(멀쩡히 도는
// 턴이 실패로 표시됐다). 2026-09-08 의 76분짜리 턴이 그렇게 사라졌다.

function sseStream(chunks: string[], { cut = false } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (cut) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatApi(res: Response): ChatApi {
  const http = new HttpClient({
    baseUrl: 'https://x.example',
    fetch: async () => res,
  });
  return new ChatApi(http);
}

test('터미널 프레임 없이 본문이 끝나면 분리다 (종료 아님)', async () => {
  const api = chatApi(sseStream(['data: {"type":"data","content":"절반"}\n\n']));
  const seen: string[] = [];
  for await (const e of api.stream({ workflowId: 'w', workflowName: 'n', input: 'hi', interactionId: 'i-1' })) {
    seen.push(e.kind);
  }
  assert.deepEqual(seen, ['text', 'detached'])
})

test('전송이 끊겨도(ERR_INCOMPLETE_CHUNKED_ENCODING) 분리다 — 실패가 아니다', async () => {
  const api = chatApi(sseStream(['data: {"type":"data","content":"절반"}\n\n'], { cut: true }));
  const seen: string[] = [];
  // **던지지 않는 것**이 핵심이다 — 던지면 호출부가 오류로 그리고, 멀쩡히 도는
  // 턴이 실패로 표시된다. (스트림이 error 로 닫히면 큐에 있던 청크는 버려질 수
  // 있으므로 text 가 오는지는 여기서 고정하지 않는다 — 하네스 사정이다.)
  for await (const e of api.stream({ workflowId: 'w', workflowName: 'n', input: 'hi', interactionId: 'i-1' })) {
    seen.push(e.kind);
  }
  assert.equal(seen.at(-1), 'detached', `분리로 끝나야 한다: ${seen.join(',')}`)
  assert.ok(!seen.includes('error'), '끊김을 오류 이벤트로 바꾸면 안 된다')
})

test('end 를 받았으면 분리가 아니다 — 둘이 섞이면 안 된다', async () => {
  const api = chatApi(
    sseStream(['data: {"type":"data","content":"답"}\n\n', 'data: {"type":"end"}\n\n']),
  );
  const seen: string[] = [];
  for await (const e of api.stream({ workflowId: 'w', workflowName: 'n', input: 'hi', interactionId: 'i-1' })) {
    seen.push(e.kind);
  }
  assert.deepEqual(seen, ['text', 'end'])
})

test('complete() 는 분리를 결과에 싣는다 — text 는 답이 아니라 조각이다', async () => {
  const api = chatApi(sseStream(['data: {"type":"data","content":"조각"}\n\n']));
  const out = await api.complete({ workflowId: 'w', workflowName: 'n', input: 'hi', interactionId: 'i-1' });
  assert.equal(out.detached, true);
  assert.equal(out.error, undefined, '끊김은 오류가 아니다');
  assert.equal(out.text, '조각');
})
