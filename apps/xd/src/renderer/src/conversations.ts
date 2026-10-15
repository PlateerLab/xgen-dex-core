/**
 * 대화 목록: 사이드바([최근 채팅]·[에이전트])와 채팅 머리(대화 제목), 채팅 기록 관리가 같이 본다. 앱 틀(App)이 하나만
 * 들고 있다. 에이전트 묶음(에이전트마다 대화 수·마지막 대화)도 같은 때에 함께 읽는다.
 *
 * 다시 읽는 때: 도는 대화가 바뀔 때(새 대화가 생기거나 맨 위로 오른다), 턴이 끝날 때, 에이전트 목록이 바뀔 때
 * (이름이 바뀌거나 지워져 그 대화가 함께 사라진다), 열린 대화가 바뀔 때, 화면이 목록을 고쳤을 때(이름 바꾸기·지우기).
 */
import { useCallback, useEffect, useState } from 'react';
import type { XdAgent, XdConversationAgent, XdConversationListItem } from '../../main/store';
import { xd } from './bridge';
import { useConversationListKey } from './live-store';

export interface ConversationList {
  items: XdConversationListItem[];
  /** 대화가 있는 에이전트(사이드바 [에이전트]), 마지막으로 말한 순서. */
  agents: XdConversationAgent[];
  loaded: boolean;
  /** 목록을 바로 고치고(이름 바꾸기·지우기), 묶음과 함께 다시 읽는다. */
  update: (fn: (list: XdConversationListItem[]) => XdConversationListItem[]) => void;
  /** 다시 읽기만. */
  reload: () => void;
}

export function useConversationList(agents: XdAgent[], openId: string | null): ConversationList {
  const key = useConversationListKey();
  const [items, setItems] = useState<XdConversationListItem[]>([]);
  const [groups, setGroups] = useState<XdConversationAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([xd.conversations.listAll(), xd.conversations.agents()])
      .then(([list, byAgent]) => {
        if (!alive) return;
        setItems(list);
        setGroups(byAgent);
        setLoaded(true);
      })
      .catch((e) => console.warn('[xd] conversations', e));
    return () => {
      alive = false;
    };
  }, [key, agents, openId, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const update = useCallback(
    (fn: (list: XdConversationListItem[]) => XdConversationListItem[]) => {
      setItems(fn);
      reload();
    },
    [reload],
  );
  return { items, agents: groups, loaded, update, reload };
}

/**
 * 에이전트 하나의 대화(사이드바에서 에이전트를 눌러 들어간 목록), 목록과 같은 순서. 전체 목록이 바뀔 때마다 다시
 * 읽는다. 처음 읽기 전에는 null.
 */
export function useAgentConversations(agentId: string | null, all: XdConversationListItem[]): XdConversationListItem[] | null {
  const [state, setState] = useState<{ agentId: string; items: XdConversationListItem[] } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    xd.conversations
      .listAll(null, agentId)
      .then((items) => alive && setState({ agentId, items }))
      .catch((e) => console.warn('[xd] agent conversations', e));
    return () => {
      alive = false;
    };
  }, [agentId, all]);

  return agentId && state?.agentId === agentId ? state.items : null;
}
