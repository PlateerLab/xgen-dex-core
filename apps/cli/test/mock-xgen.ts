import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockXgen {
  server: Server;
  baseUrl: string;
  requests: { chatInputs: unknown[]; chatFolders: unknown[]; createdAgents: unknown[] };
  /** 이 대화들은 "지금 도는 턴이 있다" 고 답한다 — io-logs 의 `running`. */
  running: Set<string>;
  /** POST /execute/stop/{id} 로 실제로 닿은 대화들. */
  stopped: string[];
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

const MODEL_CHOICES = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', name: 'Sonnet 4.5', label: 'Anthropic: Sonnet 4.5', group: 'Anthropic' },
  { provider: 'anthropic', model: 'claude-haiku-4-5', name: 'Haiku 4.5', label: 'Anthropic: Haiku 4.5', group: 'Anthropic' },
  { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI' },
];

export async function startMockXgen(): Promise<MockXgen> {
  const passwordHash = createHash('sha256').update('pw123').digest('hex');
  const requests = {
    chatInputs: [] as unknown[],
    // 요청의 local_folders — 필드가 없으면 undefined 로 남겨 "보내지 않음"과 구분한다.
    chatFolders: [] as unknown[],
    createdAgents: [] as unknown[],
  };
  const running = new Set<string>();
  const stopped: string[] = [];
  const conversationModels = new Map<string, (typeof MODEL_CHOICES)[number]>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock');
      const bearer = String(request.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      // 에이전트 만들기 — 이름·모델만으로 Geny 노드 하나짜리 워크플로우.
      if (url.pathname === '/api/agentflow/create/options' && request.method === 'GET') {
        json(response, 200, {
          providers: [
            {
              value: 'openai',
              label: 'OpenAI',
              models: [
                { value: 'gpt-4o', label: 'GPT-4o' },
                { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
              ],
              default_model: 'gpt-4o-mini',
            },
            {
              value: 'anthropic',
              label: 'Anthropic',
              models: [{ value: 'claude-sonnet-4', label: 'Claude Sonnet 4' }],
              default_model: 'claude-sonnet-4',
            },
          ],
          default_provider: 'openai',
          settings: [
            {
              id: 'tool_exposure',
              label: '도구 노출 방식',
              type: 'STR',
              default: 'hierarchy',
              options: [
                { value: 'hierarchy', label: '계층형 (기본 도구는 보이고 나머지는 필요할 때)' },
                { value: 'flat', label: '평면형 (전부 선노출)' },
              ],
            },
            { id: 'enable_self_evolution', label: '자기진화 (워크플로 편집)', type: 'BOOL', default: true },
            { id: 'temperature', label: '창의성', type: 'FLOAT', default: 0.7 },
          ],
          defaults: { tool_exposure: 'hierarchy', enable_self_evolution: true },
        });
        return;
      }
      if (url.pathname === '/api/agentflow/create' && request.method === 'POST') {
        const body = await bodyOf(request);
        requests.createdAgents.push(body);
        json(response, 200, {
          workflow_id: 'wf_created_1',
          workflow_name: String(body.workflow_name ?? ''),
        });
        return;
      }
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
        requests.chatFolders.push(body.local_folders);
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
      // 사람이 누른 [정지] 가 닿는 자리 — 실행은 연결이 아니라 대화에 매여 있다.
      if (url.pathname.startsWith('/api/agentflow/execute/stop/') && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.slice('/api/agentflow/execute/stop/'.length));
        stopped.push(id);
        running.delete(id);
        json(response, 200, { stopped: true, interaction_id: id });
        return;
      }
      // 대화의 모델 — 서버가 이름("제공자: 모델")과 순서(지금 모델이 맨 앞)를 정한다.
      const modelPath = /^\/api\/agentflow\/conversations\/([^/]+)\/model$/.exec(url.pathname);
      if (modelPath) {
        const id = decodeURIComponent(modelPath[1]!);
        if (request.method === 'PUT') {
          const body = await bodyOf(request);
          const picked = MODEL_CHOICES.find((c) => c.provider === body.provider && c.model === body.model);
          if (!picked) return json(response, 400, { detail: '고를 수 없는 모델입니다' });
          conversationModels.set(id, picked);
        } else if (request.method === 'DELETE') {
          conversationModels.delete(id);
        }
        const current = conversationModels.get(id) ?? MODEL_CHOICES[0]!;
        json(response, 200, {
          supported: true,
          locked: false,
          current: { ...current, source: conversationModels.has(id) ? 'conversation' : 'agent' },
          agent: { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Anthropic: Sonnet 4.5' },
          choices: [current, ...MODEL_CHOICES.filter((c) => c !== current)],
        });
        return;
      }
      if (url.pathname === '/api/chat/io-logs' && request.method === 'GET') {
        json(response, 200, {
          // 이 대화에 지금 도는 턴이 있는가 — 기기를 옮겨 들어온 클라이언트가
          // [진행 중] 을 복원하는 근거.
          running: running.has(String(url.searchParams.get('interaction_id'))),
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
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests, running, stopped };
}
