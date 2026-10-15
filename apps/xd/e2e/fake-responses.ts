/** 시험용 가짜 OpenAI Responses 서버(SSE, codex 용) — 각본대로 도구 호출(mcp__connector 네임스페이스)·글을 낸다. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Step } from './fake-anthropic';

export async function fakeResponses(script: Step[]): Promise<{ url: string; main: any[]; close: () => void }> {
  const main: any[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || '{}');
      main.push(body);
      const step: Step = script.shift() ?? { text: 'done' };
      const n = main.length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (data: { type: string } & Record<string, unknown>) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      const rid = `resp_${n}`;
      ev({ type: 'response.created', response: { id: rid } });
      const item =
        'tool' in step
          ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: step.tool, arguments: JSON.stringify(step.input), status: 'completed', namespace: 'mcp__connector' }
          : { type: 'message', role: 'assistant', id: `msg_${n}`, status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
      ev({ type: 'response.output_item.added', output_index: 0, item });
      ev({ type: 'response.output_item.done', output_index: 0, item });
      ev({
        type: 'response.completed',
        response: { id: rid, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
      });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, main, close: () => server.close() };
}
