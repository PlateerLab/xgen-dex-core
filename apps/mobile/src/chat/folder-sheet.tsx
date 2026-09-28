/**
 * [폴더 연결] — 이 대화에서 에이전트가 파일을 다룰 수 있는 휴대폰의 폴더.
 *
 * 폴더는 대화에 붙는다. 연결한 폴더 안에서만 파일 도구가 돌고, 연결을 해제하면
 * 다음 요청부터 그 폴더를 쓰지 않는다. 폴더는 시스템 폴더 선택기로만 더해진다.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { folderStore, useChatFolders } from '../lib/folder-store';
import { friendlyError } from '../lib/errors';
import { TAP, alpha, useP } from '../theme';

/** 대화 머리의 [폴더 연결] — 연결된 폴더 수를 함께 보인다. */
export function FolderPill({ count, onPress }: { count: number; onPress: () => void }): React.ReactElement {
  const p = useP();
  const on = count > 0;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={on ? `연결된 폴더 ${count}개` : '폴더 연결'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 8,
        backgroundColor: on ? alpha(p.primary, 14) : p.panel2,
      }}
    >
      <Text style={{ color: on ? p.primary : p.text, fontSize: 12, fontWeight: '700' }}>폴더 연결</Text>
      {on ? (
        <View
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 5,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: p.primary,
          }}
        >
          <Text style={{ color: p.onPrimary, fontSize: 11, fontWeight: '800' }}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function FolderSheet({
  interactionId,
  visible,
  onClose,
}: {
  interactionId: string;
  visible: boolean;
  onClose: () => void;
}): React.ReactElement {
  const p = useP();
  const folders = useChatFolders(interactionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = folderStore.supported();

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(friendlyError(e, '폴더를 바꾸지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

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
        <Text style={{ color: p.text, fontSize: 16, fontWeight: '800' }}>폴더 연결</Text>
        <Text style={{ color: p.muted, fontSize: 13, marginTop: 4, marginBottom: 10, lineHeight: 18 }}>
          연결한 폴더 안에서만 에이전트가 이 휴대폰의 파일을 다룹니다.
        </Text>

        <ScrollView style={{ flexGrow: 0 }}>
          {folders.length === 0 ? (
            <Text style={{ color: p.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' }}>
              연결된 폴더가 없습니다.
            </Text>
          ) : (
            folders.map((folder) => (
              <View
                key={folder.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: p.border,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: p.text, fontSize: 14, fontWeight: '700' }}>
                    {folder.name}
                  </Text>
                  <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12 }}>
                    에이전트에게는 /{folder.name}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void run(() => folderStore.remove(interactionId, folder.id))}
                  disabled={busy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`${folder.name} 연결 해제`}
                  style={{
                    minHeight: TAP,
                    paddingHorizontal: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    backgroundColor: alpha(p.danger, 12),
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Text style={{ color: p.danger, fontSize: 13, fontWeight: '700' }}>해제</Text>
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>

        {error ? <Text style={{ color: p.danger, fontSize: 12.5, marginTop: 10 }}>{error}</Text> : null}
        {!supported ? (
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 10 }}>
            이 기기에서는 폴더 연결을 지원하지 않습니다.
          </Text>
        ) : null}

        <Pressable
          onPress={() => void run(() => folderStore.add(interactionId))}
          disabled={busy || !supported}
          accessibilityRole="button"
          accessibilityLabel="폴더 추가"
          style={{
            marginTop: 14,
            minHeight: TAP,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 8,
            backgroundColor: p.primary,
            opacity: busy || !supported ? 0.6 : 1,
          }}
        >
          {busy ? <ActivityIndicator color={p.onPrimary} /> : null}
          <Text style={{ color: p.onPrimary, fontSize: 15, fontWeight: '800' }}>폴더 추가</Text>
        </Pressable>
        <Text style={{ color: p.muted, fontSize: 12, marginTop: 10, lineHeight: 17 }}>
          연결을 해제하면 다음 요청부터 그 폴더를 쓰지 않습니다.
        </Text>
      </View>
    </Modal>
  );
}
