/**
 * 마이크 → PCM16 16 kHz 모노 조각 — 실시간 음성 인식(main 의 voice-stream)으로 보낼 소리.
 *
 * AudioContext 를 16 kHz 로 열어 리샘플은 브라우저에 맡기고, ScriptProcessor 로 64 ms 씩 받아
 * Int16 으로 바꾼다. 발화 감지와 소음 제거는 공통 Python 처리 경로가 담당한다.
 * (AudioWorklet 은 별도 모듈 파일이 필요해 실험 단계에서는 ScriptProcessor 로 둔다.)
 */
export type PcmCapture = { stop: () => void };

export async function startPcmCapture(onChunk: (pcm: Uint8Array) => void): Promise<PcmCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, channelCount: 1 },
  });
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    proc.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0);
      const out = new Int16Array(f.length);
      for (let i = 0; i < f.length; i += 1) {
        const v = Math.max(-1, Math.min(1, f[i]));
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      onChunk(new Uint8Array(out.buffer));
    };
    src.connect(proc);
    proc.connect(ctx.destination); // ScriptProcessor 는 출력에 이어야 돈다 (내보내는 소리는 0)
    return {
      stop: () => {
        proc.onaudioprocess = null;
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    throw error;
  }
}
