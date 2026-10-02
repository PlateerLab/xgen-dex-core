// 시험용 가짜 엔진 — 프로토콜 v1 의 겉모양만. 글이 "crash" 면 턴 도중에 죽고, "slow" 면 취소를 기다린다.
import { createInterface } from 'node:readline';

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const protocol = Number(process.env.FAKE_PROTOCOL || 1);
process.stderr.write('fake engine 시작 — 로그는 UTF-8\n');
out({ type: 'ready', protocol, runtime: 'fake', python: '0', platform: process.platform, root: process.argv[2] || '' });

const running = new Map();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'configure') out({ type: 'configured', dangerous: (cmd.dangerous || []).length });
  else if (cmd.type === 'turn') {
    out({ type: 'started', id: cmd.id });
    if (cmd.text === 'crash') {
      out({ type: 'chunk', id: cmd.id, text: 'about to crash' });
      setTimeout(() => process.exit(3), 20);
      return;
    }
    if (cmd.text === 'slow') {
      running.set(cmd.id, setTimeout(() => out({ type: 'done', id: cmd.id }), 60_000));
      return;
    }
    out({ type: 'chunk', id: cmd.id, text: `echo: ${cmd.text} (history ${cmd.history ? cmd.history.length : 0})` });
    out({ type: 'usage', id: cmd.id, usage: { input_tokens: 1, output_tokens: 2 } });
    out({ type: 'done', id: cmd.id });
  } else if (cmd.type === 'cancel') {
    clearTimeout(running.get(cmd.id));
    running.delete(cmd.id);
    out({ type: 'cancelled', id: cmd.id });
  } else if (cmd.type === 'shutdown') {
    for (const [id, t] of running) {
      clearTimeout(t);
      out({ type: 'cancelled', id });
    }
    process.exit(0);
  }
});
rl.on('close', () => process.exit(0));
