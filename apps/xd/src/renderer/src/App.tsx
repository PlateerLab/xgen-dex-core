/**
 * XD 앱 틀 — 왼쪽 줄(대화·제공자·설정), 사이드바(에이전트·대화), 본문.
 *
 * 화면은 XD 전용이다(2026-10-02 결정). Dex 와 같은 부품(마크다운·작업 과정·아이콘·스타일)은 `dex.ts` 로만 가져온다.
 */
import React, { useEffect, useState } from 'react';
import { xd } from './bridge';
import { DataProvider, useData } from './data';
import { ChatIcon, ServerIcon, SettingsIcon, Tooltip } from './dex';
import { forgetIdeStores, useIdeMode, useIdeStore } from './ide/ide-stores';
import { liveStore } from './live-store';
import { AgentEditor } from './views/AgentEditor';
import { ChatView } from './views/ChatView';
import { IdeActivity } from './views/IdeActivity';
import { ProvidersView } from './views/ProvidersView';
import { SettingsView } from './views/SettingsView';
import { Sidebar } from './views/Sidebar';
import { Welcome } from './views/Welcome';
import { XdMark } from './views/XdMark';

export type Route =
  | { name: 'home' }
  | { name: 'chat'; agentId: string; conversationId: string | null }
  | { name: 'agent-new' }
  | { name: 'agent-edit'; agentId: string }
  | { name: 'providers' }
  | { name: 'settings' };

const Shell: React.FC = () => {
  const { agents, loaded, error } = useData();
  const [route, setRoute] = useState<Route>({ name: 'home' });

  // 턴 사건은 앱에 한 번만 듣는다 — 화면을 옮겨도 도는 답이 끊기지 않는다.
  useEffect(() => xd.onTurnEvent((event) => liveStore.apply(event)), []);

  // 지워진 에이전트의 작업 공간 IDE 는 정리한다 — 목록을 제대로 받았을 때만(시작에 실패해 빈 목록이면 저장 안 한 버퍼의
  // 사본까지 지우게 된다).
  useEffect(() => {
    if (loaded && !error) forgetIdeStores(agents.map((a) => a.id));
  }, [agents, loaded, error]);

  // 지워진 에이전트를 보고 있었다면 처음으로.
  useEffect(() => {
    if ((route.name === 'chat' || route.name === 'agent-edit') && loaded && !agents.some((a) => a.id === route.agentId)) {
      setRoute({ name: 'home' });
    }
  }, [agents, loaded, route]);

  // 작업 공간을 보고 있으면 활동 막대에 IDE 단추(탐색기·찾기·대화 칸)를 올린다.
  const chatAgentId = route.name === 'chat' ? route.agentId : null;
  const ideOn = useIdeMode(chatAgentId);
  const ideStore = useIdeStore(ideOn ? chatAgentId : null);

  if (error) return <div className="center">{error}</div>;
  if (!loaded) return <div className="center muted small">불러오는 중…</div>;

  const agentId = route.name === 'chat' || route.name === 'agent-edit' ? route.agentId : null;
  const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
  const top = route.name === 'providers' ? 'providers' : route.name === 'settings' ? 'settings' : 'chat';

  let main: React.ReactNode;
  if (route.name === 'chat' && agent) {
    main = (
      <ChatView
        key={agent.id}
        agent={agent}
        conversationId={route.conversationId}
        onConversation={(id) => setRoute({ name: 'chat', agentId: agent.id, conversationId: id })}
        onEditAgent={() => setRoute({ name: 'agent-edit', agentId: agent.id })}
      />
    );
  } else if (route.name === 'agent-new') {
    main = <AgentEditor agent={null} onDone={(id) => setRoute(id ? { name: 'chat', agentId: id, conversationId: null } : { name: 'home' })} onProviders={() => setRoute({ name: 'providers' })} />;
  } else if (route.name === 'agent-edit' && agent) {
    main = (
      <AgentEditor
        key={agent.id}
        agent={agent}
        onDone={(id) => setRoute(id ? { name: 'chat', agentId: id, conversationId: null } : { name: 'home' })}
        onProviders={() => setRoute({ name: 'providers' })}
      />
    );
  } else if (route.name === 'providers') {
    main = <ProvidersView />;
  } else if (route.name === 'settings') {
    main = <SettingsView />;
  } else {
    main = (
      <Welcome
        onProviders={() => setRoute({ name: 'providers' })}
        onNewAgent={() => setRoute({ name: 'agent-new' })}
        onOpenAgent={(id) => setRoute({ name: 'chat', agentId: id, conversationId: null })}
      />
    );
  }

  const rail = (name: 'chat' | 'providers' | 'settings', label: string, icon: React.ReactNode, go: () => void) => (
    <Tooltip label={label} side="bottom">
      <button type="button" className={`ab-btn${top === name ? ' active' : ''}`} aria-label={label} onClick={go}>
        {top === name && <span className="ab-ind" />}
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <div className="xd-shell">
      <nav className="activity-bar">
        <div className="ab-logo">
          <XdMark size={28} />
        </div>
        <div className="ab-top">
          {rail('chat', '대화', <ChatIcon size={20} />, () => setRoute(agent ? { name: 'chat', agentId: agent.id, conversationId: null } : { name: 'home' }))}
          {rail('providers', 'AI 제공자', <ServerIcon size={20} />, () => setRoute({ name: 'providers' }))}
          {ideStore && <IdeActivity store={ideStore} />}
        </div>
        <div className="ab-bottom">{rail('settings', '설정', <SettingsIcon size={20} />, () => setRoute({ name: 'settings' }))}</div>
      </nav>
      <Sidebar
        agentId={agentId}
        conversationId={route.name === 'chat' ? route.conversationId : null}
        onOpenAgent={(id) => setRoute({ name: 'chat', agentId: id, conversationId: null })}
        onOpenConversation={(id, conversationId) => setRoute({ name: 'chat', agentId: id, conversationId })}
        onNewAgent={() => setRoute({ name: 'agent-new' })}
      />
      <main className="xd-main">{main}</main>
    </div>
  );
};

export const App: React.FC = () => (
  <DataProvider>
    <Shell />
  </DataProvider>
);
