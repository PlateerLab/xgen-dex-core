/**
 * useHandsfree — 아바타 오버레이의 핸즈프리 음성 대화 엔진 (Geny 접속기 방식).
 *
 * 켜면 마이크를 계속 열어 두고 WebAudio RMS 기반 VAD 로 발화를 감지한다:
 *   말 시작(임계 초과 ~150ms) → MediaRecorder 캡처 시작(프리롤 포함)
 *   말 끝(임계 미만 ~900ms)   → 캡처 종료 → STT(/api/audio/stt/transcribe,
 *   서버가 사용자 STT 설정으로 해석) → 텍스트를 활성 에이전트 채팅으로 자동
 *   전송(quickChat.submit 릴레이 — 메인 창이 최소화/숨김이어도 동작).
 *
 * 응답은 메인 창 채팅의 자동 TTS 가 소리로 읽어 주므로(음성 출력 켠 경우),
 * 이 훅 하나로 "말하면 → 듣고 → 대답이 들리는" 완전한 음성 대화 루프가 된다.
 *
 * 상태: idle(꺼짐) / armed(대기) / hearing(듣는 중) / thinking(전사/전송 중).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';

export type HandsfreeState = 'idle' | 'armed' | 'hearing' | 'thinking';

// VAD 파라미터 — Geny 의 체감(즉답성 vs 오탐)을 따른 보수적 기본값.
const RMS_THRESHOLD = 0.015; // 무음 바닥 대비 발화 판정 임계
const START_MS = 150; // 이 시간 이상 임계 초과 → 발화 시작
const END_MS = 900; // 이 시간 이상 임계 미만 → 발화 종료
const MIN_UTTERANCE_MS = 400; // 너무 짧은 캡처(잡음 클릭)는 버림
const MAX_UTTERANCE_MS = 30_000; // 폭주 방지 상한

export function useHandsfree(enabled: boolean): { state: HandsfreeState } {
  const [state, setState] = useState<HandsfreeState>('idle');
  const stateRef = useRef<HandsfreeState>('idle');
  const set = useCallback((s: HandsfreeState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  useEffect(() => {
    if (!enabled) {
      set('idle');
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let raf = 0;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let aboveSince = 0;
    let belowSince = 0;
    let utteranceStart = 0;

    const stopRecorder = () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorder = null;
    };

    const finishUtterance = async () => {
      // onstop 에서 blob 완성/전사 처리 — 여기서는 캡처만 종료한다.
      stopRecorder();
    };

    const startRecorder = () => {
      if (!stream) return;
      chunks = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      mr.onstop = async () => {
        const dur = Date.now() - utteranceStart;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        chunks = [];
        if (!alive) return;
        if (dur < MIN_UTTERANCE_MS || !blob.size) {
          set('armed');
          return;
        }
        set('thinking');
        try {
          const text = (await xgen.voice.transcribe(blob)).trim();
          if (alive && text) {
            // 활성 에이전트 채팅으로 자동 전송 (퀵챗 릴레이 — 창 상태 불간섭)
            await xgen.quickChat.submit(text);
          }
        } catch {
          /* 전사 실패 — 다음 발화 대기 */
        }
        if (alive) set('armed');
      };
      mr.start();
      recorder = mr;
      utteranceStart = Date.now();
    };

    const tick = () => {
      if (!alive || !analyser) return;
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      const s = stateRef.current;

      if (s === 'armed') {
        if (rms >= RMS_THRESHOLD) {
          if (!aboveSince) aboveSince = now;
          if (now - aboveSince >= START_MS) {
            aboveSince = 0;
            belowSince = 0;
            set('hearing');
            startRecorder();
          }
        } else {
          aboveSince = 0;
        }
      } else if (s === 'hearing') {
        if (rms < RMS_THRESHOLD) {
          if (!belowSince) belowSince = now;
          if (now - belowSince >= END_MS) {
            belowSince = 0;
            void finishUtterance();
          }
        } else {
          belowSince = 0;
        }
        if (now - utteranceStart >= MAX_UTTERANCE_MS) void finishUtterance();
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        set('armed');
        raf = requestAnimationFrame(tick);
      } catch {
        // 마이크 권한 거부/장치 없음 — idle 유지 (버튼 상태로 표시)
        set('idle');
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stopRecorder();
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      set('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { state };
}
