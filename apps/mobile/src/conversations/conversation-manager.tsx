/**
 * 채팅 기록 관리 화면 (2026-10-10). 채팅 목록 머리의 [⋯] 가 연다.
 *
 *   [←] 채팅 기록 관리                                  [새로고침]
 *   [전체 | 활성 | 배포 | 삭제됨]
 *   [돋보기] 제목·에이전트 이름·내용으로 검색
 *   [☐] 모두 선택  총 N개                   M개 선택 [선택 삭제]
 *   [에이전트가 사라진 채팅 제거 (N)]
 *   [☐] 대화 제목                                     날  [⋯]   ⋯ = 열기(대화 보기) · 이름 바꾸기 · 삭제
 *       에이전트 이름 [꼬리표]
 *
 * 데스크톱 채팅 기록 관리 탭(ConversationManager)과 같은 일과 말이다. 목록·검색·필터 규칙은 서버가 정한다
 * (@dex/protocol history.conversationPage·searchConversations 의 kind). 줄을 누르면 고르고, 세 단추는 폰 폭에
 * 들어가지 않아 줄의 [⋯] 시트에 모았다. 바꾼 것은 채팅 목록에 곧바로 알린다(콜백).
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
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SEARCH_DELAY_MS, conversationKey, type Conversation, type ConversationKind } from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import { ScreenModal } from '../lib/screen-modal';
import type { XgenMobileClient } from '../lib/xgen';
import {
  CONVERSATION_TEXT,
  MANAGER_KINDS,
  MANAGER_TEXT,
  SEARCH_TEXT,
  conversationRow,
  deleteQuestion,
  deleteResultNotice,
  managerAfterRemove,
  managerAfterRename,
  managerAppend,
  managerFromPage,
  managerFromSearch,
  openLabel,
  purgeDoneNotice,
  purgeLabel,
  purgeQuestion,
  removeInBatches,
  type ManagerListState,
} from './conversation-model';
import { ConversationSheet } from './conversation-sheet';

const PAGE_SIZE = 50;
const SEARCH_LIMIT = 100;
/** 안내 한 줄이 떠 있는 시간. */
const NOTICE_MS = 4000;

/** "더 불러오지 못했습니다. 까닭" 처럼 데스크톱과 같은 꼴로 까닭을 잇는다. */
function withReason(base: string, e: unknown): string {
  const reason = friendlyError(e, '');
  return reason ? `${base} ${reason}` : base;
}

export function ConversationManager({
  client,
  visible,
  onClose,
  onOpen,
  onRenamed,
  onRemoved,
  onPurged,
}: {
  client: XgenMobileClient;
  visible: boolean;
  onClose: () => void;
  /** [열기]: 화면을 닫고 그 대화를 연다(목록의 줄을 누른 것과 같다). */
  onOpen: (c: Conversation) => void;
  onRenamed: (c: Conversation, title: string, customTitle: boolean) => void;
  /** 지운 대화들. 열려 있던 대화면 채팅 화면을 비운다. */
  onRemoved: (gone: Conversation[]) => void;
  /** 에이전트가 사라진 채팅을 한꺼번에 지웠다. */
  onPurged: () => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [kind, setKind] = useState<ConversationKind>('all');
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const [state, setState] = useState<ManagerListState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** 읽지 못한 까닭(빈 글이면 까닭 없이 실패). null 이면 실패하지 않았다. */
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** [⋯] 를 연 대화. */
  const [menu, setMenu] = useState<Conversation | null>(null);
  /** 처음부터 다시 읽을 때마다 올린다. 늦게 온 앞 응답(다음 쪽 포함)은 버린다. */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      if (trimmed) {
        const page = await client.api.history.searchConversations(trimmed, { limit: SEARCH_LIMIT, kind });
        if (my !== seq.current) return;
        setState((cur) => managerFromSearch(page, cur));
      } else {
        const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, kind });
        if (my !== seq.current) return;
        setState(managerFromPage(page));
      }
    } catch (e) {
      if (my === seq.current) setError(friendlyError(e, ''));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [client, kind, trimmed]);

  // 닫으면 처음으로 되돌린다. 다음에 열 때 [전체]·빈 검색칸에서 시작한다.
  useEffect(() => {
    if (visible) return;
    seq.current += 1;
    setQuery('');
    setKind('all');
    setState(null);
    setSelected(new Set());
    setNotice('');
    setError(null);
    setMenu(null);
    setLoading(false);
  }, [visible]);

  // 필터·검색이 바뀌면 처음부터 다시 읽는다(검색은 적기를 멈춘 뒤). 고른 것은 비운다.
  useEffect(() => {
    if (!visible) return;
    setSelected(new Set());
    const timer = setTimeout(() => void load(), trimmed ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [visible, load, trimmed]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  const loadMore = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur?.cursor || loadingMoreRef.current || trimmed) return;
    const my = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await client.api.history.conversationPage({ limit: PAGE_SIZE, kind, cursor: cur.cursor });
      if (my !== seq.current) return;
      setState((s) => (s ? managerAppend(s, page) : s));
    } catch (e) {
      if (my === seq.current) setNotice(withReason(MANAGER_TEXT.moreFailed, e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [client, kind, trimmed]);

  // 읽지 못했으면 줄 대신 그 까닭을 보인다(데스크톱과 같다). 보이지 않는 줄을 고르거나 지우지 않게 비운다.
  const items = error != null ? [] : (state?.items ?? []);
  const deletedCount = state?.deletedCount ?? 0;
  const allSelected = items.length > 0 && items.every((c) => selected.has(conversationKey(c)));
  const selectedItems = items.filter((c) => selected.has(conversationKey(c)));

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(conversationKey)));
  const toggleOne = (key: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const runDelete = useCallback(
    async (targets: Conversation[]) => {
      setBusy(true);
      try {
        const { done, failed } = await removeInBatches(targets, (c) =>
          client.api.history.deleteConversation(c.workflowId, c.interactionId, c.workflowName),
        );
        const goneKeys = new Set(done.map(conversationKey));
        setState((s) => (s ? managerAfterRemove(s, done) : s));
        setSelected((cur) => new Set([...cur].filter((k) => !goneKeys.has(k))));
        if (done.length) onRemoved(done);
        const msg = deleteResultNotice(done.length, failed.length);
        if (msg) setNotice(msg);
      } finally {
        setBusy(false);
      }
    },
    [client, onRemoved],
  );

  const deleteMany = (targets: Conversation[]) => {
    if (!targets.length || busy) return;
    Alert.alert(CONVERSATION_TEXT.remove, deleteQuestion(targets), [
      { text: '취소', style: 'cancel' },
      { text: CONVERSATION_TEXT.remove, style: 'destructive', onPress: () => void runDelete(targets) },
    ]);
  };

  const purge = () => {
    if (deletedCount <= 0 || busy) return;
    Alert.alert(CONVERSATION_TEXT.purgeConfirmTitle, purgeQuestion(deletedCount), [
      { text: '취소', style: 'cancel' },
      {
        text: '제거',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const removed = await client.api.history.purgeDeletedAgentConversations();
              setState((s) => (s ? { ...s, deletedCount: 0 } : s));
              onPurged();
              setNotice(purgeDoneNotice(removed));
              await load();
            } catch (e) {
              setNotice(withReason(MANAGER_TEXT.purgeFailed, e));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const rename = useCallback(
    async (c: Conversation, title: string) => {
      const res = await client.api.history.renameConversation(c.workflowId, c.interactionId, title);
      setState((s) => (s ? managerAfterRename(s, c, res.title, res.customTitle) : s));
      onRenamed(c, res.title, res.customTitle);
    },
    [client, onRenamed],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const renderItem = ({ item: c }: { item: Conversation }) => {
    const row = conversationRow(c);
    const checked = selected.has(row.key);
    return (
      <Pressable
        onPress={() => toggleOne(row.key)}
        disabled={busy}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: busy }}
        accessibilityLabel={row.title}
        style={({ pressed }) => [st.row, checked && st.rowChecked, pressed && { backgroundColor: p.panel2 }]}
      >
        <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={22} color={checked ? p.primary : p.muted} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={st.title} numberOfLines={1}>
            {row.title}
          </Text>
          <View style={st.meta}>
            <Text style={row.agentDeleted ? st.deletedTag : st.agent} numberOfLines={1}>
              {row.agent}
            </Text>
            {row.tag ? (
              <Text style={st.tag} numberOfLines={1}>
                {row.tag}
              </Text>
            ) : null}
          </View>
        </View>
        {row.day ? <Text style={st.day}>{row.day}</Text> : null}
        <Pressable
          onPress={() => setMenu(c)}
          disabled={busy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${row.title} 더 보기`}
          style={st.more}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={p.muted} />
        </Pressable>
      </Pressable>
    );
  };

  const purgeDisabled = busy || deletedCount <= 0;
  const footer = loadingMore ? (
    <ActivityIndicator style={{ margin: 16 }} color={p.primary} />
  ) : trimmed && state?.searchHasMore && error == null ? (
    <Text style={st.footer}>{MANAGER_TEXT.searchMore}</Text>
  ) : null;

  return (
    <ScreenModal
      visible={visible}
      title={MANAGER_TEXT.title}
      onClose={onClose}
      actions={[{ icon: 'refresh', label: MANAGER_TEXT.refresh, onPress: () => void load(), disabled: busy }]}
    >
      <View style={st.controls}>
        <View style={st.segment} accessibilityRole="tablist" accessibilityLabel={MANAGER_TEXT.kind}>
          {MANAGER_KINDS.map((k) => {
            const on = kind === k.value;
            return (
              <Pressable
                key={k.value}
                onPress={() => setKind(k.value)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[st.segmentItem, on && st.segmentOn]}
              >
                <Text style={[st.segmentText, on && st.segmentTextOn]}>{k.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={st.search}>
          <Ionicons name="search" size={17} color={p.muted} />
          <TextInput
            style={st.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={MANAGER_TEXT.placeholder}
            placeholderTextColor={p.muted}
            autoCorrect={false}
            returnKeyType="search"
            maxLength={200}
            accessibilityLabel={MANAGER_TEXT.searchLabel}
          />
          {query ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={SEARCH_TEXT.clear}
              style={st.clear}
            >
              <Ionicons name="close-circle" size={18} color={p.muted} />
            </Pressable>
          ) : null}
        </View>
        <View style={st.bar}>
          <Pressable
            onPress={toggleAll}
            disabled={items.length === 0 || busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allSelected, disabled: items.length === 0 || busy }}
            style={[st.check, (items.length === 0 || busy) && { opacity: 0.5 }]}
          >
            <Ionicons name={allSelected ? 'checkbox' : 'square-outline'} size={20} color={allSelected ? p.primary : p.muted} />
            <Text style={st.checkText}>{MANAGER_TEXT.selectAll}</Text>
          </Pressable>
          {state?.total != null ? <Text style={st.total}>{`총 ${state.total}개`}</Text> : null}
          <View style={{ flex: 1 }} />
          {selectedItems.length > 0 ? (
            <>
              <Text style={st.selectedCount}>{`${selectedItems.length}개 선택`}</Text>
              <Pressable
                onPress={() => deleteMany(selectedItems)}
                disabled={busy}
                accessibilityRole="button"
                style={[st.deleteBtn, busy && { opacity: 0.5 }]}
              >
                {busy ? (
                  <ActivityIndicator color={p.danger} />
                ) : (
                  <Text style={st.deleteText}>{MANAGER_TEXT.deleteSelected}</Text>
                )}
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={conversationKey}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={st.list}
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void load().finally(() => setPulling(false));
            }}
            tintColor={p.muted}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 8, marginBottom: 4 }}>
            <Pressable
              onPress={purge}
              disabled={purgeDisabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: purgeDisabled }}
              style={[st.purge, purgeDisabled && { opacity: 0.45 }]}
            >
              <Ionicons name="trash-outline" size={16} color={p.danger} />
              <Text style={st.purgeText} numberOfLines={1}>
                {purgeLabel(deletedCount)}
              </Text>
            </Pressable>
            {notice ? (
              <Pressable onPress={() => setNotice('')} style={st.noticeBox} accessibilityRole="button">
                <Text style={st.noticeText}>{notice}</Text>
              </Pressable>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          error != null ? (
            <View style={st.errorBox}>
              <Text style={[st.noticeText, { color: p.danger }]}>
                {error ? `${MANAGER_TEXT.loadFailed} ${error}` : MANAGER_TEXT.loadFailed}
              </Text>
              <Pressable onPress={() => void load()} disabled={loading} style={st.retry} accessibilityRole="button">
                {loading ? (
                  <ActivityIndicator color={p.muted} />
                ) : (
                  <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>{MANAGER_TEXT.retry}</Text>
                )}
              </Pressable>
            </View>
          ) : !state || loading ? (
            <Text style={st.empty}>{MANAGER_TEXT.loading}</Text>
          ) : (
            <Text style={st.empty}>{trimmed ? MANAGER_TEXT.noMatch : MANAGER_TEXT.empty}</Text>
          )
        }
        ListFooterComponent={footer}
      />

      {/* 줄의 [⋯]: 열기(대화 보기) · 이름 바꾸기 · 삭제. 이 화면 위에 뜨도록 화면 안에 그린다. */}
      <ConversationSheet
        conversation={menu}
        openLabel={menu ? openLabel(menu) : undefined}
        onOpen={(c) => {
          setMenu(null);
          onOpen(c);
        }}
        onRename={rename}
        onRemove={(c) => deleteMany([c])}
        onClose={closeMenu}
      />
    </ScreenModal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    controls: {
      paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, gap: 8,
      backgroundColor: p.panel, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    segment: {
      flexDirection: 'row', borderRadius: 10, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.panel2, padding: 3, gap: 3,
    },
    segmentItem: { flex: 1, minHeight: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    segmentOn: { backgroundColor: p.primary },
    segmentText: { color: p.text, fontSize: 13.5, fontWeight: '600' },
    segmentTextOn: { color: p.onPrimary, fontWeight: '800' },
    search: {
      flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12,
      backgroundColor: p.panel2, borderWidth: 1, borderColor: p.border, borderRadius: 12,
    },
    searchInput: { flex: 1, minHeight: TAP, color: p.text, fontSize: 15 },
    clear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    bar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP },
    check: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TAP },
    checkText: { color: p.text, fontSize: 14, fontWeight: '600' },
    total: { color: p.muted, fontSize: 13 },
    selectedCount: { color: p.text, fontSize: 13.5, fontWeight: '800' },
    deleteBtn: {
      minHeight: 34, paddingHorizontal: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
      backgroundColor: alpha(p.danger, 12), borderWidth: 1, borderColor: alpha(p.danger, 40),
    },
    deleteText: { color: p.danger, fontSize: 13.5, fontWeight: '800' },
    list: { padding: 12, paddingBottom: 32, gap: 8 },
    purge: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40,
      borderRadius: 12, borderWidth: 1, borderColor: alpha(p.danger, 40), backgroundColor: alpha(p.danger, 8),
      paddingHorizontal: 12,
    },
    purgeText: { color: p.danger, fontSize: 13.5, fontWeight: '700', flexShrink: 1 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14,
      paddingLeft: 12, paddingRight: 4, paddingVertical: 10, minHeight: 60,
    },
    rowChecked: { borderColor: alpha(p.primary, 60), backgroundColor: alpha(p.primary, 8) },
    title: { color: p.text, fontSize: 15, fontWeight: '700' },
    meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    agent: { color: p.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 },
    deletedTag: {
      color: p.danger, backgroundColor: alpha(p.danger, 12), borderRadius: 6, fontSize: 12, fontWeight: '600',
      paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', flexShrink: 0,
    },
    tag: {
      fontSize: 10.5, fontWeight: '700', color: p.primary,
      backgroundColor: alpha(p.primary, 14), borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
      overflow: 'hidden',
    },
    day: { color: p.muted, fontSize: 12 },
    more: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
    noticeBox: { padding: 10, borderRadius: 10, backgroundColor: p.panel2 },
    noticeText: { color: p.text, fontSize: 13 },
    errorBox: { padding: 10, borderRadius: 10, backgroundColor: p.panel2, gap: 8 },
    retry: { alignSelf: 'flex-start', backgroundColor: p.panel, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
    empty: { color: p.muted, fontSize: 14, textAlign: 'center', padding: 24 },
    footer: { color: p.muted, fontSize: 12.5, padding: 12, textAlign: 'center' },
  });
}
