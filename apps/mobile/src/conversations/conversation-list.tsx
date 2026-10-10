/**
 * [채팅 목록] (2026-10-09): 폰의 첫 화면. ChatGPT·Claude 처럼 **대화 단위, 마지막으로 말한 순서**.
 *
 *   [+ 새 채팅]                         [검색] [⋯]   ⋯ = 채팅 기록 관리 · 에이전트가 사라진 채팅 제거 (N)
 *   최근 채팅 v                                      머리를 누르면 접고 편다
 *     에이전트 이름(작게) [꼬리표]
 *     대화 제목                                [⋯]   5개, [더 보기] 로 5개씩
 *     [더 보기] [접기]
 *   ──────
 *   에이전트 v
 *     이름                                   3      5개, [더 보기] 로 5개씩
 *     마지막 대화 제목 · 날
 *     [더 보기] [접기]
 *
 * (2026-10-10) 몸통이 웹·Dex 전 표면과 같은 [최근 채팅] · [에이전트] 다(@dex/protocol conversation-agents).
 * 최근 채팅은 40개씩 받아 두고 5개부터 보인다. [더 보기] 에 모자라면 다음 쪽을 받는다. 에이전트 줄을 누르면
 * 그 에이전트의 대화 화면([←] 이름)으로 들어간다. 새 채팅은 맨 위 [+ 새 채팅] 으로만 연다(에이전트마다의
 * [+] 와 [다른 에이전트] 는 뺐다). 접은 칸은 기기에 적어 두어 앱을 다시 켜도 접혀 있다.
 * 줄의 말과 목록 고치기는 conversation-model 이 묶는다. 줄을 길게 누르거나 [⋯] 를 누르면 [이름 바꾸기]·[삭제].
 * 바꾼 것은 최근 채팅·에이전트·들어간 화면에 함께 싣는다(applyChatListChanges). 에이전트가 사라진 대화는
 * 열면 기록만 보인다. 돋보기는 채팅 검색(conversation-search)을 연다. [⋯] 는 메뉴다: [채팅 기록 관리] 가
 * 관리 화면(conversation-manager)을 열고, [에이전트가 사라진 채팅 제거 (N)] 는 묻고 지운다(관리 화면에도 있다).
 * 보일 때마다, 그리고 당겨서 새로고침하면 최근 채팅과 에이전트 묶음을 다시 읽는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DELETED_AGENT_LABEL,
  RECENT_CONVERSATION_STEP,
  conversationDisplayTitle,
  conversationKey,
  type Conversation,
  type ConversationAgent,
  type ConversationListChange,
} from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import { diagLog } from '../lib/diag';
import { ScreenModal } from '../lib/screen-modal';
import type { XgenMobileClient } from '../lib/xgen';
import {
  CONVERSATION_TEXT,
  LIST_TEXT,
  MANAGER_TEXT,
  agentRow,
  applyChatListChanges,
  applyConversationPage,
  chatListItems,
  conversationRow,
  moreRecent,
  purgeDoneNotice,
  purgeLabel,
  purgeQuestion,
  withDrillPage,
  type ChatListItem,
  type ChatLists,
  type ListSection,
} from './conversation-model';
import { ConversationSearch } from './conversation-search';
import { ConversationManager } from './conversation-manager';
import { ConversationSheet } from './conversation-sheet';

/** 한 번에 받는 대화 수(최근 채팅·에이전트의 대화 모두). */
const PAGE_SIZE = 40;

/** 접은 칸을 적어 두는 자리({ recent, agents }). */
const CLOSED_KEY = 'chat-list-closed';

type Styles = ReturnType<typeof makeStyles>;

/** 대화 한 줄. 위쪽 작은 글은 에이전트 이름(에이전트의 대화 화면에서는 날)이다. */
function ConversationLine({
  c,
  active,
  showDay,
  onOpen,
  onMenu,
  st,
}: {
  c: Conversation;
  active: boolean;
  showDay: boolean;
  onOpen: (c: Conversation) => void;
  onMenu: (c: Conversation) => void;
  st: Styles;
}): React.ReactElement {
  const p = useP();
  const row = conversationRow(c);
  return (
    <Pressable
      onPress={() => onOpen(c)}
      onLongPress={() => onMenu(c)}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${row.title} 열기`}
      style={({ pressed }) => [st.row, active && st.rowActive, pressed && st.rowPressed]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={st.meta}>
          {showDay ? (
            <Text style={st.agent} numberOfLines={1}>
              {row.day}
            </Text>
          ) : (
            <Text style={[st.agent, row.agentDeleted && st.agentDeleted]} numberOfLines={1}>
              {row.agent}
            </Text>
          )}
          {row.tag ? (
            <Text style={st.tag} numberOfLines={1}>
              {row.tag}
            </Text>
          ) : null}
        </View>
        <Text style={[st.title, active && { color: p.primary }]} numberOfLines={1}>
          {row.title}
        </Text>
      </View>
      <Pressable
        onPress={() => onMenu(c)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${row.title} 더 보기`}
        style={st.more}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color={p.muted} />
      </Pressable>
    </Pressable>
  );
}

export function ConversationsSection({
  client,
  visible,
  activeKey,
  onOpen,
  onNewChat,
  onRemoved,
  onRenamed,
  onPurged,
}: {
  client: XgenMobileClient;
  /** 보일 때마다 첫 쪽과 에이전트를 다시 읽는다(다른 화면에서 말한 대화가 위로 온다). */
  visible: boolean;
  /** 지금 열린 대화(conversationKey). 그 줄을 표시한다. */
  activeKey: string;
  onOpen: (c: Conversation) => void;
  /** 시작 화면으로(맨 위 [+ 새 채팅]). */
  onNewChat: () => void;
  /** 대화를 지웠다. 열려 있던 대화면 채팅 화면을 비운다. */
  onRemoved: (c: Conversation) => void;
  /** 이름이 바뀌었다. 열려 있던 대화면 머리의 제목도 바꾼다. */
  onRenamed: (c: Conversation, title: string) => void;
  /** 에이전트가 사라진 채팅을 한꺼번에 지웠다. */
  onPurged: () => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [lists, setLists] = useState<ChatLists>({ recent: null, agents: null, drill: null });
  const listsRef = useRef(lists);
  listsRef.current = lists;
  /** [최근 채팅] 에 보이는 수. */
  const [shown, setShown] = useState(RECENT_CONVERSATION_STEP);
  /** [에이전트] 에 보이는 수. */
  const [agentsShown, setAgentsShown] = useState(RECENT_CONVERSATION_STEP);
  /** 접은 칸. 기기에 적어 둔다. */
  const [closed, setClosed] = useState<Record<ListSection, boolean>>({ recent: false, agents: false });
  /** 적어 둔 값을 읽기 전에 눌렀으면 읽은 값으로 덮지 않는다. */
  const closedTouched = useRef(false);
  const [loading, setLoading] = useState(false);
  /** 당겨서 새로고침 중(보일 때마다 읽는 것은 위 손잡이를 띄우지 않는다). */
  const [pulling, setPulling] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [error, setError] = useState('');
  const [agentsError, setAgentsError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** [⋯] 를 연 대화(목록과 에이전트의 대화 화면이 함께 쓴다). */
  const [menu, setMenu] = useState<Conversation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  // ── 에이전트의 대화 화면 ──
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillPulling, setDrillPulling] = useState(false);
  const [drillMore, setDrillMore] = useState(false);
  const drillMoreRef = useRef(false);
  const [drillError, setDrillError] = useState('');
  /** 처음부터 다시 읽을 때마다 올린다. 늦게 온 앞 응답(다음 쪽 포함)은 버린다. */
  const seq = useRef(0);
  const agentsSeq = useRef(0);
  const drillSeq = useRef(0);

  const load = useCallback(
    async (mode: 'reset' | 'head') => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const page = await client.api.history.conversationPage({ limit: PAGE_SIZE });
        if (my !== seq.current) return;
        setLists((cur) => ({ ...cur, recent: applyConversationPage(cur.recent, page, mode) }));
        setError('');
      } catch (e) {
        if (my !== seq.current) return;
        const msg = friendlyError(e, '채팅 목록을 불러오지 못했습니다.');
        diagLog(`채팅 목록 실패: ${msg}`);
        setError(msg);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [client],
  );

  const loadMore = useCallback(async () => {
    const cur = listsRef.current.recent;
    if (!cur?.cursor || loadingMoreRef.current) return;
    const my = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, cursor: cur.cursor });
      if (my !== seq.current) return;
      setLists((c) => (c.recent ? { ...c, recent: applyConversationPage(c.recent, page, 'append') } : c));
    } catch (e) {
      if (my === seq.current) setNotice(friendlyError(e, '다음 채팅을 불러오지 못했습니다.'));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [client]);

  const loadAgents = useCallback(async () => {
    const my = ++agentsSeq.current;
    try {
      const agents = await client.api.history.conversationAgents();
      if (my !== agentsSeq.current) return;
      setLists((cur) => ({ ...cur, agents }));
      setAgentsError('');
    } catch (e) {
      if (my !== agentsSeq.current) return;
      const msg = friendlyError(e, '에이전트 목록을 불러오지 못했습니다.');
      diagLog(`에이전트 묶음 실패: ${msg}`);
      setAgentsError(msg);
    }
  }, [client]);

  const loadDrill = useCallback(
    async (workflowId: string, mode: 'reset' | 'head') => {
      const my = ++drillSeq.current;
      setDrillLoading(true);
      try {
        const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, workflowId });
        if (my !== drillSeq.current) return;
        setLists((cur) => withDrillPage(cur, workflowId, page, mode));
        setDrillError('');
      } catch (e) {
        if (my === drillSeq.current) setDrillError(friendlyError(e, '채팅 목록을 불러오지 못했습니다.'));
      } finally {
        if (my === drillSeq.current) setDrillLoading(false);
      }
    },
    [client],
  );

  const loadDrillMore = useCallback(async () => {
    const drill = listsRef.current.drill;
    const cursor = drill?.list?.cursor;
    if (!drill || !cursor || drillMoreRef.current) return;
    const workflowId = drill.agent.workflowId;
    const my = drillSeq.current;
    drillMoreRef.current = true;
    setDrillMore(true);
    try {
      const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, workflowId, cursor });
      if (my !== drillSeq.current) return;
      setLists((cur) => withDrillPage(cur, workflowId, page, 'append'));
    } catch (e) {
      if (my === drillSeq.current) setDrillError(friendlyError(e, '다음 채팅을 불러오지 못했습니다.'));
    } finally {
      drillMoreRef.current = false;
      setDrillMore(false);
    }
  }, [client]);

  const openDrill = useCallback(
    (agent: ConversationAgent) => {
      setLists((cur) => ({ ...cur, drill: { agent, list: null } }));
      setDrillError('');
      void loadDrill(agent.workflowId, 'reset');
    },
    [loadDrill],
  );

  const closeDrill = useCallback(() => {
    drillSeq.current += 1;
    setDrillLoading(false);
    setMenu(null);
    setLists((cur) => ({ ...cur, drill: null }));
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load(listsRef.current.recent ? 'head' : 'reset');
    void loadAgents();
  }, [visible, load, loadAgents]);

  useEffect(() => {
    void AsyncStorage.getItem(CLOSED_KEY)
      .then((raw) => {
        if (!raw || closedTouched.current) return;
        const saved = JSON.parse(raw) as Partial<Record<ListSection, unknown>>;
        setClosed({ recent: saved.recent === true, agents: saved.agents === true });
      })
      .catch(() => undefined);
  }, []);

  const toggleSection = useCallback((section: ListSection) => {
    closedTouched.current = true;
    setClosed((cur) => ({ ...cur, [section]: !cur[section] }));
  }, []);

  useEffect(() => {
    if (!closedTouched.current) return;
    void AsyncStorage.setItem(CLOSED_KEY, JSON.stringify(closed)).catch(() => undefined);
  }, [closed]);

  /** 소식(또는 이 화면에서 바꾼 것)을 세 목록에 싣고, 모르는 것은 다시 읽는다. */
  const applyChanges = useCallback(
    (changes: ConversationListChange[]) => {
      if (!changes.length) return;
      const next = applyChatListChanges(listsRef.current, changes);
      setLists((cur) => applyChatListChanges(cur, changes).lists);
      if (next.reloadRecent) void load('head');
      if (next.reloadAgents) void loadAgents();
      const drill = listsRef.current.drill;
      if (next.reloadDrill && drill) void loadDrill(drill.agent.workflowId, 'head');
    },
    [load, loadAgents, loadDrill],
  );

  const renamed = useCallback(
    (c: Conversation, title: string, customTitle: boolean) => {
      applyChanges([{ type: 'renamed', workflowId: c.workflowId, interactionId: c.interactionId, title, customTitle }]);
      onRenamed(c, title);
    },
    [applyChanges, onRenamed],
  );

  const removed = useCallback(
    (gone: Conversation[]) => {
      applyChanges(gone.map((c) => ({ type: 'removed', workflowId: c.workflowId, interactionId: c.interactionId })));
      for (const c of gone) onRemoved(c);
    },
    [applyChanges, onRemoved],
  );

  const purged = useCallback(() => {
    void load('reset');
    void loadAgents();
    const drill = listsRef.current.drill;
    if (drill) void loadDrill(drill.agent.workflowId, 'reset');
    onPurged();
  }, [load, loadAgents, loadDrill, onPurged]);

  const rename = useCallback(
    async (c: Conversation, title: string) => {
      const res = await client.api.history.renameConversation(c.workflowId, c.interactionId, title);
      renamed(c, res.title, res.customTitle);
    },
    [client, renamed],
  );

  const confirmRemove = useCallback(
    (c: Conversation) => {
      setMenu(null);
      Alert.alert(conversationDisplayTitle(c), '이 채팅을 삭제할까요?', [
        { text: '취소', style: 'cancel' },
        {
          text: CONVERSATION_TEXT.remove,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await client.api.history.deleteConversation(c.workflowId, c.interactionId, c.workflowName);
                removed([c]);
              } catch (e) {
                const msg = friendlyError(e, '채팅을 삭제하지 못했습니다.');
                if (listsRef.current.drill) setDrillError(msg);
                else setNotice(msg);
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ]);
    },
    [client, removed],
  );

  const deletedCount = lists.recent?.deletedCount ?? 0;
  const confirmPurge = useCallback(() => {
    if (deletedCount <= 0) {
      setNotice(CONVERSATION_TEXT.purgeNone);
      return;
    }
    Alert.alert(CONVERSATION_TEXT.purgeConfirmTitle, purgeQuestion(deletedCount), [
      { text: '취소', style: 'cancel' },
      {
        text: '제거',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const n = await client.api.history.purgeDeletedAgentConversations();
              setNotice(purgeDoneNotice(n));
              purged();
            } catch (e) {
              setNotice(friendlyError(e, MANAGER_TEXT.purgeFailed));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }, [client, deletedCount, purged]);

  /** 목록 머리 [⋯]: 웹·데스크톱과 같은 자리의 목록 메뉴. 관리 화면은 [채팅 기록 관리] 로만 연다. */
  const openListMenu = useCallback(() => {
    Alert.alert(CONVERSATION_TEXT.listMenu, undefined, [
      { text: MANAGER_TEXT.title, onPress: () => setManagerOpen(true) },
      { text: purgeLabel(deletedCount), style: deletedCount > 0 ? 'destructive' : 'default', onPress: confirmPurge },
      { text: '닫기', style: 'cancel' },
    ]);
  }, [confirmPurge, deletedCount]);

  /** [더 보기]: 5개 더. 받아 둔 것이 모자라면 다음 쪽을 받는다. */
  const showMore = useCallback(() => {
    const cur = listsRef.current.recent;
    const next = moreRecent(shown, cur?.items.length ?? 0, cur?.cursor ?? null);
    setShown(next.shown);
    if (next.fetch) void loadMore();
  }, [shown, loadMore]);

  /** [에이전트] 의 [더 보기]: 5개 더(묶음은 다 받아 둔다). */
  const showMoreAgents = useCallback(() => {
    setAgentsShown((n) => moreRecent(n, listsRef.current.agents?.length ?? 0, null).shown);
  }, []);

  const refreshAll = useCallback(() => {
    setPulling(true);
    void Promise.all([load('reset'), loadAgents()]).finally(() => setPulling(false));
  }, [load, loadAgents]);

  const body = useMemo(
    () =>
      chatListItems({
        recent: lists.recent,
        recentError: error,
        shown,
        agents: lists.agents,
        agentsError,
        agentsShown,
        closed,
      }),
    [lists.recent, lists.agents, error, shown, agentsError, agentsShown, closed],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatListItem }) => {
      switch (item.kind) {
        case 'title':
          return (
            <Pressable
              onPress={() => toggleSection(item.section)}
              accessibilityRole="button"
              accessibilityState={{ expanded: item.open }}
              style={({ pressed }) => [
                st.sectionHead,
                item.section === 'agents' && st.sectionDivided,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={st.sectionTitle}>{item.text}</Text>
              <Ionicons
                name="chevron-down"
                size={15}
                color={p.muted}
                style={item.open ? undefined : { transform: [{ rotate: '-90deg' }] }}
              />
            </Pressable>
          );
        case 'conversation':
          return (
            <ConversationLine
              c={item.conversation}
              active={conversationKey(item.conversation) === activeKey}
              showDay={false}
              onOpen={onOpen}
              onMenu={setMenu}
              st={st}
            />
          );
        case 'more': {
          const recent = item.section === 'recent';
          return (
            <View style={st.moreBar}>
              {item.more ? (
                <Pressable
                  onPress={recent ? showMore : showMoreAgents}
                  disabled={recent && loadingMore}
                  accessibilityRole="button"
                  style={st.textBtn}
                >
                  {recent && loadingMore ? (
                    <ActivityIndicator color={p.muted} />
                  ) : (
                    <Text style={st.textBtnText}>{LIST_TEXT.more}</Text>
                  )}
                </Pressable>
              ) : null}
              {item.less ? (
                <Pressable
                  onPress={() => (recent ? setShown(RECENT_CONVERSATION_STEP) : setAgentsShown(RECENT_CONVERSATION_STEP))}
                  accessibilityRole="button"
                  style={st.textBtn}
                >
                  <Text style={st.textBtnText}>{LIST_TEXT.less}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }
        case 'agent': {
          const row = item.row;
          return (
            <Pressable
              onPress={() => openDrill(row.agent)}
              accessibilityRole="button"
              accessibilityLabel={row.name}
              style={({ pressed }) => [st.row, st.agentRow, pressed && st.rowPressed]}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={st.meta}>
                  {row.deleted ? <Text style={[st.agent, st.agentDeleted]}>{DELETED_AGENT_LABEL}</Text> : null}
                  <Text style={[st.agentName, row.deleted && { color: p.muted }]} numberOfLines={1}>
                    {row.name}
                  </Text>
                </View>
                <Text style={st.agentSub} numberOfLines={1}>
                  {row.sub}
                </Text>
              </View>
              <Text style={st.count}>{row.count}</Text>
            </Pressable>
          );
        }
        case 'note':
          if (item.spinner) return <ActivityIndicator style={{ marginVertical: 10 }} color={p.primary} />;
          return item.retry ? (
            <Pressable onPress={() => void loadAgents()} accessibilityRole="button" style={st.noteBox}>
              <Text style={[st.note, item.danger && { color: p.danger }]}>{item.text}</Text>
              <Text style={st.textBtnText}>다시 시도</Text>
            </Pressable>
          ) : (
            <Text style={[st.note, item.danger && { color: p.danger }]}>{item.text}</Text>
          );
      }
    },
    [activeKey, loadAgents, loadingMore, onOpen, openDrill, p, showMore, showMoreAgents, st, toggleSection],
  );

  const drill = lists.drill;
  // 머리의 이름은 묶음의 최신 줄을 따른다(들어간 뒤 이름이 바뀌었을 수 있다).
  const drillAgent = drill ? (lists.agents?.find((a) => a.workflowId === drill.agent.workflowId) ?? drill.agent) : null;
  const drillRow = drillAgent ? agentRow(drillAgent) : null;

  const sheet = (
    <ConversationSheet conversation={menu} onRename={rename} onRemove={confirmRemove} onClose={() => setMenu(null)} />
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={st.toolbar}>
        <Pressable
          onPress={() => onNewChat()}
          accessibilityRole="button"
          style={({ pressed }) => [st.newChat, pressed && { opacity: 0.8 }]}
        >
          <Text style={st.newChatText}>{CONVERSATION_TEXT.newChat}</Text>
        </Pressable>
        <Pressable
          onPress={() => setSearchOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="채팅 검색"
          style={({ pressed }) => [st.listMore, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="search" size={19} color={p.text} />
        </Pressable>
        <Pressable
          onPress={openListMenu}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="채팅 목록 메뉴"
          style={({ pressed }) => [st.listMore, (pressed || busy) && { opacity: 0.6 }]}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={p.text} />
        </Pressable>
      </View>

      <FlatList
        data={body}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={st.list}
        // 당겨서 새로고침: 처음부터 다시 받는다(에이전트 묶음도).
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refreshAll} tintColor={p.muted} />}
        ListHeaderComponent={
          notice || error ? (
            <View style={{ gap: 8, marginBottom: 4 }}>
              {notice ? (
                <Pressable onPress={() => setNotice('')} style={st.noticeBox}>
                  <Text style={st.noticeText}>{notice}</Text>
                </Pressable>
              ) : null}
              {error ? (
                <View style={st.noticeBox}>
                  <Text style={[st.noticeText, { color: p.danger }]}>{error}</Text>
                  <Pressable
                    onPress={() => void load(lists.recent ? 'head' : 'reset')}
                    disabled={loading}
                    style={st.retry}
                    accessibilityRole="button"
                  >
                    {loading ? (
                      <ActivityIndicator color={p.muted} />
                    ) : (
                      <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>다시 시도</Text>
                    )}
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null
        }
      />

      <ConversationSearch
        client={client}
        visible={searchOpen}
        recent={lists.recent?.items ?? []}
        onOpen={(c) => {
          setSearchOpen(false);
          onOpen(c);
        }}
        onClose={() => setSearchOpen(false)}
      />

      <ConversationManager
        client={client}
        visible={managerOpen}
        onClose={() => {
          setManagerOpen(false);
          // 거기서 지운 것 중 받아 두지 않은 대화도 있다. 첫 쪽을 다시 읽어 사라진 채팅 수까지 맞춘다.
          void load('head');
        }}
        onOpen={(c) => {
          setManagerOpen(false);
          onOpen(c);
        }}
        onRenamed={renamed}
        onRemoved={removed}
        onPurged={purged}
      />

      {/* 에이전트의 대화: [←] 이름. 기기의 뒤로 단추도 목록으로 돌아간다. */}
      <ScreenModal
        visible={!!drill}
        title={drillRow?.name ?? ''}
        subtitle={drillRow?.deleted ? CONVERSATION_TEXT.deletedAgentNotice : undefined}
        onClose={closeDrill}
      >
        <FlatList
          data={drill?.list?.items ?? []}
          keyExtractor={conversationKey}
          renderItem={({ item: c }) => (
            <ConversationLine
              c={c}
              active={conversationKey(c) === activeKey}
              showDay
              onOpen={(x) => {
                closeDrill();
                onOpen(x);
              }}
              onMenu={setMenu}
              st={st}
            />
          )}
          contentContainerStyle={st.list}
          onEndReachedThreshold={0.4}
          onEndReached={() => void loadDrillMore()}
          refreshControl={
            <RefreshControl
              refreshing={drillPulling}
              onRefresh={() => {
                if (!drill) return;
                setDrillPulling(true);
                void loadDrill(drill.agent.workflowId, 'reset').finally(() => setDrillPulling(false));
              }}
              tintColor={p.muted}
            />
          }
          ListHeaderComponent={
            drillError ? (
              <View style={[st.noticeBox, { marginBottom: 4 }]}>
                <Text style={[st.noticeText, { color: p.danger }]}>{drillError}</Text>
                <Pressable
                  onPress={() => drill && void loadDrill(drill.agent.workflowId, drill.list ? 'head' : 'reset')}
                  disabled={drillLoading}
                  style={st.retry}
                  accessibilityRole="button"
                >
                  {drillLoading ? (
                    <ActivityIndicator color={p.muted} />
                  ) : (
                    <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>다시 시도</Text>
                  )}
                </Pressable>
              </View>
            ) : null
          }
          ListEmptyComponent={
            !drill?.list ? (
              drillError ? null : <ActivityIndicator style={{ marginTop: 24 }} color={p.primary} />
            ) : (
              <Text style={st.empty}>{LIST_TEXT.agentEmpty}</Text>
            )
          }
          ListFooterComponent={drillMore ? <ActivityIndicator style={{ margin: 16 }} color={p.primary} /> : null}
        />
        {/* 이 화면 위에 뜨도록 시트를 화면 안에 그린다. */}
        {drill ? sheet : null}
      </ScreenModal>

      {/* 한 줄의 [⋯]: 이름 바꾸기 · 삭제 */}
      {drill ? null : sheet}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    toolbar: {
      padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: p.panel, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    listMore: {
      width: TAP, height: TAP, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: p.border,
    },
    newChat: {
      flex: 1, minHeight: TAP, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: alpha(p.primary, 14), borderWidth: 1, borderColor: alpha(p.primary, 40),
    },
    newChatText: { color: p.primary, fontSize: 15, fontWeight: '800' },
    list: { padding: 12, paddingBottom: 24, gap: 8 },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TAP, paddingHorizontal: 4 },
    sectionDivided: { borderTopWidth: 1, borderTopColor: p.border, marginTop: 12, paddingTop: 12 },
    sectionTitle: { color: p.text, fontSize: 15, fontWeight: '800' },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14,
      paddingLeft: 14, paddingRight: 4, paddingVertical: 10, minHeight: 60,
    },
    rowActive: { borderColor: alpha(p.primary, 60), backgroundColor: alpha(p.primary, 8) },
    rowPressed: { backgroundColor: alpha(p.primary, 16) },
    agentRow: { paddingRight: 14 },
    meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
    agent: { color: p.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 },
    agentDeleted: {
      color: p.danger, backgroundColor: alpha(p.danger, 12), borderRadius: 6,
      paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', flexShrink: 0,
    },
    tag: {
      fontSize: 10.5, fontWeight: '700', color: p.primary,
      backgroundColor: alpha(p.primary, 14), borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
      overflow: 'hidden',
    },
    title: { color: p.text, fontSize: 15, fontWeight: '700' },
    more: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
    moreBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    textBtn: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center', backgroundColor: p.panel2 },
    textBtnText: { color: p.primary, fontSize: 13.5, fontWeight: '700' },
    agentName: { color: p.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
    agentSub: { color: p.muted, fontSize: 12.5 },
    count: { color: p.muted, fontSize: 13, fontWeight: '600', minWidth: 18, textAlign: 'right' },
    note: { color: p.muted, fontSize: 13.5, paddingHorizontal: 4, paddingVertical: 6 },
    noteBox: { gap: 4, paddingVertical: 4 },
    noticeBox: { padding: 10, borderRadius: 10, backgroundColor: p.panel2, gap: 8 },
    noticeText: { color: p.text, fontSize: 13 },
    retry: { alignSelf: 'flex-start', backgroundColor: p.panel, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
    empty: { color: p.muted, fontSize: 14, textAlign: 'center', padding: 24 },
  });
}
