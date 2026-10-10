/**
 * [채팅 목록] (2026-10-09): 폰의 첫 화면. ChatGPT·Claude 처럼 **대화 단위, 마지막으로 말한 순서**.
 *
 *   [+ 새 채팅]                         [검색] [⋯]  채팅 검색 · 에이전트가 사라진 채팅 제거 (N)
 *   에이전트 이름(작게) [꼬리표]
 *   대화 제목                                  [⋯]
 *
 * 순서는 서버가 정한다(받은 그대로). 40개씩 받고 끝에 닿으면 다음 쪽을 잇는다. 줄의 말과 목록 고치기는
 * @dex/protocol 의 conversation-list 가 정본이다(conversation-model 이 묶는다).
 * 줄을 길게 누르거나 [⋯] 를 누르면 [이름 바꾸기]·[삭제]. 에이전트가 사라진 대화는 열면 기록만 보인다.
 * 돋보기(2026-10-10)는 채팅 검색 화면을 연다(conversation-search). 고른 대화는 줄을 누른 것과 같이 열린다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { conversationDisplayTitle, conversationKey, type Conversation } from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import { diagLog } from '../lib/diag';
import type { XgenMobileClient } from '../lib/xgen';
import {
  CONVERSATION_TEXT,
  applyConversationPage,
  conversationRow,
  dropConversation,
  purgeLabel,
  renameInState,
  type ConversationListState,
} from './conversation-model';
import { ConversationSearch } from './conversation-search';

/** 한 번에 받는 대화 수. */
const PAGE_SIZE = 40;

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
  /** 보일 때마다 첫 쪽을 다시 읽는다(다른 화면에서 말한 대화가 위로 온다). */
  visible: boolean;
  /** 지금 열린 대화(conversationKey). 그 줄을 표시한다. */
  activeKey: string;
  onOpen: (c: Conversation) => void;
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
  const [list, setList] = useState<ConversationListState | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const [loading, setLoading] = useState(false);
  /** 당겨서 새로고침 중(보일 때마다 읽는 것은 위 손잡이를 띄우지 않는다). */
  const [pulling, setPulling] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** [⋯] 를 연 대화. */
  const [menu, setMenu] = useState<Conversation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 이름을 바꾸는 중이면 그 글. null 이면 메뉴 단계. */
  const [renameText, setRenameText] = useState<string | null>(null);
  const [renameError, setRenameError] = useState('');
  /** 처음부터 다시 읽을 때마다 올린다. 늦게 온 앞 응답(다음 쪽 포함)은 버린다. */
  const seq = useRef(0);

  const load = useCallback(
    async (mode: 'reset' | 'head') => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const page = await client.api.history.conversationPage({ limit: PAGE_SIZE });
        if (my !== seq.current) return;
        setList((cur) => applyConversationPage(cur, page, mode));
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
    const cur = listRef.current;
    if (!cur?.cursor || loadingMoreRef.current) return;
    const my = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, cursor: cur.cursor });
      if (my !== seq.current) return;
      setList((c) => (c ? applyConversationPage(c, page, 'append') : c));
    } catch (e) {
      if (my === seq.current) setNotice(friendlyError(e, '다음 채팅을 불러오지 못했습니다.'));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [client]);

  useEffect(() => {
    if (visible) void load(listRef.current ? 'head' : 'reset');
  }, [visible, load]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setRenameText(null);
    setRenameError('');
  }, []);

  const saveRename = useCallback(async () => {
    const c = menu;
    if (!c || renameText == null) return;
    const next = renameText.trim();
    if (next === c.title.trim()) {
      closeMenu();
      return;
    }
    setBusy(true);
    setRenameError('');
    try {
      const res = await client.api.history.renameConversation(c.workflowId, c.interactionId, next);
      setList((cur) => (cur ? renameInState(cur, c, res.title, res.customTitle) : cur));
      onRenamed(c, res.title);
      closeMenu();
    } catch (e) {
      setRenameError(friendlyError(e, '이름을 바꾸지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }, [client, menu, renameText, closeMenu, onRenamed]);

  const confirmRemove = useCallback(
    (c: Conversation) => {
      closeMenu();
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
                setList((cur) => (cur ? dropConversation(cur, c) : cur));
                onRemoved(c);
              } catch (e) {
                setNotice(friendlyError(e, '채팅을 삭제하지 못했습니다.'));
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ]);
    },
    [client, closeMenu, onRemoved],
  );

  const deletedCount = list?.deletedCount ?? 0;
  const confirmPurge = useCallback(() => {
    if (deletedCount <= 0) return;
    Alert.alert(CONVERSATION_TEXT.purgeConfirmTitle, `채팅 ${deletedCount}개를 삭제할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '제거',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const n = await client.api.history.purgeDeletedAgentConversations();
              setNotice(`채팅 ${n}개를 지웠습니다.`);
              onPurged();
              await load('reset');
            } catch (e) {
              setNotice(friendlyError(e, '채팅을 지우지 못했습니다.'));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }, [client, deletedCount, load, onPurged]);

  /** 목록 머리 [⋯]: 웹·데스크톱과 같은 자리의 목록 메뉴. 항목은 [에이전트가 사라진 채팅 제거 (N)] 하나다. */
  const openListMenu = useCallback(() => {
    if (deletedCount <= 0) {
      Alert.alert('채팅 목록', '정리할 채팅이 없습니다.');
      return;
    }
    Alert.alert('채팅 목록', undefined, [
      { text: purgeLabel(deletedCount), style: 'destructive', onPress: confirmPurge },
      { text: '닫기', style: 'cancel' },
    ]);
  }, [confirmPurge, deletedCount]);

  const renderItem = useCallback(
    ({ item: c }: { item: Conversation }) => {
      const row = conversationRow(c);
      const active = row.key === activeKey;
      return (
        <Pressable
          onPress={() => onOpen(c)}
          onLongPress={() => setMenu(c)}
          delayLongPress={350}
          accessibilityRole="button"
          accessibilityLabel={`${row.title} 열기`}
          style={({ pressed }) => [st.row, active && st.rowActive, pressed && { backgroundColor: p.panel2 }]}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={st.meta}>
              <Text style={[st.agent, row.agentDeleted && st.agentDeleted]} numberOfLines={1}>
                {row.agent}
              </Text>
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
            onPress={() => setMenu(c)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`${row.title} 더 보기`}
            style={st.more}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={p.muted} />
          </Pressable>
        </Pressable>
      );
    },
    [activeKey, onOpen, p, st],
  );

  const items = list?.items ?? [];

  return (
    <View style={{ flex: 1 }}>
      <View style={st.toolbar}>
        <Pressable
          onPress={onNewChat}
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
        data={items}
        keyExtractor={conversationKey}
        renderItem={renderItem}
        contentContainerStyle={st.list}
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        // 당겨서 새로고침: 처음부터 다시 받는다.
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void load('reset').finally(() => setPulling(false));
            }}
            tintColor={p.muted}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 8 }}>
            {notice ? (
              <Pressable onPress={() => setNotice('')} style={st.noticeBox}>
                <Text style={st.noticeText}>{notice}</Text>
              </Pressable>
            ) : null}
            {error ? (
              <View style={st.noticeBox}>
                <Text style={[st.noticeText, { color: p.danger }]}>{error}</Text>
                <Pressable
                  onPress={() => void load(list ? 'head' : 'reset')}
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
        }
        ListEmptyComponent={
          !list ? (
            error ? null : <ActivityIndicator style={{ marginTop: 24 }} color={p.primary} />
          ) : (
            <Text style={st.empty}>채팅이 없습니다.</Text>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={p.primary} /> : null}
      />

      <ConversationSearch
        client={client}
        visible={searchOpen}
        recent={items}
        onOpen={(c) => {
          setSearchOpen(false);
          onOpen(c);
        }}
        onClose={() => setSearchOpen(false)}
      />

      {/* 한 줄의 [⋯]: 이름 바꾸기 · 삭제 */}
      <Modal visible={!!menu} transparent animationType="slide" onRequestClose={closeMenu}>
        <Pressable style={st.scrim} accessibilityLabel="닫기" onPress={closeMenu} />
        {/* 이름 칸에 키보드가 뜨면 겹치는 만큼만 시트를 올린다(App 의 시트와 같은 방식). */}
        <KeyboardAvoidingView behavior="padding" style={st.sheetHost} pointerEvents="box-none">
          {menu ? (
            <View style={st.sheet}>
              <View style={st.sheetHandle} />
              <Text style={st.sheetTitle} numberOfLines={1}>
                {conversationDisplayTitle(menu)}
              </Text>
              {renameText == null ? (
                <>
                  <Pressable
                    onPress={() => {
                      setRenameText(menu.title);
                      setRenameError('');
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [st.menuRow, pressed && { backgroundColor: p.panel2 }]}
                  >
                    <Ionicons name="create-outline" size={18} color={p.text} />
                    <Text style={st.menuText}>{CONVERSATION_TEXT.rename}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => confirmRemove(menu)}
                    accessibilityRole="button"
                    style={({ pressed }) => [st.menuRow, pressed && { backgroundColor: p.panel2 }]}
                  >
                    <Ionicons name="trash-outline" size={18} color={p.danger} />
                    <Text style={[st.menuText, { color: p.danger }]}>{CONVERSATION_TEXT.remove}</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <TextInput
                    style={st.input}
                    value={renameText}
                    onChangeText={setRenameText}
                    placeholder={conversationDisplayTitle(menu)}
                    placeholderTextColor={p.muted}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => void saveRename()}
                    accessibilityLabel="채팅 이름"
                  />
                  {renameError ? <Text style={st.formError}>{renameError}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable onPress={closeMenu} accessibilityRole="button" style={[st.btn, { flex: 1 }]}>
                      <Text style={st.btnText}>취소</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void saveRename()}
                      disabled={busy}
                      accessibilityRole="button"
                      style={[st.btn, st.btnPrimary, { flex: 1 }, busy && { opacity: 0.5 }]}
                    >
                      {busy ? (
                        <ActivityIndicator color={p.onPrimary} />
                      ) : (
                        <Text style={[st.btnText, { color: p.onPrimary }]}>저장</Text>
                      )}
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
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
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14,
      paddingLeft: 14, paddingRight: 4, paddingVertical: 10, minHeight: 60,
    },
    rowActive: { borderColor: alpha(p.primary, 60), backgroundColor: alpha(p.primary, 8) },
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
    noticeBox: { padding: 10, borderRadius: 10, backgroundColor: p.panel2, gap: 8 },
    noticeText: { color: p.text, fontSize: 13 },
    retry: { alignSelf: 'flex-start', backgroundColor: p.panel, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
    empty: { color: p.muted, fontSize: 14, textAlign: 'center', padding: 24 },

    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
    sheetHost: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      width: '100%', backgroundColor: p.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      borderWidth: 1, borderColor: p.border, padding: 16, paddingBottom: 28, gap: 8,
    },
    sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center' },
    sheetTitle: { fontSize: 16, fontWeight: '800', color: p.text, marginBottom: 4 },
    menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TAP + 4, paddingHorizontal: 6, borderRadius: 10 },
    menuText: { color: p.text, fontSize: 15.5, fontWeight: '600' },
    input: {
      backgroundColor: p.panel2, color: p.text, borderWidth: 1, borderColor: p.border,
      borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    },
    formError: {
      backgroundColor: alpha(p.danger, 10), color: p.danger, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 10, fontSize: 13,
    },
    btn: {
      minHeight: TAP, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.panel2, borderWidth: 1, borderColor: p.border,
    },
    btnPrimary: { backgroundColor: p.primary, borderColor: p.primary },
    btnText: { color: p.text, fontSize: 15, fontWeight: '700' },
  });
}
