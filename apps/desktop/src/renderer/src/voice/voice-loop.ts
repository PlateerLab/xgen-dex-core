/**
 * 실시간 STT 캡처. Silero ON은 로컬 감지, OFF는 서버 final로 발화 구간을 마친다.
 * 로컬 감지에서는 최대 1.2초 pre-roll을 포함한다. 현재 main은 최종 발화 뒤 채팅 계획까지 조작을 보류한다.
 * isPaused() 동안 입력을 무음으로 바꾸고 전송을 쉬며, 캡처 종료는 진행 중인 발화를 취소한다.
 */
import { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { startProcessedCapture, type ProcessedCapture } from './processed-capture';
import type { VoiceStreamResult } from '../../../main/voice-stream';
import type { VoiceTrace } from '../../../main/voice-trace';

export type VoiceLoopState = 'idle' | 'armed' | 'hearing' | 'thinking';

// shortcut: 기존 대기값을 Silero 종료 후 추가 hold로 사용한다. 현장 끝점 지연·문장 분리 검증 후 조정한다.
const END_MS = 1200;
const MIN_UTTERANCE_MS = 400; // 감지 확정 후 세션 경과 시간이며 실제 발성 길이는 아니다.
const MAX_UTTERANCE_MS = 30_000; // 폭주 방지 상한
// shortcut: 감지 전 PCM 보관 길이. 현장 첫 음절 보존 검증 후 조정한다.
const PREROLL_MS = 1200;
/**
 * 로컬 감지가 꺼져 있으면 서버가 말 끝을 알리기까지(약 0.2초) 다음 말의 첫 음절이 앞 세션으로 가서 버려진다 —
 * "엑스젠 [쉼] 제목을…" 이 "녹을…" 로 들렸다(10/28 실측). 앞 세션에 보낸 마지막 이만큼을 다음 세션 앞에 다시 붙인다.
 * 서버는 말이 끝나고 조용한 뒤에 말 끝을 알리므로 평소에는 무음이 붙는다.
 */
const TAIL_MS = 300;
const CARRY_MAX_MS = 6_000; // 앞 말을 마무리하는 동안 모아 둘 다음 말의 최대 길이
/**
 * 처리 못 한 말(조작 없음)은 이만큼 기다렸다가 넘긴다 — 그 사이 다음 말이 시작되면 앞 말을 이어 붙여
 * 한 번에 판단한다(말 사이 잠깐 쉬면 "기획전 좀" / "보여줘" 로 끊긴다).
 */
const JOIN_MS = 1_200;
/**
 * 앞 말을 이어 붙여 연 세션이 새 글자를 기다리는 시간 — 이어 말한 소리의 첫 중간 결과가 서버에서 오기까지 1~1.5초 걸린다
 * (10/28 실측, 서버 중간 결과 주기 1.2초). 짧으면 문장 사이에 쉰 긴 요청이 둘로 갈려 뒷말이 "답하는 중" 으로 버려진다.
 */
const JOIN_WAIT_MS = JOIN_MS + 1_500;
const RETRY_MS = 2_000;
const MAX_STT_ERRORS = 3;

const chunkMs = (b: Uint8Array): number => (b.byteLength / 2 / 16000) * 1000;

/** 기존 빠른 조작 설정에 따른 실시간 음성 경로를 쓸 수 있는가 — 빠른 브라우저 조작 설정을 바꾸면 다시 확인한다. */
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
  interactionId?: string;
  /** Bind speech to the visible confirmation; changing cards cancels the old capture. */
  responseKey?: string | null;
  isPaused?: () => boolean;
  onPartial?: (text: string) => void;
  /** 호출어로만 듣기에서 지금 말에 호출어를 들었다. */
  onWake?: () => void;
  onResult: (r: VoiceStreamResult, responseKey: string | null) => void | Promise<void>;
}): { state: VoiceLoopState; error: string | null; notice: string | null } {
  const [state, setState] = useState<VoiceLoopState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    const workflowId = opts.workflowId;
    const responseKey = opts.responseKey ?? null;
    if (!opts.enabled || !workflowId) {
      setState('idle');
      return;
    }
    let alive = true;
    const isCurrent = (): boolean => alive && (cb.current.responseKey ?? null) === responseKey;
    setError(null);
    setNotice(null);
    let cap: ProcessedCapture | null = null;
    let phase: VoiceLoopState = 'armed';
    const set = (s: VoiceLoopState): void => {
      phase = s;
      if (alive) setState(s);
    };
    /** 말 시작 전(armed) 소리, 또는 앞 말을 마무리하는 동안(thinking) 들어온 소리. */
    let buffer: Uint8Array[] = [];
    let bufferMs = 0;
    let tail: Uint8Array[] = []; // 지금 세션에 보낸 마지막 TAIL_MS
    let tailMs = 0;
    let sid: string | null = null;
    let activeId: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let sttErrors = 0;
    let starting = false;
    let pending: Uint8Array[] = []; // 세션이 열리는 동안 들어온 소리
    let localVad = false;
    let belowSince = 0;
    let utteranceStart = 0;
    let carried = false; // thinking 중에 다음 말이 시작됐다
    /** 넘기기를 기다리는 처리 못 한 말. 다음 말이 시작되면 그 세션 앞에 붙는다. */
    let held: { r: VoiceStreamResult; timer: ReturnType<typeof setTimeout> } | null = null;
    /**
     * 앞 말을 이어 붙여 연 세션이 이 시각까지 새 글자를 못 받으면 마친다 — 이어 말하지 않았다. 로컬 감지가 꺼져 있으면
     * 조용해도 다음 세션이 바로 열리고 서버는 새 글자가 있어야 말 끝을 알려서, 이것 없이는 30초 상한까지 기다렸다.
     */
    let joinUntil = 0;
    let endWithoutJoin = false; // 위 이유로 마친 세션의 결과는 다시 기다리지 않고 바로 넘긴다
    const trace =(r: VoiceStreamResult, stage: VoiceTrace['stage'], reason: string, waitMs?: number): void => {
      if (r.traceId) xgen.voiceStream.trace({ id: r.traceId, stage, text: r.text, requestId: responseKey, reason, waitMs });
    };
    const deliver = (r: VoiceStreamResult, immediate = false): void => {
      if (!isCurrent()) { trace(r, 'deliver', 'stale_context'); return; }
      if (!immediate && !r.blocked && !r.actions.length && r.unhandled) {
        trace(r, 'deliver', 'waiting_for_continuation', JOIN_MS);
        held = { r, timer: setTimeout(() => {
          const h = held;
          held = null;
          if (h) {
            trace(h.r, 'deliver', isCurrent() ? 'continuation_wait_finished' : 'stale_context');
            if (isCurrent()) void cb.current.onResult(h.r, responseKey);
          }
        }, JOIN_MS) };
        return;
      }
      trace(r, 'deliver', immediate ? 'no_continuation' : 'immediate');
      void cb.current.onResult(r, responseKey);
    };

    const keep = (pcm: Uint8Array, maxMs: number): void => {
      buffer.push(pcm);
      bufferMs += chunkMs(pcm);
      while (bufferMs - chunkMs(buffer[0]) > maxMs && buffer.length > 1) bufferMs -= chunkMs(buffer.shift()!);
    };
    const begin = (): void => {
      let carryText = '';
      if (held) {
        trace(held.r, 'carry', 'joined_next_utterance');
        clearTimeout(held.timer);
        carryText = held.r.text;
        held = null;
      }
      joinUntil = carryText ? Date.now() + JOIN_WAIT_MS : 0;
      endWithoutJoin = false;
      starting = true;
      pending = buffer;
      buffer = [];
      bufferMs = 0;
      tail = [];
      tailMs = 0;
      utteranceStart = Date.now();
      belowSince = 0;
      set('hearing');
      void xgen.voiceStream
        .start(workflowId, carryText, cb.current.interactionId, responseKey ?? undefined)
        .then((id) => {
          starting = false;
          if (!isCurrent()) return void xgen.voiceStream.cancel(id);
          sid = id;
          activeId = id;
          for (const b of pending.splice(0)) xgen.voiceStream.audio(id, b);
          if (phase !== 'hearing') finish(); // 열리는 사이에 말이 끝났다
        })
        .catch((cause) => {
          starting = false;
          pending = [];
          if (isCurrent()) { setError(String(cause)); cap?.cancel(); set('idle'); }
        });
    };
    const finish = (): void => {
      if (starting) {
        set('thinking'); // 세션이 열리면 바로 닫는다(위 then)
        return;
      }
      const id = sid;
      const immediate = endWithoutJoin;
      sid = null;
      joinUntil = 0;
      endWithoutJoin = false;
      if (!id) {
        set('armed');
        return;
      }
      if (Date.now() - utteranceStart < MIN_UTTERANCE_MS) {
        activeId = null;
        xgen.voiceStream.cancel(id);
        set('armed');
        return;
      }
      set('thinking');
      carried = false;
      if (!localVad) {
        buffer = tail; // 다음 세션은 서버가 말 끝을 알리는 사이에 이 세션으로 간 소리부터 듣는다
        bufferMs = tailMs;
      }
      tail = [];
      tailMs = 0;
      void xgen.voiceStream
        .end(id)
        .then((r) => {
          if (r && activeId === id) {
            sttErrors = 0;
            setNotice(null);
            if (alive) deliver(r, immediate);
            else trace(r, 'deliver', 'capture_closed');
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!isCurrent() || activeId !== id) return;
          activeId = null;
          if (carried) begin(); // 마무리하는 사이에 다음 말이 시작됐다 — 모아 둔 소리부터 이어서
          else set('armed');
        });
    };
    const off = xgen.voiceStream.onEvent((ev) => {
      if (!isCurrent()) return;
      if (ev.type === 'partial' && ev.sessionId === sid) {
        joinUntil = 0; // 이어 말했다 — 앞 말과 함께 서버의 말 끝을 기다린다
        cb.current.onPartial?.(ev.text);
      }
      else if (ev.type === 'utterance_end' && ev.sessionId === sid && !localVad && phase === 'hearing') finish();
      else if (ev.type === 'error' && ev.sessionId === activeId) {
        xgen.voiceStream.cancel(ev.sessionId);
        sid = null;
        activeId = null;
        buffer = [];
        bufferMs = 0;
        carried = false;
        joinUntil = 0;
        endWithoutJoin = false;
        tail = [];
        tailMs = 0;
        if (++sttErrors >= MAX_STT_ERRORS) {
          cap?.cancel();
          setNotice(null);
          setError(`음성 인식에 반복 실패했습니다. (${ev.error})`);
          set('idle');
        } else {
          setNotice('음성 인식 연결이 끊겼습니다. 잠시 후 방금 한 말을 다시 말씀해 주세요.');
          set('thinking');
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!isCurrent()) return;
            buffer = [];
            bufferMs = 0;
            carried = false;
            set('armed');
          }, RETRY_MS);
        }
      }
      else if (ev.type === 'wake' && ev.sessionId === sid) cb.current.onWake?.();
    });

    void startProcessedCapture(({ pcm, inSpeech, events, vad }) => {
      localVad = vad;
      if (!isCurrent()) return;
      if (retryTimer) return;
      const now = Date.now();
      if (cb.current.isPaused?.()) {
        // 앱이 말하는 중 — 듣지 않는다. 진행 중인 말이 있으면 끝낸다.
        buffer = [];
        bufferMs = 0;
        if (phase === 'hearing') finish();
        return;
      }
      const loud = !vad || inSpeech || events.some(e => e.type === 'speech_start');
      if (phase === 'armed' || phase === 'thinking') {
        // 평소엔 앞 1.2초만 남기고, 마무리하는 사이 다음 말이 시작됐으면 그 말을 통째로(최대 6초) 모아 둔다.
        keep(pcm, carried ? CARRY_MAX_MS : PREROLL_MS);
        if (loud) {
          if (phase === 'armed') begin();
          else carried = true;
        }
        return;
      }
      // hearing
      if (sid) xgen.voiceStream.audio(sid, pcm);
      else if (starting) pending.push(pcm);
      tail.push(pcm);
      tailMs += chunkMs(pcm);
      while (tailMs - chunkMs(tail[0]) > TAIL_MS && tail.length > 1) tailMs -= chunkMs(tail.shift()!);
      if (joinUntil && now >= joinUntil) {
        endWithoutJoin = true;
        finish();
        return;
      }
      if (vad && !loud) {
        if (!belowSince) belowSince = now;
        if (now - belowSince >= END_MS) finish();
      } else belowSince = 0;
      if (now - utteranceStart >= MAX_UTTERANCE_MS) finish();
    }, (cause) => {
      if (!isCurrent()) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      setError(cause.message);
      if (activeId) xgen.voiceStream.cancel(activeId);
      sid = null; activeId = null; set('idle');
    }, () => cb.current.isPaused?.() === true)
      .then((c) => {
        if (!isCurrent()) return c.cancel();
        cap = c;
        set('armed');
      })
      .catch((cause) => { if (isCurrent()) { setError(String(cause)); set('idle'); } });

    return () => {
      alive = false;
      if (held) clearTimeout(held.timer);
      if (retryTimer) clearTimeout(retryTimer);
      off();
      cap?.cancel();
      if (activeId) xgen.voiceStream.cancel(activeId);
      setState('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.workflowId, opts.interactionId, opts.responseKey]);

  return { state, error, notice };
}
