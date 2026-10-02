/**
 * [앱] — 내 에이전트가 만든 앱([내 앱])과 공유된 앱([앱 스토어]). 웹 [Agent APP]·데스크톱 [앱] 탭과
 * 같은 두 칸, 같은 카드다:
 *
 *   [앱 이름] [태그…]
 *   [설명]
 *   [미리보기 그림 — 못 받으면 기본 그림]
 *   [버튼…]                         [⋯]
 *
 * 폰에서는 한 줄에 카드 하나, 위에서 아래로 넘긴다. 말(태그·상태·확인 문구)은 데스크톱과 한 곳
 * (@dex/protocol 의 app-card)에서 가져온다.
 *
 * 미리보기는 서버에 올라간 한 장(데스크톱 앱이 앱을 띄워 찍은 화면)이다. 폰은 앱을 그려 찍을 수
 * 없으니 받아서 보여 주기만 하고, 없거나 못 받으면 기본 그림을 그린다.
 *
 * [열기] — 폰 **안에서** 앱을 띄운다(app-viewer, 데스크톱이 탭으로 여는 것과 같은 자리). 내 앱은 로그인을
 * 실어 그 앱의 주소로, 스토어의 앱은 공개 링크로. 기기의 브라우저로 넘기는 예전 길은 [⋯] 와 보기 화면의
 * [브라우저로 열기] 에 남는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { AppViewer, myAppTarget, storeAppTarget, type AppViewTarget } from './app-viewer';
import {
  APP_CONFIRM,
  appDescription,
  appKindLabel,
  appStatus,
  isAppPreviewPath,
  myAppTags,
  storeAppTags,
  type AppTag,
  type MyApp,
  type StoreApp,
} from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import type { XgenMobileClient } from '../lib/xgen';
import { serverLink } from '../lib/links';

type Tab = 'mine' | 'store';
const PAGE_SIZE = 24;

function confirm(message: string, ok: string): Promise<boolean> {
  const [title, ...rest] = message.split('\n');
  return new Promise((resolve) =>
    Alert.alert(title, rest.join('\n'), [
      { text: '취소', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

export function AppsSection({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [tab, setTab] = useState<Tab>('mine');
  const [query, setQuery] = useState('');

  // ── 내 앱 ──
  const [mine, setMine] = useState<MyApp[] | null>(null);
  const [mineError, setMineError] = useState('');
  const [mineLoading, setMineLoading] = useState(false);
  const [busy, setBusy] = useState('');

  // ── 앱 스토어 ──
  const [store, setStore] = useState<StoreApp[] | null>(null);
  const [storeTotal, setStoreTotal] = useState(0);
  const [storePage, setStorePage] = useState(1);
  const [storeError, setStoreError] = useState('');
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeSearch, setStoreSearch] = useState('');
  const storeSeq = useRef(0);

  const [notice, setNotice] = useState('');
  const [viewing, setViewing] = useState<AppViewTarget | null>(null);

  const loadMine = useCallback(async () => {
    setMineLoading(true);
    try {
      const res = await client.api.agentData.appStoreMine();
      setMine(res.apps);
      setMineError(res.failed.length ? `${res.failed.length}개 에이전트의 앱을 읽지 못했습니다.` : '');
    } catch (e) {
      setMineError(friendlyError(e, '앱 목록을 불러오지 못했습니다.'));
    } finally {
      setMineLoading(false);
    }
  }, [client]);

  const loadStore = useCallback(
    async (page = 1) => {
      const seq = ++storeSeq.current;
      setStoreLoading(true);
      try {
        const res = await client.api.agentData.appStoreList({ search: storeSearch, page, pageSize: PAGE_SIZE });
        if (seq !== storeSeq.current) return;
        setStore((cur) => (page === 1 || !cur ? res.items : [...cur, ...res.items]));
        setStoreTotal(res.total);
        setStorePage(res.page);
        setStoreError('');
      } catch (e) {
        if (seq === storeSeq.current) setStoreError(friendlyError(e, '앱 스토어를 불러오지 못했습니다.'));
      } finally {
        if (seq === storeSeq.current) setStoreLoading(false);
      }
    },
    [client, storeSearch],
  );

  // 보일 때 읽는다 — 다른 화면에서 돌아오면 그사이 바뀐 것이 있을 수 있다.
  useEffect(() => {
    if (!visible) return;
    if (tab === 'mine') void loadMine();
  }, [visible, tab, loadMine]);
  useEffect(() => {
    if (visible && tab === 'store') void loadStore(1);
  }, [visible, tab, loadStore]);

  // 스토어 검색은 치는 동안 매번 보내지 않는다.
  useEffect(() => {
    if (tab !== 'store') return;
    const t = setTimeout(() => setStoreSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query, tab]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!mine || !q) return mine ?? [];
    return mine.filter((a) =>
      [a.title, a.slug, a.description, a.workflow_name].some((v) => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [mine, query]);

  // ── 동작 ──
  /** 기기의 브라우저로 — 예전 길(보기 화면의 [브라우저로 열기] 와 같다). */
  const openInBrowser = (path: string) => {
    const url = serverLink(client.session.serverUrl, path);
    if (!url) return setNotice('열 수 없는 주소입니다.');
    void Linking.openURL(url).catch(() => setNotice('브라우저를 열지 못했습니다.'));
  };
  /** 폰 안에서 연다. */
  const view = (target: AppViewTarget | null) => {
    if (!target) return setNotice('열 수 없는 주소입니다.');
    setViewing(target);
  };

  const toggleShare = async (app: MyApp) => {
    const next = !app.shared;
    if (!(await confirm(next ? APP_CONFIRM.share : APP_CONFIRM.unshare, next ? '공유' : '공유 중지'))) return;
    setBusy(`${app.workflow_id}/${app.slug}`);
    try {
      const res = await client.api.agentData.appSetShare(app.workflow_id, app.slug, next);
      const link = res.shared && res.path ? serverLink(client.session.serverUrl, res.path) : '';
      if (link) {
        await Clipboard.setStringAsync(link).catch(() => undefined);
        Alert.alert('공개 링크를 만들었습니다', `${link}\n\n링크를 복사했습니다.`, [
          { text: '공유하기', onPress: () => void Share.share({ message: link }).catch(() => undefined) },
          { text: '닫기', style: 'cancel' },
        ]);
      }
      await loadMine();
    } catch (e) {
      setNotice(friendlyError(e, '공유를 바꾸지 못했습니다.'));
    } finally {
      setBusy('');
    }
  };

  const toggleServing = async (app: MyApp) => {
    const next = !app.serving;
    if (!next && !(await confirm(APP_CONFIRM.undeploy, '배포 중지'))) return;
    setBusy(`${app.workflow_id}/${app.slug}`);
    try {
      await client.api.agentData.appSetServing(app.workflow_id, app.slug, next);
      await loadMine();
    } catch (e) {
      setNotice(friendlyError(e, '배포를 바꾸지 못했습니다.'));
    } finally {
      setBusy('');
    }
  };

  const showDetail = (app: MyApp) => {
    const lines = [
      `에이전트: ${app.workflow_name || app.workflow_id}`,
      `모양: ${appKindLabel(app.kind)}`,
      `상태: ${appStatus(app).label}`,
      `공개: ${app.shared ? '공개 중' : '공개 안 함'}`,
      `폴더: apps/${app.slug}`,
      ...(app.issues.length ? ['', ...app.issues] : []),
    ];
    Alert.alert(app.title, lines.join('\n'), [
      ...(app.ready
        ? [{ text: '브라우저로 열기', onPress: () => openInBrowser(client.api.agentData.appWebPath(app.workflow_id, app.slug)) }]
        : []),
      { text: '닫기', style: 'cancel' as const },
    ]);
  };

  const previewSource = (url?: string) =>
    url && isAppPreviewPath(url)
      ? {
          uri: serverLink(client.session.serverUrl, url),
          headers: { Authorization: `Bearer ${client.session.accessToken}` },
        }
      : null;

  const renderMine = ({ item: app }: { item: MyApp }) => {
    const key = `${app.workflow_id}/${app.slug}`;
    const pending = busy === key;
    return (
      <AppCard
        title={app.title}
        tags={myAppTags(app, { pending })}
        description={appDescription(app)}
        kind={app.kind}
        preview={previewSource(app.preview_url)}
        onPreview={app.ready ? () => view(myAppTarget(client, app)) : undefined}
        onMore={() => showDetail(app)}
        actions={[
          {
            label: '열기',
            strong: true,
            disabled: !app.ready,
            onPress: () => view(myAppTarget(client, app)),
          },
          {
            label: app.shared ? '공유 중지' : '공유',
            disabled: !!busy || (!app.shared && !app.ready),
            onPress: () => void toggleShare(app),
          },
          { label: app.serving ? '배포 중지' : '배포', disabled: !!busy, onPress: () => void toggleServing(app) },
        ]}
      />
    );
  };

  const renderStore = ({ item: app }: { item: StoreApp }) => (
    <AppCard
      title={app.title}
      tags={storeAppTags(app)}
      description={appDescription(app)}
      kind={app.kind}
      preview={previewSource(app.preview_url)}
      onPreview={() => view(storeAppTarget(client, app))}
      actions={[{ label: '열기', strong: true, onPress: () => view(storeAppTarget(client, app)) }]}
    />
  );

  const empty = (text: string) => <Text style={st.empty}>{text}</Text>;
  const searching = !!query.trim();

  return (
    <View style={{ flex: 1 }}>
      <View style={st.tabs}>
        {(['mine', 'store'] as Tab[]).map((id) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            style={[st.tab, tab === id && st.tabOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === id }}
          >
            <Text style={[st.tabText, tab === id && st.tabTextOn]}>{id === 'mine' ? '내 앱' : '앱 스토어'}</Text>
          </Pressable>
        ))}
      </View>
      <View style={st.toolbar}>
        <TextInput
          style={st.search}
          placeholder="앱 검색"
          placeholderTextColor={p.muted}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
        />
      </View>
      {notice ? (
        <Pressable onPress={() => setNotice('')} style={st.noticeBox}>
          <Text style={st.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}

      {tab === 'mine' ? (
        <FlatList
          data={rows}
          keyExtractor={(a) => `${a.workflow_id}/${a.slug}`}
          renderItem={renderMine}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={mineLoading && !!mine} onRefresh={() => void loadMine()} tintColor={p.primary} />}
          ListHeaderComponent={
            mine ? (
              <Text style={st.summary}>
                앱 {mine.length}개 · 공개 {mine.filter((a) => a.shared).length}개
                {mineError ? `  ${mineError}` : ''}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            !mine ? (
              mineError ? (
                empty(mineError)
              ) : (
                <ActivityIndicator style={{ marginTop: 24 }} color={p.primary} />
              )
            ) : searching ? (
              empty('검색 결과가 없습니다.')
            ) : (
              empty('에이전트가 만든 앱이 없습니다. 에이전트에게 앱을 만들어 달라고 하면 여기에 모입니다.')
            )
          }
        />
      ) : (
        <FlatList
          data={store ?? []}
          keyExtractor={(a) => `${a.workflow_id}/${a.slug}`}
          renderItem={renderStore}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={storeLoading && !!store} onRefresh={() => void loadStore(1)} tintColor={p.primary} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (!storeLoading && store && store.length < storeTotal) void loadStore(storePage + 1);
          }}
          ListHeaderComponent={store ? <Text style={st.summary}>공유된 앱 {storeTotal}개</Text> : null}
          ListFooterComponent={storeLoading && store && store.length > 0 ? <ActivityIndicator style={{ margin: 16 }} color={p.primary} /> : null}
          ListEmptyComponent={
            !store ? (
              storeError ? (
                empty(storeError)
              ) : (
                <ActivityIndicator style={{ marginTop: 24 }} color={p.primary} />
              )
            ) : storeSearch ? (
              empty('검색 결과가 없습니다.')
            ) : (
              empty('공유된 앱이 없습니다. [내 앱]에서 공유한 앱이 여기에 모입니다.')
            )
          }
        />
      )}
      <AppViewer client={client} target={viewing} onClose={() => setViewing(null)} />
    </View>
  );
}

// ── 카드 한 장 ─────────────────────────────────────────────────────

interface CardAction {
  label: string;
  onPress: () => void;
  strong?: boolean;
  disabled?: boolean;
}

function tagColors(p: Palette, tone: AppTag['tone']): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'ready':
      return { bg: alpha(p.ok, 12), fg: p.ok, border: alpha(p.ok, 35) };
    case 'broken':
      return { bg: alpha('#F79009', 14), fg: '#B54708', border: alpha('#F79009', 40) };
    case 'shared':
      return { bg: alpha(p.primary, 12), fg: p.primary, border: alpha(p.primary, 30) };
    case 'muted':
      return { bg: p.panel2, fg: p.muted, border: 'transparent' };
    default:
      return { bg: 'transparent', fg: p.muted, border: p.border };
  }
}

const KIND_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  project: 'globe-outline',
  component: 'code-slash-outline',
  service: 'apps-outline',
};

export function AppCard({
  title,
  tags,
  description,
  kind,
  preview,
  onPreview,
  onMore,
  actions,
}: {
  title: string;
  tags: AppTag[];
  description: string;
  kind: string;
  preview: { uri: string; headers: Record<string, string> } | null;
  onPreview?: () => void;
  onMore?: () => void;
  actions: CardAction[];
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [preview?.uri]);
  const showImage = !!preview?.uri && !failed;
  const picture = (
    <View style={st.preview}>
      {showImage ? (
        <Image
          source={preview!}
          style={st.previewImage}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={`${title} 미리보기`}
        />
      ) : (
        <View style={st.fallback}>
          <View style={st.fallbackIcon}>
            <Ionicons name={KIND_ICON[kind] ?? 'apps-outline'} size={26} color={p.primary} />
          </View>
          <Text style={st.fallbackText}>{appKindLabel(kind)}</Text>
        </View>
      )}
    </View>
  );
  return (
    <View style={st.card}>
      <View style={st.top}>
        <Text style={st.title} numberOfLines={1}>
          {title}
        </Text>
        {tags.map((tag, i) => {
          const c = tagColors(p, tag.tone);
          return (
            <View key={`${tag.tone}-${i}`} style={[st.tag, { backgroundColor: c.bg, borderColor: c.border }]}>
              <Text style={[st.tagText, { color: c.fg }]} numberOfLines={1}>
                {tag.label}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={st.desc} numberOfLines={2}>
        {description}
      </Text>
      {onPreview ? (
        <Pressable onPress={onPreview} accessibilityRole="button" accessibilityLabel={`${title} 열기`}>
          {picture}
        </Pressable>
      ) : (
        picture
      )}
      <View style={st.actions}>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={a.onPress}
            disabled={a.disabled}
            accessibilityRole="button"
            style={({ pressed }) => [st.btn, a.strong && st.btnStrong, a.disabled && st.btnOff, pressed && { opacity: 0.7 }]}
          >
            <Text style={[st.btnText, a.strong && st.btnTextStrong]}>{a.label}</Text>
          </Pressable>
        ))}
        {onMore ? (
          <Pressable onPress={onMore} style={st.more} accessibilityRole="button" accessibilityLabel="더 보기" hitSlop={8}>
            <Ionicons name="ellipsis-horizontal" size={18} color={p.muted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    tabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 10 },
    tab: { flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.panel2 },
    tabOn: { backgroundColor: alpha(p.primary, 18) },
    tabText: { color: p.muted, fontSize: 14, fontWeight: '700' },
    tabTextOn: { color: p.primary },
    toolbar: { paddingHorizontal: 12, paddingVertical: 10 },
    search: {
      minHeight: 40, borderRadius: 10, paddingHorizontal: 12, fontSize: 15,
      backgroundColor: p.panel2, color: p.text,
    },
    noticeBox: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 10, backgroundColor: p.panel2 },
    noticeText: { color: p.text, fontSize: 13 },
    list: { paddingHorizontal: 12, paddingBottom: 24, gap: 12 },
    summary: { color: p.muted, fontSize: 12, marginBottom: 2 },
    empty: { color: p.muted, fontSize: 14, textAlign: 'center', padding: 24, lineHeight: 20 },
    card: {
      gap: 10, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
      borderColor: p.border, backgroundColor: p.panel,
    },
    top: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
    title: { color: p.text, fontSize: 16, fontWeight: '800', maxWidth: '100%', marginRight: 2 },
    tag: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, maxWidth: '100%' },
    tagText: { fontSize: 11, fontWeight: '700' },
    desc: { color: p.muted, fontSize: 13, lineHeight: 19, minHeight: 38 },
    preview: {
      width: '100%', aspectRatio: 16 / 10, borderRadius: 10, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: p.border, backgroundColor: p.panel2,
    },
    previewImage: { width: '100%', height: '100%' },
    fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: alpha(p.primary, 10) },
    fallbackIcon: {
      width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.panel,
    },
    fallbackText: { color: p.primary, fontSize: 12, fontWeight: '700' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    btn: {
      minHeight: 36, minWidth: 56, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: p.border, backgroundColor: p.panel,
    },
    btnStrong: { borderColor: p.primary, backgroundColor: alpha(p.primary, 12) },
    btnOff: { opacity: 0.45 },
    btnText: { color: p.text, fontSize: 13, fontWeight: '700' },
    btnTextStrong: { color: p.primary },
    more: { marginLeft: 'auto', width: TAP, height: 36, alignItems: 'center', justifyContent: 'center' },
  });
}
