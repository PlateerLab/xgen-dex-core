import { xgen } from '../bridge';
import { startPcmCapture, type PcmCapture } from './pcm-capture';
import type { ProcessedAudio } from '../../../main/audio-preprocessor';

export type ProcessedCapture = { stop: () => Promise<void>; cancel: () => void };
export type CaptureChunk = ProcessedAudio & { vad: boolean };

/** Keep one processor alive for the entire microphone capture, including pre-roll. */
export async function startProcessedCapture(
  onChunk: (chunk: CaptureChunk) => void,
  onError: (error: Error) => void,
  isPaused: () => boolean = () => false,
): Promise<ProcessedCapture> {
  const session = await xgen.audioProcessor.start();
  let capture: PcmCapture | null = null;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let cancelled = false;
  let stopped = false;
  let finishing: Promise<void> | null = null;
  const cancel = (): void => {
    cancelled = true;
    stopped = true;
    capture?.stop();
    xgen.audioProcessor.cancel(session.id);
  };
  const fail = (cause: unknown): void => {
    if (cancelled) return;
    cancel();
    onError(cause instanceof Error ? cause : new Error(String(cause)));
  };
  try {
    capture = await startPcmCapture((raw) => {
      if (stopped) return;
      if (queued + raw.length > 128000) {
        fail(new Error('음성 처리 속도가 느립니다. 마이크를 다시 켜 주세요.'));
        return;
      }
      const pcm = isPaused() ? new Uint8Array(raw.length) : raw;
      queued += pcm.length;
      chain = chain
        .then(async () => {
          if (cancelled) return;
          const result = await xgen.audioProcessor.push(session.id, pcm);
          if (!cancelled) onChunk({ ...result, vad: session.vad });
        })
        .catch(fail)
        .finally(() => {
          queued -= pcm.length;
        });
    });
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    cancel,
    stop: () => {
      if (finishing) return finishing;
      stopped = true;
      capture?.stop();
      return (finishing = chain.then(async () => {
        if (cancelled) throw new Error('음성 캡처가 취소됐습니다.');
        try {
          const result = await xgen.audioProcessor.finish(session.id);
          if (!cancelled) onChunk({ ...result, vad: session.vad });
        } catch (error) {
          fail(error);
          throw error;
        }
      }));
    },
  };
}

/** PCM data only, no re-encoding; every final partial chunk is included. */
export function pcmWav(chunks: Uint8Array[]): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new Blob([out], { type: 'audio/wav' });
}
