import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type AudioSettings = { noise: boolean; vad: boolean };
export type ProcessedAudio = {
  pcm: Uint8Array;
  inSpeech: boolean;
  events: Array<{ type: 'speech_start' | 'speech_end'; offset_bytes: number }>;
};
export type AudioRuntime = { python: string; library: string };

export function audioRuntime(appPath: string, resourcesPath: string): AudioRuntime {
  const root =
    process.env.DEX_AUDIO_ROOT ||
    [
      join(resourcesPath, 'audio-preprocessing'),
      resolve(appPath, '../../../xgen-audio-preprecessing'),
    ].find((p) => existsSync(join(p, 'python')) || existsSync(join(p, '.venv'))) ||
    join(resourcesPath, 'audio-preprocessing');
  const python =
    process.env.DEX_AUDIO_PYTHON ||
    (existsSync(join(root, 'python/bin/python3.11'))
      ? join(root, 'python/bin/python3.11')
      : join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  const library =
    process.env.XGEN_RNNOISE_LIBRARY ||
    join(
      root,
      existsSync(join(root, 'lib')) ? 'lib' : '.local/rnnoise',
      process.platform === 'darwin'
        ? 'librnnoise.dylib'
        : process.platform === 'win32'
          ? 'rnnoise.dll'
          : 'librnnoise.so',
    );
  return { python, library };
}

/** One worker per capture, serial replies and a bounded queue (4 seconds of PCM). */
export class AudioProcessor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: {
    resolve: (reply: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  private failure: Error | null = null;
  private ending = false;
  private text = '';
  private stderr = '';
  private exited: Promise<void> = Promise.resolve();
  private finishResult: Promise<ProcessedAudio> | null = null;

  constructor(
    readonly settings: AudioSettings,
    private runtime: AudioRuntime,
  ) {}

  async open(): Promise<void> {
    if (!this.settings.noise && !this.settings.vad) return;
    if (
      !existsSync(this.runtime.python) ||
      (this.settings.noise && !existsSync(this.runtime.library))
    ) {
      throw new Error(
        '음성 전처리 실행 파일이 없습니다. 전처리 설치를 확인하거나 두 설정을 꺼 주세요.',
      );
    }
    const ready = this.waitReply();
    const args = [
      '-I',
      '-B',
      '-m',
      'xgen_audio.cli',
      '--jsonl',
      '--denoise',
      this.settings.noise ? 'rnnoise' : 'none',
    ];
    if (!this.settings.vad) args.push('--no-vad');
    const child = (this.child = spawn(this.runtime.python, args, {
      cwd: dirname(this.runtime.python),
      stdio: 'pipe',
      env: { ...process.env, PYTHONUNBUFFERED: '1', XGEN_RNNOISE_LIBRARY: this.runtime.library },
    }));
    this.exited = new Promise((resolveExit) =>
      child.once('close', (code) => {
        if (!this.ending || this.pending || code !== 0)
          this.fail(new Error(`음성 전처리가 종료됐습니다 (${code}). ${this.stderr.slice(-400)}`));
        resolveExit();
      }),
    );
    child.on('error', (e) => this.fail(e));
    child.stdin.on('error', (e) => this.fail(e));
    child.stderr.on('data', (b) => {
      this.stderr = (this.stderr + b.toString()).slice(-4096);
    });
    child.stdout.on('data', (b) => {
      this.text += b.toString();
      if (this.text.length > 200000) return this.fail(new Error('음성 전처리 응답이 너무 큽니다.'));
      let newline: number;
      while ((newline = this.text.indexOf('\n')) >= 0) {
        const line = this.text.slice(0, newline);
        this.text = this.text.slice(newline + 1);
        try {
          const reply = JSON.parse(line);
          if (!this.pending) throw new Error('Unexpected audio reply');
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(reply);
        } catch {
          this.fail(new Error('음성 전처리 응답이 올바르지 않습니다.'));
        }
      }
    });
    const reply = await ready;
    if (reply.type !== 'ready') {
      this.cancel();
      throw new Error('음성 전처리를 준비하지 못했습니다.');
    }
  }

  private waitReply(): Promise<any> {
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error('음성 전처리 응답 시간이 초과됐습니다.')),
        10000,
      );
      this.pending = { resolve: resolveReply, reject, timer };
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = null;
    }
    this.child?.kill();
  }

  private async request(type: 'push' | 'finish', pcm?: Uint8Array): Promise<ProcessedAudio> {
    if (this.failure) throw this.failure;
    if (!this.child) return { pcm: pcm ?? new Uint8Array(), inSpeech: false, events: [] };
    const response = this.waitReply();
    this.child.stdin.write(
      JSON.stringify({ type, ...(pcm ? { pcm: Buffer.from(pcm).toString('base64') } : {}) }) + '\n',
    );
    const reply = await response;
    if (
      reply.type !== 'audio' ||
      typeof reply.pcm !== 'string' ||
      typeof reply.inSpeech !== 'boolean' ||
      !Array.isArray(reply.events)
    ) {
      this.fail(new Error('음성 전처리 응답 형식이 올바르지 않습니다.'));
      throw this.failure;
    }
    return {
      pcm: Buffer.from(reply.pcm, 'base64'),
      inSpeech: reply.inSpeech,
      events: reply.events,
    };
  }

  push(pcm: Uint8Array): Promise<ProcessedAudio> {
    if (this.ending || this.failure)
      return Promise.reject(this.failure ?? new Error('음성 전처리가 닫혔습니다.'));
    if (!(pcm instanceof Uint8Array) || pcm.byteLength > 64000 || pcm.byteLength % 2)
      return Promise.reject(new Error('16kHz PCM16 음성 조각이 올바르지 않습니다.'));
    if (this.queuedBytes + pcm.byteLength > 128000) {
      this.fail(new Error('음성 전처리가 입력 속도를 따라가지 못합니다.'));
      return Promise.reject(this.failure);
    }
    const copy = Uint8Array.from(pcm);
    this.queuedBytes += copy.byteLength;
    const next = this.chain
      .then(() => this.request('push', copy))
      .finally(() => {
        this.queuedBytes -= copy.byteLength;
      });
    this.chain = next.catch(() => undefined);
    return next;
  }

  finish(): Promise<ProcessedAudio> {
    if (this.finishResult) return this.finishResult;
    this.ending = true;
    return (this.finishResult = this.chain.then(async () => {
      const tail = await this.request('finish');
      this.child?.stdin.end();
      const timer = setTimeout(
        () => this.fail(new Error('음성 전처리를 종료하지 못했습니다.')),
        10000,
      );
      try {
        await this.exited;
        if (this.failure) throw this.failure;
        return tail;
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  cancel(): void {
    this.ending = true;
    this.fail(new Error('음성 전처리를 취소했습니다.'));
  }
}
