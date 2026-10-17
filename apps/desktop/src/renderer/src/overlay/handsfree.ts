/**
 * useHandsfree — 아바타 오버레이의 핸즈프리 음성 대화 엔진 (Geny 접속기 방식).
 *
 * 일반 핸즈프리는 마이크를 계속 열어 두고 처리된 PCM에서 발화를 감지한다:
 *   Silero OFF: 기존 RMS 기준으로 말 시작(임계 초과 ~150ms), 말 끝(임계 미만 ~900ms) 감지.
 *   Silero ON: 모델의 발화 상태로 시작·끝 감지.
 *   발화별 WAV(프리롤 포함) → STT(/api/audio/stt/transcribe,
 *   서버가 사용자 STT 설정으로 해석) → 텍스트를 활성 에이전트 채팅으로 자동
 *   전송(quickChat.submit 릴레이 — 메인 창이 최소화/숨김이어도 동작).
 *
 * 응답은 메인 창 채팅의 자동 TTS가 읽어 준다(음성 출력 켠 경우).
 * 빠른 브라우저 조작을 켰을 때의 기존 실시간 분기는 유지한다.
 * 상태: idle(꺼짐) / armed(대기) / hearing(듣는 중) / thinking(전사/전송 중).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { useVoiceLoop, useVoiceStreamAvailable } from '../voice/voice-loop';
import { startProcessedCapture, pcmWav, type ProcessedCapture } from '../voice/processed-capture';

export type HandsfreeState = 'idle' | 'armed' | 'hearing' | 'thinking';

// 기존 RMS 기본값을 유지한다. RNNoise 적용 후 감도는 현장 마이크에서 재검증해야 한다.
const RMS_THRESHOLD = 0.015; // 무음 바닥 대비 발화 판정 임계
const START_MS = 150; // 이 시간 이상 임계 초과 → 발화 시작
const END_MS = 900; // 이 시간 이상 임계 미만 → 발화 종료
const MIN_UTTERANCE_MS = 400; // 감지 확정 후 경과 시간 기준이며 실제 발성 길이는 아니다.
const MAX_UTTERANCE_MS = 30_000; // 폭주 방지 상한
// shortcut: 감지 확정 전 PCM을 최대 1.2초 보관한다. 현장 발화 누락·지연 검증 후 조정한다.
const PREROLL_BYTES = 32000 * 1.2;

export function useHandsfree(
  enabled: boolean,
  workflowId?: string,
): { state: HandsfreeState; error: string | null } {
  const [state, setState] = useState<HandsfreeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<HandsfreeState>('idle');
  const set = useCallback((s: HandsfreeState) => {
    stateRef.current = s;
    setState(s);
  }, []);
  const streamAvail = useVoiceStreamAvailable();
  const streaming = enabled && streamAvail && !!workflowId;
  // 기존 실시간 분기. 현재 main은 최종 발화 이후의 채팅 계획까지 조작을 보류한다.
  const loop = useVoiceLoop({
    enabled: streaming,
    workflowId,
    onResult: async (r) => {
      const short = r.text.replace(/[\s.,!?。…]/g, '').length <= 2; // 말버릇·잡음
      // 화면 조작으로 끝난 말은 채팅으로 보내지 않고, 질문·여러 단계·못 한 말만 채팅으로 보낸다.
      if (r.text && !short && !(r.actions.length && !r.unhandled))
        await xgen.quickChat.submit(r.text, { voice: true });
    },
  });

  useEffect(() => {
    if (!enabled || (streamAvail && workflowId)) {
      if (!enabled) set('idle');
      return;
    }
    let alive = true;
    let capture: ProcessedCapture | null = null;
    let chunks: Uint8Array[] = [];
    let preroll: Uint8Array[] = [];
    let prerollBytes = 0;
    let aboveSince = 0;
    let belowSince = 0;
    let utteranceStart = 0;
    setError(null);

    const finishUtterance = async () => {
      const dur = Date.now() - utteranceStart;
      const blob = pcmWav(chunks);
      chunks = [];
      if (dur < MIN_UTTERANCE_MS || blob.size <= 44) {
        set('armed');
        return;
      }
      set('thinking');
      try {
        const text = (await xgen.voice.transcribe(blob)).trim();
        // 활성 에이전트 채팅으로 자동 전송 (퀵챗 릴레이 — 창 상태 불간섭)
        if (alive && text) await xgen.quickChat.submit(text);
      } catch (cause) {
        // 전사 실패는 표시하고 다음 발화를 기다린다.
        if (alive) setError(String(cause));
      }
      if (alive) set('armed');
    };

    void startProcessedCapture(
      ({ pcm, vad, inSpeech, events }) => {
        if (!alive || !pcm.length || stateRef.current === 'thinking') return;
        const now = Date.now();
        // RMS도 서버에 보낼 처리된 PCM에서 계산한다. Silero OFF는 자동 감지 OFF가 아니다.
        let sum = 0;
        if (!vad) {
          const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          for (let i = 0; i < pcm.length; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2;
        }
        const loud = vad
          ? inSpeech || events.some((e) => e.type === 'speech_start')
          : Math.sqrt(sum / (pcm.length / 2)) >= RMS_THRESHOLD;
        if (stateRef.current === 'armed') {
          preroll.push(pcm);
          prerollBytes += pcm.length;
          while (prerollBytes > PREROLL_BYTES && preroll.length > 1)
            prerollBytes -= preroll.shift()!.length;
          if (loud) {
            if (!aboveSince) aboveSince = now;
            if (vad || now - aboveSince >= START_MS) {
              aboveSince = belowSince = 0;
              utteranceStart = now;
              chunks = preroll;
              preroll = [];
              prerollBytes = 0;
              setError(null);
              set('hearing');
            }
          } else aboveSince = 0;
        } else if (stateRef.current === 'hearing') {
          chunks.push(pcm);
          if (!loud) {
            if (!belowSince) belowSince = now;
            // Silero는 이미 종료 무음 구간을 기다렸으므로 기존 RMS의 900ms를 중복 적용하지 않는다.
            if (vad || now - belowSince >= END_MS) {
              belowSince = 0;
              void finishUtterance();
              return;
            }
          } else belowSince = 0;
          if (now - utteranceStart >= MAX_UTTERANCE_MS) void finishUtterance();
        }
      },
      (cause) => {
        if (alive) {
          setError(cause.message);
          set('idle');
        }
      },
    )
      .then((c) => {
        if (!alive) return c.cancel();
        capture = c;
        set('armed');
      })
      .catch((cause) => {
        // 마이크 권한 거부·장치 없음·전처리 시작 실패 — 오류를 표시하고 idle 유지.
        if (alive) {
          setError(String(cause));
          set('idle');
        }
      });

    return () => {
      alive = false;
      capture?.cancel();
      set('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, streamAvail, workflowId]);

  return { state: streaming ? loop.state : state, error: streaming ? loop.error : error };
}
