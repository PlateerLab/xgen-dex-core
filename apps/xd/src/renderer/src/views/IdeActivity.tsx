/**
 * 활동 막대의 IDE 단추 — 작업 공간을 보고 있을 때만. Dex 데스크톱이 앱 사이드바에 그리는 것과 같은 모양·같은 동작
 * (`ideActivityItems`·`pressIdeActivity`)이되, XD 에 아직 없는 소스 제어·터미널은 뺀다.
 */
import React from 'react';
import { pressIdeActivity, useIdeActivity, type IdeActivityItem, type IdeStore } from '@dex/ide';
import { FolderCodeIcon, PanelRightIcon, SearchIcon } from '../dex';

const SHOWN: Record<string, React.FC<{ size?: number }>> = {
  explorer: FolderCodeIcon,
  search: SearchIcon,
  chat: PanelRightIcon,
};

export const IdeActivity: React.FC<{ store: IdeStore }> = ({ store }) => {
  const items = useIdeActivity(store).filter((i) => i.id in SHOWN);
  const button = (item: IdeActivityItem) => {
    const Glyph = SHOWN[item.id];
    return (
      <button
        key={item.id}
        type="button"
        className={`ab-btn ab-ide-btn ${item.active ? 'active' : ''}`}
        title={item.title}
        aria-label={item.label}
        aria-pressed={item.active}
        onClick={() => pressIdeActivity(store, item)}
      >
        <Glyph size={19} />
      </button>
    );
  };
  const views = items.filter((i) => i.kind === 'view');
  const toggles = items.filter((i) => i.kind === 'toggle');
  return (
    <>
      <div className="ab-sep" aria-hidden />
      <div className="ab-ide" role="group" aria-label="작업 공간">
        {views.map(button)}
        {toggles.length > 0 && <span className="ab-ide-rule" aria-hidden />}
        {toggles.map(button)}
      </div>
    </>
  );
};
