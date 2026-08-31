import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

export async function promptLine(label: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stderr });
  try {
    return await readline.question(label);
  } finally {
    readline.close();
  }
}

export async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return readStdin();
  stderr.write(label);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          reject(Object.assign(new Error('입력이 취소되었습니다.'), { name: 'AbortError' }));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
