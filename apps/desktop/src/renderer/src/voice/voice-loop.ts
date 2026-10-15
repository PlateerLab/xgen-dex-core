/**
 * useVoiceLoop — 켜 두면 끌 때까지 계속 듣는 실시간 음성 (실험, 말하는 도중 실행).
 *
 * 마이크를 계속 열어 두고(PCM16 16 kHz) RMS 로 말 시작·끝을 잡는다. 말이 시작되면 main 의 voice-stream
 * 세션을 열어 앞 0.5초부터 흘리고(조작은 main 이 말하는 도중에 한다), 말이 끝나면 세션을 닫아 결과
 * (최종 글자·실행한 조작·못 한 말)를 onResult 로 준다. 앞 말을 마무리하는 사이에 다음 말이 시작되면
 * 그 소리를 모아 두었다가 바로 다음 세션으로 넘긴다 — 명령마다 마이크를 다시 켤 필요가 없다.
 *
 * isPaused() 가 true 인 동안(예: TTS 가 말하는 중)은 소리를 버린다 — 제 목소리를 명령으로 듣지 않게.
 */
import { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { startPcmCapture, type PcmCapture } from './pcm-capture';
import type { VoiceStreamResult } from '../../../main/voice-stream';

export type VoiceLoopState = 'idle' | 'armed' | 'hearing' | 'thinking';

const RMS_THRESHOLD = 0.015; // 무음 바닥 대비 발화 판정 임계 (핸즈프리와 같은 값)
const START_MS = 150; // 이 시간 이상 임계 초과 → 말 시작
const END_MS = 1200; // 이 시간 이상 임계 미만 → 말 끝 (0.9초면 "기획전 좀 [쉼] 보여줘" 가 갈려 짧은 조각을 STT 가 잘못 알아듣는다)
const MIN_UTTERANCE_MS = 400; // 너무 짧은 소리(잡음 클릭)는 버린다
const MAX_UTTERANCE_MS = 30_000; // 폭주 방지 상한
const PREROLL_MS = 1000; // 말 시작 판정 전 소리 — 첫 음절은 약해 임계를 늦게 넘는다(0.5초면 "기획전 좀" 이 잘림)
const CARRY_MAX_MS = 6_000; // 앞 말을 마무리하는 동안 모아 둘 다음 말의 최대 길이
/**
 * 처리 못 한 말(조작 없음)은 이만큼 기다렸다가 넘긴다 — 그 사이 다음 말이 시작되면 앞 말을 이어 붙여
 * 한 번에 판단한다(말 사이 잠깐 쉬면 "기획전 좀" / "보여줘" 로 끊긴다).
 */
const JOIN_MS = 1_200;

const chunkMs = (b: Uint8Array): number => (b.byteLength / 2 / 16000) * 1000;

/** 실시간 음성(말하는 도중 실행)을 쓸 수 있는가 — 빠른 브라우저 조작 설정을 바꾸면 다시 확인한다. */
export function useVoiceStreamAvailable(): boolean {
  const [avail, setAvail] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = (): void => {
      xgen.voiceStream
        ?.available?.()
        ?.then((v) => alive && setAvail(v))
        ?.catch(() => undefined);
    };
    check();
    const off = xgen.config?.onChange?.(check);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return avail;
}

export function useVoiceLoop(opts: {
  enabled: boolean;
  workflowId?: string;
  isPaused?: () => boolean;
  onPartial?: (text: string) => void;
  /** 호출어로만 듣기에서 지금 말에 호출어를 들었다. */
  onWake?: () => void;
  onResult: (r: VoiceStreamResult) => void | Promise<void>;
}): { state: VoiceLoopState } {
  const [state, setState] = useState<VoiceLoopState>('idle');
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    const workflowId = opts.workflowId;
    if (!opts.enabled || !workflowId) {
      setState('idle');
      return;
    }
    let alive = true;
    let cap: PcmCapture | null = null;
    let phase: VoiceLoopState = 'armed';
    const set = (s: VoiceLoopState): void => {
      phase = s;
      if (alive) setState(s);
    };
    /** 말 시작 전(armed) 소리, 또는 앞 말을 마무리하는 동안(thinking) 들어온 소리. */
    let buffer: Uint8Array[] = [];
    let bufferMs = 0;
    let sid: string | null = null;
    let starting = false;
    let pending: Uint8Array[] = []; // 세션이 열리는 동안 들어온 소리
    let aboveSince = 0;
    let belowSince = 0;
    let utteranceStart = 0;
    let carried = false; // thinking 중에 다음 말이 시작됐다
    /** 넘기기를 기다리는 처리 못 한 말. 다음 말이 시작되면 그 세션 앞에 붙는다. */
    let held: { r: VoiceStreamResult; timer: ReturnType<typeof setTimeout> } | null = null;
    const deliver = (r: VoiceStreamResult): void => {
      if (!r.actions.length && r.unhandled) {
        held = { r, timer: setTimeout(() => {
          const h = held;
          held = null;
          if (alive && h) void cb.current.onResult(h.r);
        }, JOIN_MS) };
        return;
      }
      void cb.current.onResult(r);
    };

    const keep = (pcm: Uint8Array, maxMs: number): void => {
      buffer.push(pcm);
      bufferMs += chunkMs(pcm);
      while (bufferMs - chunkMs(buffer[0]) > maxMs && buffer.length > 1) bufferMs -= chunkMs(buffer.shift()!);
    };
    const begin = (): void => {
      let carryText = '';
      if (held) {
        clearTimeout(held.timer);
        carryText = held.r.text;
        held = null;
      }
      starting = true;
      pending = buffer;
      buffer = [];
      bufferMs = 0;
      utteranceStart = Date.now();
      belowSince = 0;
      set('hearing');
      void xgen.voiceStream
        .start(workflowId, carryText)
        .then((id) => {
          starting = false;
          if (!alive) return void xgen.voiceStream.cancel(id);
          sid = id;
          for (const b of pending.splice(0)) xgen.voiceStream.audio(id, b);
          if (phase !== 'hearing') finish(); // 열리는 사이에 말이 끝났다
        })
        .catch(() => {
          starting = false;
          pending = [];
          if (alive) set('armed');
        });
    };
    const finish = (): void => {
      if (starting) {
        set('thinking'); // 세션이 열리면 바로 닫는다(위 then)
        return;
      }
      const id = sid;
      sid = null;
      if (!id) {
        set('armed');
        return;
      }
      if (Date.now() - utteranceStart < MIN_UTTERANCE_MS) {
        xgen.voiceStream.cancel(id);
        set('armed');
        return;
      }
      set('thinking');
      carried = false;
      void xgen.voiceStream
        .end(id)
        .then((r) => {
          if (alive && r) deliver(r);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!alive) return;
          if (carried) begin(); // 마무리하는 사이에 다음 말이 시작됐다 — 모아 둔 소리부터 이어서
          else set('armed');
        });
    };
    const off = xgen.voiceStream.onEvent((ev) => {
      if (ev.type === 'partial' && ev.sessionId === sid) cb.current.onPartial?.(ev.text);
      else if (ev.type === 'wake' && ev.sessionId === sid) cb.current.onWake?.();
    });

    void startPcmCapture((pcm, rms) => {
      if (!alive) return;
      const now = Date.now();
      if (cb.current.isPaused?.()) {
        // 앱이 말하는 중 — 듣지 않는다. 진행 중인 말이 있으면 끝낸다.
        aboveSince = 0;
        buffer = [];
        bufferMs = 0;
        if (phase === 'hearing') finish();
        return;
      }
      const loud = rms >= RMS_THRESHOLD;
      if (phase === 'armed' || phase === 'thinking') {
        // 평소엔 앞 0.5초만 남기고, 마무리하는 사이 다음 말이 시작됐으면 그 말을 통째로(최대 6초) 모아 둔다.
        keep(pcm, carried ? CARRY_MAX_MS : PREROLL_MS);
        if (loud) {
          if (!aboveSince) aboveSince = now;
          if (now - aboveSince >= START_MS) {
            aboveSince = 0;
            if (phase === 'armed') begin();
            else carried = true;
          }
        } else if (!carried) aboveSince = 0;
        return;
      }
      // hearing
      if (sid) xgen.voiceStream.audio(sid, pcm);
      else if (starting) pending.push(pcm);
      if (!loud) {
        if (!belowSince) belowSince = now;
        if (now - belowSince >= END_MS) finish();
      } else belowSince = 0;
      if (now - utteranceStart >= MAX_UTTERANCE_MS) finish();
    })
      .then((c) => {
        if (!alive) return c.stop();
        cap = c;
        set('armed');
      })
      .catch(() => set('idle'));

    return () => {
      alive = false;
      if (held) clearTimeout(held.timer);
      off();
      cap?.stop();
      if (sid) xgen.voiceStream.cancel(sid);
      setState('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.workflowId]);

  return { state };
}
