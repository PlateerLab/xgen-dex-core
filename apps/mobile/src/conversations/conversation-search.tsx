/**
 * 채팅 검색 화면 (2026-10-10). 채팅 목록 머리 [새 채팅] 옆 돋보기가 연다.
 *
 *   [돋보기] 검색...                     [지우기] [X]
 *   최근 채팅                       ← 검색어가 비었을 때
 *   (말풍선) 대화 제목                          날
 *            에이전트 이름 · 맞은 자리 한 줄
 *
 * 적기를 멈추면 잠깐 뒤 서버에 묻는다(제목·에이전트 이름·대화 내용, @dex/protocol conversation-search).
 * 맞은 낱말은 굵게 칠한다. 고르면 화면이 닫히고 그 대화가 열린다(목록 줄을 누른 것과 같다).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StatusBar as RnStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  DELETED_AGENT_LABEL,
  SEARCH_DELAY_MS,
  SEARCH_RECENT_COUNT,
  type Conversation,
  type ConversationSearchPage,
  type SearchTextPart,
} from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import type { XgenMobileClient } from '../lib/xgen';
import { SEARCH_TEXT, searchResultRow, type SearchResultRow } from './conversation-model';

const SEARCH_LIMIT = 50;

function Parts({ parts, hitStyle }: { parts: SearchTextPart[]; hitStyle: object }): React.ReactElement {
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <Text key={i} style={hitStyle}>
            {part.text}
          </Text>
        ) : (
          <Text key={i}>{part.text}</Text>
        ),
      )}
    </>
  );
}

export function ConversationSearch({
  client,
  visible,
  recent,
  onOpen,
  onClose,
}: {
  client: XgenMobileClient;
  visible: boolean;
  /** 지금 목록(마지막으로 말한 순서). 검색어가 비면 맨 위 몇 개. */
  recent: Conversation[];
  onOpen: (c: Conversation) => void;
  onClose: () => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<ConversationSearchPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const inputRef = useRef<TextInput | null>(null);
  const trimmed = query.trim();

  // 열 때마다 빈 검색칸에서 시작한다.
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setPage(null);
    setError('');
  }, [visible]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!visible || !trimmed) {
      setSearching(false);
      setPage(null);
      setError('');
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      client.api.history
        .searchConversations(trimmed, { limit: SEARCH_LIMIT })
        .then((next) => {
          if (mine !== seq.current) return;
          setPage(next);
          setError('');
        })
        .catch((e: unknown) => {
          if (mine === seq.current) setError(friendlyError(e, SEARCH_TEXT.failed));
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [client, trimmed, visible]);

  const rows: SearchResultRow[] = useMemo(
    () =>
      trimmed
        ? (page?.hits ?? []).map((hit) => searchResultRow(hit.conversation, hit.match))
        : recent.slice(0, SEARCH_RECENT_COUNT).map((c) => searchResultRow(c)),
    [page, recent, trimmed],
  );

  let status = '';
  if (trimmed) {
    if (error) status = error;
    else if (!page || (searching && rows.length === 0)) status = SEARCH_TEXT.searching;
    else if (rows.length === 0) status = SEARCH_TEXT.empty;
  }
  const footer = trimmed && page && !error
    ? !page.contentSearched
      ? SEARCH_TEXT.titleOnly
      : page.hasMore
        ? SEARCH_TEXT.more
        : ''
    : '';

  return (
    // 위에 덮는 다른 화면(ScreenModal)과 같은 모양: 상태 표시줄 아래에서 머리가 시작한다.
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <View style={st.screen}>
        <View style={[st.head, { paddingTop: (Platform.OS === 'android' ? (RnStatusBar.currentHeight ?? 0) : 50) + 6 }]}>
          <Ionicons name="search" size={18} color={p.muted} />
          <TextInput
            ref={inputRef}
            style={st.input}
            value={query}
            onChangeText={setQuery}
            placeholder={SEARCH_TEXT.placeholder}
            placeholderTextColor={p.muted}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
            maxLength={200}
            accessibilityLabel={SEARCH_TEXT.title}
          />
          {query ? (
            <Pressable
              onPress={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              hitSlop={6}
              accessibilityRole="button"
              style={st.clear}
            >
              <Text style={st.clearText}>{SEARCH_TEXT.clear}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onClose} hitSlop={6} accessibilityRole="button" accessibilityLabel={SEARCH_TEXT.close} style={st.close}>
            <Ionicons name="close" size={22} color={p.text} />
          </Pressable>
        </View>
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={st.list}
          ListHeaderComponent={
            !trimmed && rows.length ? (
              <Text style={st.label}>{SEARCH_TEXT.recent}</Text>
            ) : status ? (
              <View style={st.statusRow}>
                {searching && !error ? <ActivityIndicator color={p.muted} /> : null}
                <Text style={[st.status, error ? { color: p.danger } : null]}>{status}</Text>
              </View>
            ) : null
          }
          ListFooterComponent={footer ? <Text style={st.footer}>{footer}</Text> : null}
          renderItem={({ item: row }) => (
            <Pressable
              onPress={() => onOpen(row.conversation)}
              accessibilityRole="button"
              style={({ pressed }) => [st.row, pressed && { backgroundColor: p.panel2 }]}
            >
              <Ionicons name="chatbubble-outline" size={18} color={p.muted} style={{ marginTop: 2 }} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={st.top}>
                  <Text style={st.title} numberOfLines={1}>
                    <Parts parts={row.title} hitStyle={st.hit} />
                  </Text>
                  {row.day ? <Text style={st.day}>{row.day}</Text> : null}
                </View>
                <Text style={st.sub} numberOfLines={1}>
                  {row.agentDeleted ? <Text style={st.deleted}>{DELETED_AGENT_LABEL} </Text> : null}
                  <Parts parts={row.agent} hitStyle={st.hit} />
                  {row.tag ? ` · ${row.tag}` : ''}
                  {row.snippet ? ' · ' : ''}
                  {row.snippet ? <Parts parts={row.snippet} hitStyle={st.hit} /> : null}
                </Text>
              </View>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    head: {
      flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8,
      borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.panel,
    },
    input: { flex: 1, minHeight: TAP, color: p.text, fontSize: 16 },
    clear: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 },
    clearText: { color: p.muted, fontSize: 14, fontWeight: '600' },
    close: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
    list: { padding: 10, paddingBottom: 32, gap: 2 },
    label: { color: p.muted, fontSize: 12.5, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 6 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    status: { color: p.muted, fontSize: 14 },
    footer: { color: p.muted, fontSize: 12.5, padding: 12 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 12 },
    top: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
    title: { flex: 1, color: p.text, fontSize: 15, fontWeight: '600' },
    day: { color: p.muted, fontSize: 12 },
    sub: { color: p.muted, fontSize: 13 },
    hit: { color: p.text, fontWeight: '800', backgroundColor: alpha(p.primary, 16) },
    deleted: { color: p.danger, fontWeight: '700' },
  });
}
