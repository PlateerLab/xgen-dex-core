/**
 * ActionBar — 아바타의 컨트롤 버튼들.
 *
 * 두 곳에서 쓴다:
 *
 *   잠김   컨트롤 창(chip.html)에서 — 아바타 창은 입력이 통과하므로 자기
 *          잠금 해제 버튼을 담을 수 없다. 그래서 버튼만 별도 창에 산다.
 *   풀림   아바타 창 안의 상단 바에서 — 이때는 창이 입력을 잡으므로 같은
 *          창에 있어도 된다.
 *
 * 같은 컴포넌트를 쓰는 이유: 두 곳이 갈리면 "잠갔을 때만 없는 버튼" 이
 * 생기고, 사용자는 그게 의도인지 버그인지 알 수 없다.
 */
import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import {
  HandsfreeIcon,
  MicIcon,
  MicOffIcon,
  SpeakerIcon,
  SpeakerOffIcon,
} from '../brand/icons';
import { useHandsfree } from './handsfree';

export function LockIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d={open ? 'M7 11V7a5 5 0 0 1 9.9-1' : 'M7 11V7a5 5 0 0 1 10 0v4'} />
    </svg>
  );
}

/** 음성 관련 상태 — 두 창이 각자 구독한다 (설정은 main 이 단일 출처). */
export function useVoiceControls(): {
  sttAvailable: boolean;
  ttsAvailable: boolean;
  voiceInputOn: boolean;
  voiceOutputOn: boolean;
  handsfreeOn: boolean;
  handsfreeActive: boolean;
  hfState: string;
  toggleVoiceInput: () => void;
  toggleVoiceOutput: () => void;
  toggleHandsfree: () => void;
} {
  const [sttAvailable, setSttAvailable] = useState(false);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [voiceInputOn, setVoiceInputOn] = useState(true);
  const [voiceOutputOn, setVoiceOutputOn] = useState(true);
  const [handsfreeOn, setHandsfreeOn] = useState(false);

  useEffect(() => {
    const apply = (c: {
      voiceHandsfree?: boolean;
      voiceInput?: boolean;
      voiceOutput?: boolean;
    }): void => {
      setHandsfreeOn(!!c.voiceHandsfree);
      setVoiceInputOn(c.voiceInput !== false);
      setVoiceOutputOn(c.voiceOutput !== false);
    };
    void xgen.config.get().then(apply);
    return xgen.config.onChange(apply);
  }, []);

  // 서버 STT/TTS 게이트 — 꺼져 있으면 버튼을 아예 내보내지 않는다
  // (죽은 버튼을 광고하지 않는다).
  useEffect(() => {
    let alive = true;
    const check = (): void => {
      xgen.voice
        ?.getConfig?.()
        ?.then((c) => {
          if (!alive) return;
          setSttAvailable(!!c?.stt?.enabled);
          setTtsAvailable(!!c?.tts?.enabled);
        })
        ?.catch(() => undefined);
    };
    check();
    const off = xgen.user?.onAvatarRefresh?.(() => check());
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const handsfreeActive = handsfreeOn && sttAvailable && voiceInputOn;
  const { state: hfState } = useHandsfree(handsfreeActive);

  return {
    sttAvailable,
    ttsAvailable,
    voiceInputOn,
    voiceOutputOn,
    handsfreeOn,
    handsfreeActive,
    hfState,
    toggleVoiceInput: () => void xgen.config.set({ voiceInput: !voiceInputOn }),
    toggleVoiceOutput: () => void xgen.config.set({ voiceOutput: !voiceOutputOn }),
    toggleHandsfree: () => void xgen.config.set({ voiceHandsfree: !handsfreeOn }),
  };
}

interface VoiceButtonsProps {
  voice: ReturnType<typeof useVoiceControls>;
}

/** 음성 버튼 3종 (가용한 것만). 잠금 여부와 무관하게 같은 집합이다. */
export function VoiceButtons({ voice }: VoiceButtonsProps): React.ReactElement {
  const {
    sttAvailable,
    ttsAvailable,
    voiceInputOn,
    voiceOutputOn,
    handsfreeActive,
    hfState,
    toggleVoiceInput,
    toggleVoiceOutput,
    toggleHandsfree,
  } = voice;
  return (
    <>
      {sttAvailable && (
        <button
          className={`ov-icon-btn ov-voice ${voiceInputOn ? 'stt-on' : ''}`}
          onClick={toggleVoiceInput}
          title={voiceInputOn ? '음성 입력(STT) 끄기' : '음성 입력(STT) 켜기'}
        >
          {voiceInputOn ? <MicIcon size={15} /> : <MicOffIcon size={15} />}
        </button>
      )}
      {ttsAvailable && (
        <button
          className={`ov-icon-btn ov-voice ${voiceOutputOn ? 'tts-on' : ''}`}
          onClick={toggleVoiceOutput}
          title={voiceOutputOn ? '음성 출력(TTS) 끄기' : '음성 출력(TTS) 켜기'}
        >
          {voiceOutputOn ? <SpeakerIcon size={15} /> : <SpeakerOffIcon size={15} />}
        </button>
      )}
      {sttAvailable && (
        <button
          className={`ov-icon-btn ov-mic ${handsfreeActive ? `on ${hfState}` : ''}`}
          onClick={toggleHandsfree}
          title={
            handsfreeActive
              ? '핸즈프리 음성 대화 끄기'
              : '핸즈프리 음성 대화 켜기 — 말하면 자동으로 채팅에 입력됩니다'
          }
        >
          <HandsfreeIcon size={15} />
        </button>
      )}
    </>
  );
}
