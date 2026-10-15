/**
 * 계속 듣기 상태 막대 — 입력창 위. 지금 듣고 있는지(호출어 대기·듣는 중·처리 중)를 한눈에 보이고,
 * 마지막으로 한 일(실행·에이전트에게 보냄·무시)을 칩 하나로 보인다.
 *
 * 호출어로만 듣기에서는 부르기 전까지 사람의 말을 들어도 '호출어 대기' 그대로다 — 발표 중에 상태가
 * 깜빡이지 않게. 부르면(호출어를 들으면) 그때부터 듣는 중·처리 중을 보인다.
 */
import React from 'react';
import { CheckIcon, MicIcon, SendIcon } from '../brand/icons';
import type { VoiceLoopState } from './voice-loop';

export type VoiceLogEntry = {
  kind: 'act' | 'chat' | 'skip' | 'noise' | 'busy';
  text: string;
  at: number;
};

type Mode = 'idle' | 'standby' | 'armed' | 'hearing' | 'thinking';

const EVENT_LABEL: Record<VoiceLogEntry['kind'], string> = {
  act: '실행',
  chat: '에이전트에게',
  skip: '무시',
  noise: '무시 · 주변 소리',
  busy: '못 보냄 · 답하는 중',
};

export const VoiceLoopBar: React.FC<{
  state: VoiceLoopState;
  /** 호출어로만 듣기의 호출어(안내용). null 이면 꺼짐. */
  wakeWord: string | null;
  /** 호출어를 들었다 — 이번 말(또는 다음 말 하나)을 받는 중. */
  called: boolean;
  last?: VoiceLogEntry;
}> = ({ state, wakeWord, called, last }) => {
  const mode: Mode = state === 'idle' ? 'idle' : wakeWord && !called ? 'standby' : state;
  const title =
    mode === 'idle'
      ? '마이크 준비 중'
      : mode === 'standby'
        ? '호출어 대기'
        : mode === 'hearing'
          ? '듣는 중'
          : mode === 'thinking'
            ? '처리 중'
            : wakeWord
              ? '듣고 있어요'
              : '계속 듣기';
  const sub =
    mode === 'standby' ? (
      <>
        부르면 듣습니다 <span className="voice-bar-key">{wakeWord}</span>
      </>
    ) : mode === 'hearing' ? (
      '말하는 도중에 바로 실행합니다'
    ) : mode === 'thinking' ? (
      '남은 말을 판단하고 있어요'
    ) : mode === 'armed' ? (
      wakeWord ? (
        '이어서 말씀하세요'
      ) : (
        '말하면 바로 조작합니다'
      )
    ) : null;
  return (
    <div className={`voice-bar is-${mode}`} role="status" aria-live="polite">
      <span className="voice-bar-orb" aria-hidden>
        {mode === 'hearing' ? (
          <span className="voice-bar-wave">
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <MicIcon size={15} />
        )}
      </span>
      <div className="voice-bar-text">
        <span className="voice-bar-title">{title}</span>
        {sub && <span className="voice-bar-sub">{sub}</span>}
      </div>
      {last && (
        <span
          key={last.at}
          className={`voice-bar-event is-${last.kind}`}
          title={`${EVENT_LABEL[last.kind]}: ${last.text}`}
        >
          {last.kind === 'act' ? (
            <CheckIcon size={12} />
          ) : last.kind === 'chat' ? (
            <SendIcon size={12} />
          ) : null}
          <span className="voice-bar-event-label">{EVENT_LABEL[last.kind]}</span>
          <span className="voice-bar-event-text">{last.text}</span>
        </span>
      )}
    </div>
  );
};
