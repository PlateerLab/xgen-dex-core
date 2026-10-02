/** 시험용 가짜 Anthropic Messages 서버(SSE) — 각본대로 도구 호출·글을 낸다. 요청을 적어 둔다. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = { tool: string; input: Record<string, unknown> } | { text: string };

export async function fakeAnthropic(script: Step[]): Promise<{ url: string; main: any[]; close: () => void }> {
  const main: any[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      if ((req.url ?? '').includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      const isMain = (body.tools ?? []).some((t: any) => String(t.name ?? '').startsWith('mcp__connector__'));
      const step: Step = isMain ? (main.push(body), script.shift() ?? { text: 'done' }) : { text: 'ok' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      if ('tool' in step) {
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${main.length}`, name: step.tool, input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
      } else {
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool' in step ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, main, close: () => server.close() };
}
