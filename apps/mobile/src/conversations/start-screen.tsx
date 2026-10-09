/**
 * 시작 화면 (2026-10-09): [+ 새 채팅] 이 여는 곳.
 *
 *   오늘은 무엇을 해볼까요?
 *   에이전트 [새 에이전트로 시작 ▾]        첫 칸이자 기본값, 그 아래 내 에이전트들
 *   (새 에이전트면) 이름 · AI 제공자 · 모델 · [세부 설정 ▸]
 *   [입력창                         ➤]
 *
 * 입력창은 보낼 수 있을 때만 풀린다(규칙은 conversation-model 의 startComposerLock). 새 에이전트는 이름이
 * 있고 같은 이름이 없어야 한다: 적는 대로 잠깐 멈추면 서버에 묻고(nameTaken), 만들기 직전에 한 번 더 묻는다.
 * 보내면 새 에이전트는 만들고, 그 에이전트로 새 대화를 열어 적은 글을 첫 메시지로 보낸다
 * (채팅 화면이 소켓이 붙을 때 한 번 보낸다. initial-message).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Agent, AgentCreateOptions, AgentCreateSetting } from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import { diagLog } from '../lib/diag';
import type { XgenMobileClient } from '../lib/xgen';
import {
  START_TEXT,
  isNumericSetting,
  nameCheckState,
  orderedSettings,
  settingsPayload,
  startComposerLock,
} from './conversation-model';

/** 이름을 적다가 이만큼 멈추면 서버에 묻는다. */
const NAME_CHECK_DELAY_MS = 300;

/** 시작 화면을 여는 표식. `seq` 가 바뀔 때마다 고른 것을 처음으로 되돌린다. `agent` 를 주면 그것을 골라 둔다. */
export interface StartPreset {
  seq: number;
  agent?: Agent | null;
}

export function StartScreen({
  client,
  visible,
  preset,
  onStart,
}: {
  client: XgenMobileClient;
  visible: boolean;
  preset: StartPreset;
  /** 고른(또는 막 만든) 에이전트로 새 대화를 열고 `text` 를 첫 메시지로 보낸다. */
  onStart: (agent: Agent, text: string) => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);

  // ── 에이전트 고르기 ── ('' = 새 에이전트로 시작)
  const [selected, setSelected] = useState('');
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsError, setAgentsError] = useState('');
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');

  // ── 새 에이전트 ──
  const [name, setName] = useState('');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const checksRef = useRef(checks);
  checksRef.current = checks;
  const [options, setOptions] = useState<AgentCreateOptions | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [optionsError, setOptionsError] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [edits, setEdits] = useState<Record<string, unknown>>({});

  // ── 입력창 ──
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  /** 잠긴 입력창을 눌렀다: 풀릴 때까지 지금의 잠금 이유를 보여 준다. */
  const [showLock, setShowLock] = useState(false);
  const [error, setError] = useState('');

  // 열 때마다 처음으로(목록의 [+ 새 채팅]), 또는 넘겨받은 에이전트를 골라 둔다(채팅의 [새 대화]).
  useEffect(() => {
    setSelected(preset.agent?.workflowId ?? '');
    setName('');
    setEdits({});
    setAdvanced(false);
    setShowLock(false);
    setError('');
    setPicker(false);
    setQuery('');
  }, [preset.seq, preset.agent]);

  const loadAgents = useCallback(async () => {
    try {
      const list = await client.api.agents.listAll({ pageSize: 100 }, 5);
      setAgents(list);
      setAgentsError('');
    } catch (e) {
      setAgentsError(friendlyError(e, '에이전트 목록을 불러오지 못했습니다.'));
    }
  }, [client]);

  const loadOptions = useCallback(async () => {
    setOptionsError('');
    try {
      const opts = await client.api.agents.createOptions();
      setOptions(opts);
      const def = opts.providers.find((x) => x.value === opts.defaultProvider) ?? opts.providers[0];
      if (def) {
        setProvider(def.value);
        setModel(def.defaultModel ?? def.models[0]?.value ?? '');
      }
    } catch (e) {
      setOptionsError(friendlyError(e, '생성 옵션을 불러오지 못했습니다.'));
    }
  }, [client]);

  // 보일 때 읽는다. 에이전트는 그사이 바뀌었을 수 있어 매번, 만들기 옵션은 받을 때까지.
  useEffect(() => {
    if (!visible) return;
    void loadAgents();
    if (!optionsRef.current) void loadOptions();
  }, [visible, loadAgents, loadOptions]);

  const newAgent = selected === '';
  const selectedAgent = useMemo(() => {
    if (!selected) return null;
    return agents?.find((a) => a.workflowId === selected) ?? (preset.agent?.workflowId === selected ? preset.agent : null);
  }, [agents, selected, preset.agent]);

  // 같은 이름이 있는가: 적다가 잠깐 멈추면 묻는다. 답은 이름별로 기억한다(늦게 온 앞 이름의 답이 지금 이름을 덮지 않는다).
  useEffect(() => {
    if (!newAgent) return;
    const trimmed = name.trim();
    if (!trimmed || Object.prototype.hasOwnProperty.call(checksRef.current, trimmed)) return;
    const t = setTimeout(() => {
      void client.api.agents
        .nameTaken(trimmed)
        .catch(() => false) // 묻지 못했으면 막지 않는다. 만들기 직전에 다시 묻는다.
        .then((taken) => setChecks((cur) => ({ ...cur, [trimmed]: taken })));
    }, NAME_CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [client, name, newAgent]);

  const nameCheck = nameCheckState(name, checks);
  const lock = startComposerLock({
    newAgent,
    nameCheck,
    optionsReady: !!options && !!provider,
    agentSelected: !!selectedAgent,
    busy,
  });
  // 풀리면 잠금 이유를 걷는다.
  useEffect(() => {
    if (!lock.locked) setShowLock(false);
  }, [lock.locked]);

  const submit = useCallback(async () => {
    if (lock.locked) {
      setShowLock(true);
      return;
    }
    const body = text.trim();
    if (!body) return;
    setError('');
    setShowLock(false);
    if (!newAgent) {
      if (!selectedAgent) return;
      setText('');
      onStart(selectedAgent, body);
      return;
    }
    const trimmed = name.trim();
    setBusy(true);
    try {
      // 만들기 직전에 한 번 더: 적은 뒤에 누가 같은 이름을 만들었을 수 있다.
      const taken = await client.api.agents.nameTaken(trimmed).catch(() => false);
      if (taken) {
        setChecks((cur) => ({ ...cur, [trimmed]: true }));
        setShowLock(true);
        return;
      }
      const created = await client.api.agents.create({
        name: trimmed,
        provider,
        model: model || undefined,
        settings: settingsPayload(options?.settings ?? [], edits),
      });
      diagLog(`새 에이전트 생성: ${created.workflowName} (${created.workflowId})`);
      const agent: Agent = {
        id: 0,
        workflowId: created.workflowId,
        workflowName: created.workflowName,
        nodeCount: 0,
        isShared: false,
        isDeployed: false,
        isCompleted: false,
        description: '',
        username: '',
        fullName: '',
        createdAt: '',
        updatedAt: '',
        hasAgentGeny: true,
      };
      setText('');
      setName('');
      setEdits({});
      setAdvanced(false);
      onStart(agent, body);
    } catch (e) {
      setError(friendlyError(e, '에이전트 생성에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  }, [client, edits, lock, model, name, newAgent, onStart, options, provider, selectedAgent, text]);

  const current = options?.providers.find((x) => x.value === provider);
  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = agents ?? [];
    return q ? base.filter((a) => `${a.workflowName ?? ''} ${a.workflowId ?? ''}`.toLowerCase().includes(q)) : base;
  }, [agents, query]);

  const valueOf = (s: AgentCreateSetting): unknown =>
    Object.prototype.hasOwnProperty.call(edits, s.id)
      ? edits[s.id]
      : Object.prototype.hasOwnProperty.call(options?.defaults ?? {}, s.id)
        ? options?.defaults[s.id]
        : s.default;

  const canSend = !lock.locked && !!text.trim();
  // 입력창 위 한 줄: 만드는 중 > 잠금 이유(누른 뒤) > 실패. 확인·불러오는 중은 오류가 아니라 흐리게.
  // 모델 목록을 못 받았으면 "불러오는 중" 대신 그 실패를 댄다.
  const lockReason = lock.reason === START_TEXT.optionsLoading && optionsError ? optionsError : lock.reason;
  const bottomNotice: { text: string; muted: boolean } | null = busy
    ? { text: START_TEXT.creating, muted: true }
    : showLock && lock.locked
      ? { text: lockReason, muted: lockReason === START_TEXT.checking || lockReason === START_TEXT.optionsLoading }
      : error
        ? { text: error, muted: false }
        : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        <Text style={st.heading}>{START_TEXT.heading}</Text>

        <Text style={st.label}>에이전트</Text>
        <Pressable
          onPress={() => {
            setPicker(true);
            if (!agents) void loadAgents();
          }}
          accessibilityRole="button"
          accessibilityLabel="에이전트 고르기"
          style={({ pressed }) => [st.select, pressed && { backgroundColor: p.panel2 }]}
        >
          <Ionicons
            name={newAgent ? 'add-circle-outline' : 'chatbubble-ellipses-outline'}
            size={18}
            color={newAgent ? p.primary : p.text}
          />
          <Text style={st.selectText} numberOfLines={1}>
            {newAgent ? START_TEXT.newAgent : selectedAgent?.workflowName || selectedAgent?.workflowId || selected}
          </Text>
          <Ionicons name="chevron-down" size={16} color={p.muted} />
        </Pressable>

        {newAgent && (
          <>
            <Text style={st.label}>이름</Text>
            <TextInput
              style={[st.input, nameCheck === 'taken' && { borderColor: p.danger }]}
              value={name}
              onChangeText={setName}
              placeholder="예: 리서치 도우미"
              placeholderTextColor={p.muted}
              autoCorrect={false}
              returnKeyType="done"
              accessibilityLabel="에이전트 이름"
            />
            {nameCheck === 'taken' ? <Text style={st.fieldError}>{START_TEXT.nameTaken}</Text> : null}

            {optionsError ? (
              <View style={st.optionsError}>
                <Text style={st.fieldError}>{optionsError}</Text>
                <Pressable onPress={() => void loadOptions()} accessibilityRole="button" style={st.retry}>
                  <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>다시 시도</Text>
                </Pressable>
              </View>
            ) : !options ? (
              <ActivityIndicator style={{ marginTop: 14 }} color={p.primary} />
            ) : (
              <>
                {options.providers.length > 0 && (
                  <>
                    <Text style={st.label}>AI 제공자</Text>
                    <View style={st.chipsWrap}>
                      {options.providers.map((pr) => (
                        <Chip
                          key={pr.value}
                          label={pr.label}
                          on={provider === pr.value}
                          onPress={() => {
                            // 모델은 제공자에 딸린 것이다. 그대로 두면 다른 회사의 모델 이름으로 부르는 에이전트가 된다.
                            setProvider(pr.value);
                            setModel(pr.defaultModel ?? pr.models[0]?.value ?? '');
                          }}
                        />
                      ))}
                    </View>
                  </>
                )}
                {current && current.models.length > 0 && (
                  <>
                    <Text style={st.label}>모델</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ gap: 8 }}
                    >
                      {current.models.map((m) => (
                        <Chip key={m.value} label={m.label} on={model === m.value} onPress={() => setModel(m.value)} />
                      ))}
                    </ScrollView>
                  </>
                )}
                {options.settings.length > 0 && (
                  <Pressable
                    onPress={() => setAdvanced((v) => !v)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: advanced }}
                    style={st.advancedToggle}
                  >
                    <Text style={{ color: p.muted, fontSize: 13 }}>{advanced ? '▾' : '▸'}</Text>
                    <Text style={{ color: p.text, fontSize: 14, fontWeight: '700' }}>세부 설정</Text>
                  </Pressable>
                )}
                {advanced &&
                  orderedSettings(options.settings).map((s) => (
                    <SettingField
                      key={s.id}
                      setting={s}
                      value={valueOf(s)}
                      onChange={(v) => setEdits((prev) => ({ ...prev, [s.id]: v }))}
                    />
                  ))}
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* 입력창: 보낼 수 있을 때만 풀린다. 잠긴 채로 누르면 이유를 보여 준다. */}
      <View style={st.composerWrap}>
        {bottomNotice ? (
          <Text style={[st.composerNotice, bottomNotice.muted && st.composerNoticeMuted]}>{bottomNotice.text}</Text>
        ) : null}
        <View style={[st.composer, lock.locked && { opacity: 0.6 }]}>
          <View style={{ flex: 1 }}>
            <TextInput
              style={st.composerInput}
              value={text}
              onChangeText={setText}
              editable={!lock.locked}
              placeholder="메시지를 입력하세요"
              placeholderTextColor={p.muted}
              multiline
              accessibilityLabel="메시지 입력"
            />
            {lock.locked && !busy ? (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => setShowLock(true)}
                accessibilityRole="button"
                accessibilityLabel={lockReason}
              />
            ) : null}
          </View>
          <Pressable
            onPress={() => void submit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="보내기"
            style={[st.send, !canSend && { opacity: 0.35 }]}
          >
            {busy ? (
              <ActivityIndicator color={p.onPrimary} />
            ) : (
              <Text style={{ color: p.onPrimary, fontSize: 16, fontWeight: '900', marginLeft: 2 }}>➤</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* 에이전트 고르기: 첫 칸이 [새 에이전트로 시작] */}
      <Modal visible={picker} transparent animationType="slide" onRequestClose={() => setPicker(false)}>
        <Pressable style={st.scrim} accessibilityLabel="닫기" onPress={() => setPicker(false)} />
        <KeyboardAvoidingView behavior="padding" style={st.sheetHost} pointerEvents="box-none">
          <View style={st.sheet}>
            <View style={st.sheetHandle} />
            <TextInput
              style={st.input}
              value={query}
              onChangeText={setQuery}
              placeholder="에이전트 검색…"
              placeholderTextColor={p.muted}
              autoCorrect={false}
              accessibilityLabel="에이전트 검색"
            />
            <FlatList
              data={filteredAgents}
              keyExtractor={(a) => a.workflowId || String(a.id)}
              keyboardShouldPersistTaps="handled"
              style={{ flexGrow: 0, flexShrink: 1 }}
              ListHeaderComponent={
                <PickRow
                  label={START_TEXT.newAgent}
                  icon="add-circle-outline"
                  on={newAgent}
                  strong
                  onPress={() => {
                    setSelected('');
                    setPicker(false);
                  }}
                />
              }
              renderItem={({ item: a }) => (
                <PickRow
                  label={a.workflowName || a.workflowId}
                  sub={a.description}
                  on={selected === a.workflowId}
                  onPress={() => {
                    setSelected(a.workflowId);
                    setPicker(false);
                  }}
                />
              )}
              ListEmptyComponent={
                agentsError ? (
                  <Text style={[st.fieldError, { textAlign: 'center', padding: 16 }]}>{agentsError}</Text>
                ) : !agents ? (
                  <ActivityIndicator style={{ margin: 16 }} color={p.primary} />
                ) : query.trim() ? (
                  <Text style={st.empty}>검색 결과가 없습니다.</Text>
                ) : null
              }
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }): React.ReactElement {
  const p = useP();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        backgroundColor: on ? p.primary : p.panel2,
        borderRadius: 16,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: on ? p.primary : p.border,
      }}
    >
      <Text style={{ color: on ? p.onPrimary : p.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function PickRow({
  label,
  sub,
  icon,
  on,
  strong,
  onPress,
}: {
  label: string;
  sub?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  on: boolean;
  strong?: boolean;
  onPress: () => void;
}): React.ReactElement {
  const p = useP();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: TAP + 4,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 10,
        backgroundColor: on ? alpha(p.primary, 12) : pressed ? p.panel2 : undefined,
      })}
    >
      {icon ? <Ionicons name={icon} size={18} color={p.primary} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: strong ? p.primary : p.text, fontSize: 15, fontWeight: strong || on ? '700' : '600' }}
        >
          {label}
        </Text>
        {sub ? (
          <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12, marginTop: 1 }}>
            {sub}
          </Text>
        ) : null}
      </View>
      {on ? <Ionicons name="checkmark" size={18} color={p.primary} /> : null}
    </Pressable>
  );
}

/** 세부 설정 하나: 노드가 선언한 타입대로 그린다(데스크톱 만들기 화면과 같은 규칙). */
function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: AgentCreateSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const type = (setting.type || '').toUpperCase();
  const description = setting.description ? <Text style={st.settingSub}>{setting.description}</Text> : null;

  if (type === 'BOOL') {
    return (
      <View style={st.settingRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={st.settingLabel}>{setting.label}</Text>
          {description}
        </View>
        <Switch value={value === true} onValueChange={onChange} trackColor={{ true: p.primary }} />
      </View>
    );
  }

  if (setting.options && setting.options.length > 0) {
    return (
      <View style={st.setting}>
        <Text style={st.settingLabel}>{setting.label}</Text>
        <View style={st.chipsWrap}>
          {setting.options.map((o) => (
            <Chip key={o.value} label={o.label} on={String(value ?? '') === o.value} onPress={() => onChange(o.value)} />
          ))}
        </View>
        {description}
      </View>
    );
  }

  const numeric = isNumericSetting(setting);
  // 시스템 프롬프트는 한 줄로 받으면 쓸 수가 없다.
  const multiline = setting.id === 'system_prompt';
  return (
    <View style={st.setting}>
      <Text style={st.settingLabel}>{setting.label}</Text>
      <TextInput
        style={[st.input, multiline && { minHeight: 110, textAlignVertical: 'top' }]}
        value={value === null || value === undefined ? '' : String(value)}
        onChangeText={(v) => onChange(v)}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        multiline={multiline}
        autoCorrect={false}
        autoCapitalize="none"
        placeholderTextColor={p.muted}
        accessibilityLabel={setting.label}
      />
      {description}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    body: { padding: 16, paddingBottom: 24, gap: 8, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { color: p.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3, marginTop: 8, marginBottom: 8 },
    label: { fontSize: 12, color: p.muted, fontWeight: '600', marginTop: 8 },
    select: {
      flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP + 4,
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 12, paddingHorizontal: 14,
    },
    selectText: { flex: 1, color: p.text, fontSize: 15, fontWeight: '700' },
    input: {
      backgroundColor: p.panel, color: p.text, borderWidth: 1, borderColor: p.border,
      borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, width: '100%',
    },
    fieldError: { color: p.danger, fontSize: 12.5 },
    optionsError: { gap: 8, marginTop: 8 },
    retry: { alignSelf: 'flex-start', backgroundColor: p.panel2, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
    chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    advancedToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TAP, marginTop: 4 },
    setting: { gap: 6, marginTop: 6 },
    settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
    settingLabel: { color: p.text, fontSize: 13.5, fontWeight: '700' },
    settingSub: { color: p.muted, fontSize: 12, lineHeight: 17 },
    empty: { color: p.muted, fontSize: 14, textAlign: 'center', padding: 16 },

    composerWrap: {
      backgroundColor: p.panel, borderTopWidth: 1, borderTopColor: p.border, padding: 8, paddingBottom: 14, gap: 6,
    },
    composerNotice: {
      color: p.danger, fontSize: 13, backgroundColor: alpha(p.danger, 10), borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 8, overflow: 'hidden',
    },
    composerNoticeMuted: { color: p.muted, backgroundColor: p.panel2 },
    composer: {
      flexDirection: 'row', alignItems: 'flex-end', gap: 6,
      backgroundColor: p.panel2, borderWidth: 1, borderColor: p.border, borderRadius: 22,
      paddingLeft: 14, paddingRight: 6, paddingVertical: 6,
    },
    composerInput: { color: p.text, fontSize: 15.5, maxHeight: 140, paddingVertical: 8 },
    send: {
      width: 38, height: 38, borderRadius: 19, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center',
    },

    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
    sheetHost: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      width: '100%', maxHeight: '80%', backgroundColor: p.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      borderWidth: 1, borderColor: p.border, padding: 16, paddingBottom: 28, gap: 10,
    },
    sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center' },
  });
}
