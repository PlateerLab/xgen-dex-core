import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockXgen {
  server: Server;
  baseUrl: string;
  requests: { chatInputs: unknown[] };
}

async function bodyOf(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

function json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function startMockXgen(): Promise<MockXgen> {
  const passwordHash = createHash('sha256').update('pw123').digest('hex');
  const requests = { chatInputs: [] as unknown[] };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock');
      const bearer = String(request.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const body = await bodyOf(request);
        if (body.email !== 'me@corp.com' || body.password !== passwordHash) {
          json(response, 401, { success: false, access_token: null, message: 'bad credentials' });
          return;
        }
        json(response, 200, {
          success: true,
          access_token: 'ACCESS.jwt',
          refresh_token: 'REFRESH.jwt',
          user_id: '123',
          username: 'alice',
        });
        return;
      }
      if (url.pathname === '/api/auth/validate-token' && request.method === 'POST') {
        const body = await bodyOf(request);
        const valid = body.token === 'ACCESS.jwt' || body.token === 'ACCESS2.jwt';
        json(response, 200, {
          valid,
          user_id: '123',
          username: 'alice',
          roles: ['developer'],
          permissions: ['main.agentflow:read'],
        });
        return;
      }
      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        const body = await bodyOf(request);
        json(response, 200, {
          success: body.refresh_token === 'REFRESH.jwt',
          access_token: body.refresh_token === 'REFRESH.jwt' ? 'ACCESS2.jwt' : null,
        });
        return;
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        json(response, 200, { success: true });
        return;
      }
      if (bearer !== 'ACCESS.jwt' && bearer !== 'ACCESS2.jwt') {
        json(response, 401, { detail: 'unauthorized' });
        return;
      }
      if (url.pathname === '/api/agentflow/list/detail' && request.method === 'GET') {
        json(response, 200, {
          items: [
            {
              id: 42,
              workflow_id: 'wf_abc',
              workflow_name: 'Sales Agent',
              node_count: 7,
              workflow_type: 'canvas',
              description: 'demo',
              username: 'alice',
              full_name: 'Alice',
            },
          ],
          pagination: { page: 1, page_size: 24, total_count: 1, total_pages: 1 },
        });
        return;
      }
      if (url.pathname === '/api/agentflow/execute/based-id/stream' && request.method === 'POST') {
        const body = await bodyOf(request);
        requests.chatInputs.push(body.input_data);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: tool\ndata: {"event_type":"tool_call","tool_name":"echo"}\n\n');
        response.write('data: {"type":"data","content":"You said: "}\n\n');
        response.write(`data: ${JSON.stringify({ type: 'data', content: String(body.input_data) })}\n\n`);
        response.end('data: {"type":"end"}\n\n');
        return;
      }
      if (url.pathname === '/api/interaction/list' && request.method === 'GET') {
        json(response, 200, {
          execution_meta_list: [
            {
              id: 1,
              interaction_id: 'interaction-1',
              workflow_id: 'wf_abc',
              workflow_name: 'Sales Agent',
              interaction_count: 1,
              updated_at: '2026-08-28T00:00:00Z',
            },
          ],
        });
        return;
      }
      if (url.pathname === '/api/chat/io-logs' && request.method === 'GET') {
        json(response, 200, {
          in_out_logs: [
            {
              log_id: 1,
              io_id: 2,
              interaction_id: url.searchParams.get('interaction_id'),
              workflow_id: url.searchParams.get('workflow_id'),
              workflow_name: 'Sales Agent',
              input_data: 'hello',
              output_data: 'world',
              updated_at: '2026-08-28T00:00:00Z',
            },
          ],
        });
        return;
      }
      json(response, 404, { detail: 'not found' });
    })().catch((error: unknown) => {
      json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}
