/**
 * 모델 선택기 — 채팅 입력창 위의 작은 칩과, 누르면 아래에서 올라오는 목록.
 *
 * 지금 모델을 "제공자: 모델"(예 `Anthropic: Haiku 4.5`)로 보이고, 고르면 **이 대화만** 그
 * 모델로 돈다 — 다음 답변부터, 세션을 다시 시작하지 않는다. 다른 화면(웹·PC)에서 바꿔도 곧바로
 * 따라간다(대화 소켓의 `model` 소식). 고정된 에이전트는 보이기만 한다. 규칙은 데스크톱과 같다
 * (@dex/protocol conversation-model).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  MODEL_PICKER_TEXT,
  UNSUPPORTED_MODEL_STATE,
  applyModelNotice,
  orderedChoices,
  sameModel,
  type ConversationModelState,
  type ModelChoice,
} from '@dex/protocol';
import type { XgenMobileClient } from '../lib/xgen';
import { friendlyError } from '../lib/errors';
import { TAP, alpha, useP } from '../theme';

/** 이 대화의 모델 — 읽기·고르기·소식 따라가기. `notice` 는 대화 소켓의 `model` 소식을 넘긴다. */
export function useConversationModel(client: XgenMobileClient, workflowId: string, interactionId: string) {
  const [state, setState] = useState<ConversationModelState>(UNSUPPORTED_MODEL_STATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState(UNSUPPORTED_MODEL_STATE);
    setError('');
    if (!workflowId || !interactionId) return;
    client.api.conversationModel
      .get(interactionId, workflowId)
      .then((next) => alive && setState(next))
      .catch(() => alive && setState(UNSUPPORTED_MODEL_STATE));
    return () => {
      alive = false;
    };
  }, [client, workflowId, interactionId]);

  const notice = useCallback((data: Record<string, unknown>) => setState((cur) => applyModelNotice(cur, data)), []);

  const choose = useCallback(
    async (choice: ModelChoice) => {
      if (sameModel(choice, state.current)) return;
      setSaving(true);
      setError('');
      try {
        setState(await client.api.conversationModel.set(interactionId, workflowId, choice));
      } catch (e) {
        setError(friendlyError(e, MODEL_PICKER_TEXT.failed));
      } finally {
        setSaving(false);
      }
    },
    [client, interactionId, workflowId, state.current],
  );

  return { state, saving, error, choose, notice };
}

/** 입력창 위의 칩 — 지금 모델. 누르면 목록. */
export function ModelChip({
  state,
  saving,
  onPress,
}: {
  state: ConversationModelState;
  saving: boolean;
  onPress: () => void;
}): React.ReactElement | null {
  const p = useP();
  if (!state.supported || !state.current) return null;
  return (
    <Pressable
      onPress={onPress}
      disabled={state.locked || saving}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`모델: ${state.current.label}`}
      accessibilityHint={state.locked ? MODEL_PICKER_TEXT.locked : '눌러서 이 대화의 모델을 고릅니다'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 5,
        maxWidth: '100%',
        paddingHorizontal: 9,
        paddingVertical: 4,
        marginBottom: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: p.panel,
        opacity: state.locked ? 0.7 : 1,
      }}
    >
      <Ionicons name="hardware-chip-outline" size={13} color={p.muted} />
      <Text numberOfLines={1} style={{ color: p.text, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>
        {state.current.label}
      </Text>
      {saving ? <ActivityIndicator size="small" color={p.muted} /> : state.locked ? null : <Ionicons name="chevron-down" size={12} color={p.muted} />}
    </Pressable>
  );
}

/** 아래에서 올라오는 목록 — 지금 모델이 맨 위, 제공자가 바뀌는 자리에 줄. */
export function ModelSheet({
  state,
  visible,
  error,
  onPick,
  onClose,
}: {
  state: ConversationModelState;
  visible: boolean;
  error: string;
  onPick: (choice: ModelChoice) => void;
  onClose: () => void;
}): React.ReactElement {
  const p = useP();
  const choices = useMemo(() => orderedChoices(state), [state]);
  const current = state.current;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} accessibilityLabel="닫기" onPress={onClose} />
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '75%',
          backgroundColor: p.panel,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderWidth: 1,
          borderColor: p.border,
          padding: 16,
          paddingBottom: 28,
        }}
      >
        <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center', marginBottom: 10 }} />
        <Text style={{ color: p.text, fontSize: 16, fontWeight: '800' }}>{MODEL_PICKER_TEXT.title}</Text>
        <Text style={{ color: p.muted, fontSize: 13, marginTop: 4, marginBottom: 8 }}>{MODEL_PICKER_TEXT.nextTurn}</Text>
        <ScrollView style={{ flexGrow: 0 }}>
          {choices.map((c, i) => {
            const isCurrent = sameModel(c, current);
            const prev = choices[i - 1];
            const sep = i > 0 && (sameModel(prev, current) || prev.group !== c.group);
            return (
              <View key={`${c.provider}:${c.model}`}>
                {sep ? <View style={{ height: 1, backgroundColor: p.border, marginVertical: 4 }} /> : null}
                <Pressable
                  onPress={() => onPick(c)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isCurrent }}
                  accessibilityLabel={isCurrent ? `${c.label}, 현재 모델` : c.label}
                  style={{
                    minHeight: TAP,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 8,
                    borderRadius: 10,
                    backgroundColor: isCurrent ? alpha(p.primary, 10) : 'transparent',
                  }}
                >
                  <View style={{ width: 18 }}>
                    {isCurrent ? <Ionicons name="checkmark" size={17} color={p.primary} /> : null}
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 14, fontWeight: isCurrent ? '800' : '500' }}>
                    {c.label}
                  </Text>
                  {isCurrent ? (
                    <Text style={{ color: p.primary, fontSize: 11.5, fontWeight: '700' }}>{MODEL_PICKER_TEXT.current}</Text>
                  ) : null}
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
        {error ? <Text style={{ color: p.danger, fontSize: 12.5, marginTop: 10 }}>{error}</Text> : null}
      </View>
    </Modal>
  );
}
