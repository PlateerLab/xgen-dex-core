/** Cross-language wire test against the disposable production Python/Redis fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { connectNativeCapabilityBridge, type NativeCapabilityController } from '@dex/engine/native-capability-bridge';

const children = new Set<ReturnType<typeof spawn>>();
const proxy = createServer((stream) => {
  const child = spawn('docker', ['exec', '-i', 'full-stack-xgen-workflow-1', 'python', '-u', '-c',
    `import socket,sys,threading
s=socket.create_connection(('127.0.0.1',61989),timeout=5);s.settimeout(None)
def upload():
 try:
  while True:
   data=sys.stdin.buffer.read1(65536)
   if not data:break
   s.sendall(data)
 finally:
  try:s.shutdown(socket.SHUT_WR)
  except OSError:pass
threading.Thread(target=upload,daemon=True).start()
while True:
 data=s.recv(65536)
 if not data:break
 sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
s.close()`], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); stream.pipe(child.stdin); child.stdout.pipe(stream);
  child.stderr.resume(); child.on('exit', () => { children.delete(child); stream.destroy(); });
  child.stdin.on('error', () => {}); stream.on('error', () => child.kill());
  stream.on('close', () => { child.stdin.end(); child.kill(); });
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address(); assert.ok(address && typeof address !== 'string');
const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/agentflow/capabilities/connector`, {
  headers: { 'x-platform-capability-connection': 'A'.repeat(43) }, maxPayload: 1024 * 1024,
});
const frames: unknown[] = []; let pending: { resolve(v: unknown): void; reject(e: unknown): void } | null = null;
ws.on('message', (raw) => { const value = JSON.parse(raw.toString()); if (pending) { const next = pending; pending = null; next.resolve(value); } else frames.push(value); });
ws.on('close', () => { pending?.reject(new Error('wire closed')); pending = null; });
ws.on('error', () => { pending?.reject(new Error('wire error')); pending = null; });
let controller: NativeCapabilityController | undefined;
const deadline = setTimeout(() => { ws.terminate(); }, 20000);
try {
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let confirmations = 0; let effects = 0;
  controller = await connectNativeCapabilityBridge({ get closed() { return ws.readyState === WebSocket.CLOSED; },
    next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve, reject) => { pending = { resolve, reject }; }),
    send: (value) => new Promise<void>((resolve, reject) => ws.send(JSON.stringify(value), (error) => error ? reject(error) : resolve())),
    close: () => new Promise<void>((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else { ws.once('close', resolve); ws.close(); } }),
  }, {
    tools: [{ server: 'local', name: 'Echo', description: 'Wire fixture echo', inputSchema: { type: 'object' } }],
    call: async (_server, _tool, args, signal) => { signal.throwIfAborted(); effects++; assert.equal(args.text, '한글'); return { echoed: args }; },
    onChange: (snapshot) => {
      if (snapshot.state === 'confirmation_required' && snapshot.confirmation) {
        confirmations++;
        assert.equal(snapshot.confirmation.args.number, 1);
        assert.equal(Object.is(snapshot.confirmation.args.negative_zero, -0), true);
        // This explicit fixture decision is for the harmless synthetic Echo tool only.
        void controller!.confirm(snapshot.confirmation.requestId, true);
      }
    },
  }, { accessExpiresAt: Date.now() / 1000 + 180, assertCurrent: async () => {} });
  const invoke = spawn('docker', ['exec', 'full-stack-xgen-workflow-1', 'python', '-c',
    `import urllib.request,sys
r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:61989/fixture/invoke',method='POST'),timeout=15)
sys.stdout.buffer.write(r.read())`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; invoke.stdout.on('data', (chunk) => { output += chunk; }); invoke.stderr.on('data', (chunk) => { errors += chunk; });
  const code = await new Promise<number | null>((resolve) => invoke.on('exit', resolve));
  assert.equal(code, 0, errors); const result = JSON.parse(output);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(confirmations, 1); assert.equal(effects, 1);
  process.stdout.write('Production Python socket/Redis authority ↔ native TypeScript bridge passed: one explicit Echo confirmation/effect; whole float, negative zero, small exponent, Korean exact-byte hash.\n');
} finally {
  clearTimeout(deadline); await controller?.close(); ws.terminate();
  for (const child of children) child.kill(); proxy.close();
}
