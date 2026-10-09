/**
 * 대화 목록: 사이드바와 채팅 머리(대화 제목)가 같이 본다. 앱 틀(App)이 하나만 들고 있다.
 *
 * 다시 읽는 때: 도는 대화가 바뀔 때(새 대화가 생기거나 맨 위로 오른다), 턴이 끝날 때, 에이전트 목록이 바뀔 때
 * (이름이 바뀌거나 지워져 그 대화가 함께 사라진다), 열린 대화가 바뀔 때.
 */
import { useCallback, useEffect, useState } from 'react';
import type { XdAgent, XdConversationListItem } from '../../main/store';
import { xd } from './bridge';
import { useConversationListKey } from './live-store';

export interface ConversationList {
  items: XdConversationListItem[];
  loaded: boolean;
  update: (fn: (list: XdConversationListItem[]) => XdConversationListItem[]) => void;
}

export function useConversationList(agents: XdAgent[], openId: string | null): ConversationList {
  const key = useConversationListKey();
  const [items, setItems] = useState<XdConversationListItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    xd.conversations
      .listAll()
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setLoaded(true);
      })
      .catch((e) => console.warn('[xd] conversations', e));
    return () => {
      alive = false;
    };
  }, [key, agents, openId]);

  const update = useCallback((fn: (list: XdConversationListItem[]) => XdConversationListItem[]) => setItems(fn), []);
  return { items, loaded, update };
}
