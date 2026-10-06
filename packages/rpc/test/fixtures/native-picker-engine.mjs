import { createInterface } from 'node:readline';
import { basename } from 'node:path';

// Transport fixture only. Native authentication and filesystem reads are covered by server tests.
const pending = new Map(); let next = 0;
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const cancel = () => {
  for (const [id, request] of pending) {
    send({ method: 'host/cancel-native-attachments', params: { id } });
    send({ id: request, error: { code: -32000, message: 'Cancelled' } });
  }
  pending.clear();
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (pending.has(frame.id) && !frame.method) {
    const request = pending.get(frame.id); pending.delete(frame.id);
    if (frame.error) send({ id: request, error: { code: -32000, message: 'Selection unavailable' } });
    else send({ id: request, result: { filenames: frame.result.paths.map((path) => basename(path)) } });
    return;
  }
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { protocolVersion: 1, server: { name: 'picker-transport-fixture', version: 'test' },
      capabilities: { nativePlatformSession: { platform: 'vscode', storage: 'os-keychain-software',
        ...(frame.params?.client?.capabilities?.nativeAttachmentPicker === true ? { canonicalAttachments: true } : {}) } } } });
  } else if (frame.method === 'native/pick-attachments') {
    const id = `native-picker:00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
    pending.set(id, frame.id); send({ id, method: 'host/pick-native-attachments', params: { max_files: 2, max_bytes: 8 } });
  } else if (frame.method === 'native/cancel') { cancel(); send({ id: frame.id, result: { watching: false } }); }
  else if (frame.method === 'shutdown') { cancel(); send({ id: frame.id, result: null }); process.exit(0); }
  else send({ id: frame.id, result: { ok: true } });
});
