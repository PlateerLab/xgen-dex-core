/** 첫 화면 — 제공자를 연결하고 에이전트를 만들면 대화할 수 있다. 다 됐으면 에이전트를 고르라고 한다. */
import React from 'react';
import { useData } from '../data';
import { BotIcon, CheckIcon, ServerIcon } from '../dex';
import { XdMark } from './XdMark';

export const Welcome: React.FC<{ onProviders: () => void; onNewAgent: () => void; onOpenAgent: (id: string) => void }> = ({
  onProviders,
  onNewAgent,
  onOpenAgent,
}) => {
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
        <button type="button" className={`xd-step${hasAgent ? ' done' : ''}`} onClick={onNewAgent} disabled={!hasProvider}>
          <span className="xd-step-icon">{hasAgent ? <CheckIcon size={16} /> : <BotIcon size={16} />}</span>
          <span>
            <strong>에이전트 만들기</strong>
            <em>{hasAgent ? `${agents.length}개` : '이름과 모델을 정하면 됩니다'}</em>
          </span>
        </button>
      </div>
      {hasAgent && (
        <button type="button" className="primary" onClick={() => onOpenAgent(agents[0].id)}>
          대화 시작하기
        </button>
      )}
    </div>
  );
};
