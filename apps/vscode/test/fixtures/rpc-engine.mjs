import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: 1,
        server: { name: 'fixture-dex-cli', version: '0.1.0' },
        capabilities: {
          profiles: true,
          authentication: ['password'],
          agents: true,
          chatStreaming: true,
          chatCancellation: true,
          history: true,
          localTools: true,
        },
      },
    });
    return;
  }
  if (request.method === 'echo') {
    write({ jsonrpc: '2.0', id: request.id, result: request.params });
    write({ jsonrpc: '2.0', method: 'fixture/event', params: { ok: true } });
    return;
  }
  if (request.method === 'fail') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: 'fixture failed', data: { code: 'network_error' } },
    });
    return;
  }
  if (request.method === 'health') {
    write({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    return;
  }
  if (request.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: request.id, result: null });
    lines.close();
  }
});
