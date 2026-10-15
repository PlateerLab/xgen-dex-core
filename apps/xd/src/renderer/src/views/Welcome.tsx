/**
 * 처음 켰을 때(제공자도 에이전트도 없다). 제공자를 연결하면 시작 화면에서 에이전트를 만들고 대화한다.
 * 제공자나 에이전트가 하나라도 있으면 이 화면 대신 시작 화면이 선다(App).
 */
import React from 'react';
import { useData } from '../data';
import { BotIcon, CheckIcon, ServerIcon } from '../dex';
import { XdMark } from './XdMark';

export const Welcome: React.FC<{ onProviders: () => void; onStart: () => void }> = ({ onProviders, onStart }) => {
  const { accounts, agents } = useData();
  const hasProvider = accounts.length > 0;
  const hasAgent = agents.length > 0;
  return (
    <div className="xd-welcome">
      <XdMark size={56} />
      <h2>이 PC 에서 에이전트와 일하세요</h2>
      <p className="muted">서버 없이 이 PC 에서 실행되고, 파일은 이 PC 의 작업 공간에 남습니다.</p>
      <div className="xd-steps">
        <button type="button" className={`xd-step${hasProvider ? ' done' : ''}`} onClick={onProviders}>
          <span className="xd-step-icon">{hasProvider ? <CheckIcon size={16} /> : <ServerIcon size={16} />}</span>
          <span>
            <strong>AI 제공자 연결</strong>
            <em>{hasProvider ? `${accounts.length}개 연결됨` : 'API 키나 Claude Code·Codex 로그인'}</em>
          </span>
        </button>
        <button type="button" className={`xd-step${hasAgent ? ' done' : ''}`} onClick={onStart} disabled={!hasProvider}>
          <span className="xd-step-icon">{hasAgent ? <CheckIcon size={16} /> : <BotIcon size={16} />}</span>
          <span>
            <strong>에이전트 만들기</strong>
            <em>{hasAgent ? `${agents.length}개` : '이름과 모델을 정하면 됩니다'}</em>
          </span>
        </button>
      </div>
    </div>
  );
};
