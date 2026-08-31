/**
 * ChipApp — 잠긴 아바타의 컨트롤 창.
 *
 * 왜 별도 창인가:
 *
 *   잠긴 아바타는 클릭을 데스크톱으로 흘려보내야 한다 (그게 잠금의 뜻이다).
 *   그러려면 아바타 창이 입력 통과여야 하고, **입력이 통과하는 창은 자기
 *   잠금 해제 버튼을 담을 수 없다.**
 *
 *   예전에는 한 창 안에서 hover 로 입력을 되살렸다. 그 방식은 무너진다 —
 *   리눅스에서는 통과 창에 이벤트가 아예 안 오고, darwin/win32 에서도
 *   forward 되는 것은 이동 이벤트뿐이라 hover 감지와 클릭 사이의 IPC 왕복에서
 *   클릭이 사라진다. 사용자에게는 "버튼이 보이는데 눌리지 않는다" 가 된다.
 *
 * ⚠ **공용 스타일시트를 쓰지 않는다.** 이 창은 스타일을 전부 인라인으로 든다.
 *
 *   처음에는 styles.css 를 그대로 가져왔는데, 거기 `body { background:
 *   var(--app-bg) }` 가 있고 라이트 테마에서 그 값이 `#f7f8fa` 다. 창 크기가
 *   내용보다 크면 그 남는 영역이 **흰 알약**으로 보인다 — 실제로 잠금 칩이
 *   토글 스위치처럼 보였다. 창 하나짜리 UI 에 앱 전역 스타일을 끌어오면
 *   이런 것이 언제든 다시 샌다.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { xgen } from '../bridge';
import { useVoiceControls } from './ActionBar';

/** 창 전체 — 항상 투명하고, 알약을 가운데 둔다. */
const SHELL: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: '100vw',
  height: '100vh',
  margin: 0,
  background: 'transparent',
};

const BAR: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: '4px 6px',
  borderRadius: 999,
  background: 'rgba(18, 18, 22, 0.82)',
  border: '1px solid rgba(255, 255, 255, 0.10)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)',
  cursor: 'move',
  userSelect: 'none',
};

const BTN: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.86)',
  cursor: 'pointer',
  padding: 0,
};

const BTN_ON: React.CSSProperties = { ...BTN, color: '#8ab4ff' };

function Svg({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function ChipApp(): React.ReactElement {
  const voice = useVoiceControls();
  const barRef = useRef<HTMLDivElement | null>(null);

  // 창을 내용에 맞춘다. 버튼 수가 STT/TTS 가용성에 따라 달라지므로 고정 크기면
  // 잘리거나(작을 때), 남는 투명 영역이 데스크톱 클릭을 먹는다(클 때).
  //
  // 주기적으로도 다시 잰다 — 테마/배율 변경은 리사이즈 이벤트를 주지 않는다.
  useEffect(() => {
    const report = (): void => {
      const r = barRef.current?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        xgen.overlay.reportChipSize(Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
      }
    };
    report();
    const t = setInterval(report, 1500);
    window.addEventListener('resize', report);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', report);
    };
  }, [voice.sttAvailable, voice.ttsAvailable]);

  // 컨트롤 바를 끌면 아바타가 따라 움직인다. 잠긴 상태에서도 위치는 바꿀 수
  // 있어야 한다 — 아바타가 가리는 곳에 있을 때 잠금을 풀었다 다시 잠그게
  // 만들 이유가 없다.
  const onDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // 버튼 클릭은 드래그가 아니다
    e.preventDefault();
    const move = (ev: MouseEvent): void => xgen.overlay.moveBy(ev.movementX, ev.movementY);
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      xgen.overlay.commitBounds();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  const {
    sttAvailable,
    ttsAvailable,
    voiceInputOn,
    voiceOutputOn,
    handsfreeActive,
    toggleVoiceInput,
    toggleVoiceOutput,
    toggleHandsfree,
  } = voice;

  return (
    <div style={SHELL}>
      <div ref={barRef} style={BAR} onMouseDown={onDrag} title="드래그하여 이동">
        {sttAvailable && (
          <button
            style={voiceInputOn ? BTN_ON : BTN}
            onClick={toggleVoiceInput}
            title={voiceInputOn ? '음성 입력(STT) 끄기' : '음성 입력(STT) 켜기'}
          >
            <Svg>
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4" />
              {!voiceInputOn && <path d="M2 2l20 20" />}
            </Svg>
          </button>
        )}
        {ttsAvailable && (
          <button
            style={voiceOutputOn ? BTN_ON : BTN}
            onClick={toggleVoiceOutput}
            title={voiceOutputOn ? '음성 출력(TTS) 끄기' : '음성 출력(TTS) 켜기'}
          >
            <Svg>
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              {voiceOutputOn ? (
                <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
              ) : (
                <path d="M22 9l-6 6M16 9l6 6" />
              )}
            </Svg>
          </button>
        )}
        {sttAvailable && (
          <button
            style={handsfreeActive ? BTN_ON : BTN}
            onClick={toggleHandsfree}
            title={
              handsfreeActive
                ? '핸즈프리 음성 대화 끄기'
                : '핸즈프리 음성 대화 켜기 — 말하면 자동으로 채팅에 입력됩니다'
            }
          >
            <Svg>
              <path d="M3 12v-1M7 15V9M11 18V6M15 15V9M19 12v-1M23 13v-2" />
            </Svg>
          </button>
        )}
        <button
          style={BTN}
          onClick={() => xgen.overlay.setLocked(false)}
          title="잠금 해제 — 아바타 이동·크기 조절"
        >
          <Svg>
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0" />
          </Svg>
        </button>
      </div>
    </div>
  );
}
