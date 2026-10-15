/**
 * 대화 한 줄의 시트 (2026-10-10): [열기] · [이름 바꾸기] · [삭제].
 *
 * 채팅 목록(길게 누르기·[⋯]), 에이전트의 대화 화면, 채팅 기록 관리가 같은 시트를 쓴다. [열기] 는 관리 화면에만
 * 있다(목록은 줄을 누르면 열린다). 위에 덮은 화면(Modal) 안에서 쓸 때는 그 화면 안에 그려서 그 위에 뜨게 한다.
 * [삭제] 는 묻기를 부른 쪽에 맡긴다(한 줄과 여러 줄의 물음이 다르다).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { conversationDisplayTitle, type Conversation } from '@dex/protocol';
import { alpha, TAP, useP, type Palette } from '../theme';
import { friendlyError } from '../lib/errors';
import { CONVERSATION_TEXT } from './conversation-model';

export function ConversationSheet({
  conversation,
  openLabel,
  onOpen,
  onRename,
  onRemove,
  onClose,
}: {
  /** 시트를 연 대화. null 이면 닫혀 있다. */
  conversation: Conversation | null;
  /** [열기] 줄의 말. 없으면 그 줄을 그리지 않는다. */
  openLabel?: string;
  onOpen?: (c: Conversation) => void;
  /** 이름을 바꾼다. 실패하면 던진다(시트가 그 까닭을 보여 준다). */
  onRename: (c: Conversation, title: string) => Promise<void>;
  /** [삭제] 를 골랐다. 시트는 닫히고, 묻기와 지우기는 부른 쪽이 한다. */
  onRemove: (c: Conversation) => void;
  onClose: () => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  /** 이름을 바꾸는 중이면 그 글. null 이면 메뉴 단계. */
  const [renameText, setRenameText] = useState<string | null>(null);
  const [renameError, setRenameError] = useState('');
  const [busy, setBusy] = useState(false);

  // 다른 대화로 열리면 메뉴 단계부터.
  useEffect(() => {
    setRenameText(null);
    setRenameError('');
  }, [conversation]);

  const save = useCallback(async () => {
    const c = conversation;
    if (!c || renameText == null || busy) return;
    const next = renameText.trim();
    if (next === c.title.trim()) {
      onClose();
      return;
    }
    setBusy(true);
    setRenameError('');
    try {
      await onRename(c, next);
      onClose();
    } catch (e) {
      setRenameError(friendlyError(e, '이름을 바꾸지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }, [busy, conversation, onClose, onRename, renameText]);

  const c = conversation;
  return (
    <Modal visible={!!c} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.scrim} accessibilityLabel="닫기" onPress={onClose} />
      {/* 이름 칸에 키보드가 뜨면 겹치는 만큼만 시트를 올린다(App 의 시트와 같은 방식). */}
      <KeyboardAvoidingView behavior="padding" style={st.sheetHost} pointerEvents="box-none">
        {c ? (
          <View style={st.sheet}>
            <View style={st.sheetHandle} />
            <Text style={st.sheetTitle} numberOfLines={1}>
              {conversationDisplayTitle(c)}
            </Text>
            {renameText == null ? (
              <>
                {openLabel && onOpen ? (
                  <Pressable
                    onPress={() => onOpen(c)}
                    accessibilityRole="button"
                    style={({ pressed }) => [st.menuRow, pressed && { backgroundColor: p.panel2 }]}
                  >
                    <Ionicons name="chatbubble-outline" size={18} color={p.text} />
                    <Text style={st.menuText}>{openLabel}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    setRenameText(c.title);
                    setRenameError('');
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [st.menuRow, pressed && { backgroundColor: p.panel2 }]}
                >
                  <Ionicons name="create-outline" size={18} color={p.text} />
                  <Text style={st.menuText}>{CONVERSATION_TEXT.rename}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    onClose();
                    onRemove(c);
                  }}
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
                  placeholder={conversationDisplayTitle(c)}
                  placeholderTextColor={p.muted}
                  autoFocus
                  maxLength={200}
                  returnKeyType="done"
                  onSubmitEditing={() => void save()}
                  accessibilityLabel="채팅 이름"
                />
                {renameError ? <Text style={st.formError}>{renameError}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={onClose} accessibilityRole="button" style={[st.btn, { flex: 1 }]}>
                    <Text style={st.btnText}>취소</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void save()}
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
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
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
