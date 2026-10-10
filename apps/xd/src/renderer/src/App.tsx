/**
 * XD 앱 틀: 왼쪽 줄(대화·제공자·설정), 사이드바([최근 채팅]·[에이전트]), 본문.
 *
 * 대화를 시작하는 곳은 시작 화면이다(사이드바 [새 채팅], 아무 대화도 열려 있지 않을 때의 첫 화면). 제공자도
 * 에이전트도 없는 첫 실행에서만 그 자리에 첫 화면(Welcome)이 선다. 사이드바 [⋯] 는 본문에 채팅 기록 관리를 연다
 * (대화를 열거나 [새 채팅] 을 누르면 돌아간다).
 *
 * 화면은 XD 전용이다(2026-10-02 결정). Dex 와 같은 부품(마크다운·작업 과정·아이콘·스타일)은 `dex.ts` 로만 가져온다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { xd } from './bridge';
import { useConversationList } from './conversations';
import { DataProvider, useData } from './data';
import { ChatIcon, ServerIcon, SettingsIcon, Tooltip } from './dex';
import { forgetIdeStores, useIdeMode, useIdeStore } from './ide/ide-stores';
import { liveStore } from './live-store';
import type { AgentDraft } from './start-model';
import { AgentEditor } from './views/AgentEditor';
import { ChatView, type InitialMessage } from './views/ChatView';
import { ConversationManager } from './views/ConversationManager';
import { IdeActivity } from './views/IdeActivity';
import { ProvidersView } from './views/ProvidersView';
import { SettingsView } from './views/SettingsView';
import { Sidebar } from './views/Sidebar';
import { StartView } from './views/StartView';
import { Welcome } from './views/Welcome';
import { XdMark } from './views/XdMark';

export type Route =
  | { name: 'start' }
  | { name: 'chat'; agentId: string; conversationId: string | null; initialMessage?: InitialMessage }
  | { name: 'agent-new'; draft?: AgentDraft }
  | { name: 'agent-edit'; agentId: string; conversationId: string | null }
  | { name: 'history' }
  | { name: 'providers' }
  | { name: 'settings' };

type ChatRoute = Extract<Route, { name: 'chat' }>;

const START: Route = { name: 'start' };

/** 첫 메시지 하나의 열쇠(한 번만 보내려고). */
const messageKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const Shell: React.FC = () => {
  const { agents, accounts, loaded, error } = useData();
  const [route, setRoute] = useState<Route>(START);
  /** 마지막으로 본 대화. 제공자·설정 화면에서 [대화] 를 누르면 그리로 돌아간다. */
  const lastChat = useRef<ChatRoute | null>(null);

  // 턴 사건은 앱에 한 번만 듣는다 — 화면을 옮겨도 도는 답이 끊기지 않는다.
  useEffect(() => xd.onTurnEvent((event) => liveStore.apply(event)), []);

  // 지워진 에이전트의 작업 공간 IDE 는 정리한다 — 목록을 제대로 받았을 때만(시작에 실패해 빈 목록이면 저장 안 한 버퍼의
  // 사본까지 지우게 된다).
  useEffect(() => {
    if (loaded && !error) forgetIdeStores(agents.map((a) => a.id));
  }, [agents, loaded, error]);

  // 지워진 에이전트를 보고 있었다면 시작 화면으로.
  useEffect(() => {
    if ((route.name === 'chat' || route.name === 'agent-edit') && loaded && !agents.some((a) => a.id === route.agentId)) {
      setRoute(START);
    }
  }, [agents, loaded, route]);

  useEffect(() => {
    if (route.name === 'chat') lastChat.current = { name: 'chat', agentId: route.agentId, conversationId: route.conversationId };
  }, [route]);

  const openConversationId = route.name === 'chat' ? route.conversationId : null;
  const conversations = useConversationList(agents, openConversationId);

  // 작업 공간을 보고 있으면 활동 막대에 IDE 단추(탐색기·찾기·대화 칸)를 올린다.
  const chatAgentId = route.name === 'chat' ? route.agentId : null;
  const ideOn = useIdeMode(chatAgentId);
  const ideStore = useIdeStore(ideOn ? chatAgentId : null);

  if (error) return <div className="center">{error}</div>;
  if (!loaded) return <div className="center muted small">불러오는 중…</div>;

  const agentId = route.name === 'chat' || route.name === 'agent-edit' ? route.agentId : null;
  const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
  const top = route.name === 'providers' ? 'providers' : route.name === 'settings' ? 'settings' : 'chat';
  const openChat = (id: string, conversationId: string | null) => setRoute({ name: 'chat', agentId: id, conversationId });
  /** 지운 대화: 마지막으로 본 대화였으면 잊고, 열려 있었으면 시작 화면으로. */
  const forgetDeleted = (id: string) => {
    if (lastChat.current?.conversationId === id) lastChat.current = null;
    if (openConversationId === id) setRoute(START);
  };

  let main: React.ReactNode;
  if (route.name === 'chat' && agent) {
    const conversation = route.conversationId ? conversations.items.find((c) => c.id === route.conversationId) : undefined;
    main = (
      <ChatView
        key={agent.id}
        agent={agent}
        conversationId={route.conversationId}
        title={conversation?.title ?? ''}
        initialMessage={route.initialMessage ?? null}
        onConversation={(id) => openChat(agent.id, id)}
        onEditAgent={() => setRoute({ name: 'agent-edit', agentId: agent.id, conversationId: route.conversationId })}
      />
    );
  } else if (route.name === 'agent-new') {
    main = (
      <AgentEditor
        agent={null}
        draft={route.draft}
        onDone={(id) => setRoute(id ? { name: 'chat', agentId: id, conversationId: null } : START)}
        onProviders={() => setRoute({ name: 'providers' })}
      />
    );
  } else if (route.name === 'agent-edit' && agent) {
    const back = route.conversationId;
    main = (
      <AgentEditor
        key={agent.id}
        agent={agent}
        onDone={(id) => setRoute(id ? { name: 'chat', agentId: id, conversationId: back } : START)}
        onProviders={() => setRoute({ name: 'providers' })}
      />
    );
  } else if (route.name === 'history') {
    main = (
      <ConversationManager
        conversations={conversations.items}
        loaded={conversations.loaded}
        onConversations={conversations.update}
        onReload={conversations.reload}
        onOpen={openChat}
        onDeleted={forgetDeleted}
      />
    );
  } else if (route.name === 'providers') {
    main = <ProvidersView />;
  } else if (route.name === 'settings') {
    main = <SettingsView />;
  } else if (accounts.length === 0 && agents.length === 0) {
    main = <Welcome onProviders={() => setRoute({ name: 'providers' })} onStart={() => setRoute(START)} />;
  } else {
    main = (
      <StartView
        onStart={(id, text) => setRoute({ name: 'chat', agentId: id, conversationId: null, initialMessage: { key: messageKey(), text } })}
        onProviders={() => setRoute({ name: 'providers' })}
        onFullEditor={(draft) => setRoute({ name: 'agent-new', draft })}
      />
    );
  }

  const goChat = () => {
    if (route.name === 'chat' || route.name === 'start') return;
    const last = lastChat.current;
    setRoute(last && agents.some((a) => a.id === last.agentId) ? last : START);
  };

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
          {rail('chat', '대화', <ChatIcon size={20} />, goChat)}
          {rail('providers', 'AI 제공자', <ServerIcon size={20} />, () => setRoute({ name: 'providers' }))}
          {ideStore && <IdeActivity store={ideStore} />}
        </div>
        <div className="ab-bottom">{rail('settings', '설정', <SettingsIcon size={20} />, () => setRoute({ name: 'settings' }))}</div>
      </nav>
      <Sidebar
        conversations={conversations.items}
        agentGroups={conversations.agents}
        loaded={conversations.loaded}
        onConversations={conversations.update}
        conversationId={openConversationId}
        starting={route.name === 'start'}
        managing={route.name === 'history'}
        onNewChat={() => setRoute(START)}
        onManageHistory={() => setRoute({ name: 'history' })}
        onOpenConversation={openChat}
        onDeleted={forgetDeleted}
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
