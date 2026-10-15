/**
 * [폴더 연결] — 이 대화에서 에이전트가 파일을 다룰 수 있는 휴대폰의 폴더.
 *
 * 폴더는 대화에 붙는다. 연결한 폴더 안에서만 파일 도구가 돌고, 연결을 해제하면
 * 다음 요청부터 그 폴더를 쓰지 않는다. 폴더는 시스템 폴더 선택기로만 더해진다.
 *
 * 한 대화에 여러 기기의 폴더가 함께 붙을 수 있다 — 이 휴대폰의 폴더 아래에 다른 기기(PC 등)의
 * 폴더 이름과 켜짐 여부를 보인다. 대화당 기기 하나만 받는 옛 서버면 예전처럼 그 기기를 보이고
 * [이 기기로 옮기기] 를 준다. 웹·PC 에서 보낸 턴이 이 휴대폰의 폴더를 쓰면 알린다.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { folderStore, useChatFolderRemote, useChatFolders } from '../lib/folder-store';
import { friendlyError } from '../lib/errors';
import { TAP, alpha, useP } from '../theme';

export function sinceLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/**
 * 대화 머리의 [폴더 연결] — 연결된 폴더 수를 함께 보인다.
 * 폴더가 다른 기기에 있으면(`elsewhereName`) 그 수를 흐리게 보인다.
 */
export function FolderPill({
  count,
  onPress,
  elsewhereName,
}: {
  count: number;
  onPress: () => void;
  elsewhereName?: string;
}): React.ReactElement {
  const p = useP();
  const on = count > 0 && !elsewhereName;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        elsewhereName ? `이 대화의 폴더 ${count}개는 ${elsewhereName}에 있습니다` : on ? `연결된 폴더 ${count}개` : '폴더 연결'
      }
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
      {elsewhereName && count > 0 ? (
        <View
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 5,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: p.border,
          }}
        >
          <Text style={{ color: p.muted, fontSize: 11, fontWeight: '800' }}>{count}</Text>
        </View>
      ) : null}
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
  const remote = useChatFolderRemote(interactionId, visible);
  const device = remote.state?.device ?? null;
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

        {remote.elsewhere && device ? (
          <View style={{ backgroundColor: p.panel2, borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, color: p.text, fontSize: 14, lineHeight: 20 }}>
                이 대화의 폴더는 <Text style={{ fontWeight: '800' }}>{device.name}</Text>에 있습니다
              </Text>
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 999,
                  backgroundColor: device.online ? alpha(p.primary, 14) : p.panel,
                }}
              >
                <Text style={{ color: device.online ? p.primary : p.muted, fontSize: 11.5, fontWeight: '700' }}>
                  {device.online ? '켜짐' : '꺼짐'}
                </Text>
              </View>
            </View>
            {(remote.state?.folders ?? []).map((folder) => (
              <Text key={folder.id || folder.name} numberOfLines={1} style={{ color: p.text, fontSize: 13, marginTop: 6 }}>
                {folder.name}
              </Text>
            ))}
            <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 8, lineHeight: 18 }}>
              {device.online
                ? '이 휴대폰에서 보낸 요청도 그 기기의 폴더를 사용합니다.'
                : '그 기기가 켜지면 다시 사용할 수 있습니다.'}
            </Text>
          </View>
        ) : null}

        <ScrollView style={{ flexGrow: 0 }}>
          {remote.elsewhere ? null : folders.length === 0 ? (
            <Text style={{ color: p.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' }}>
              {remote.others.length ? '이 휴대폰에 연결된 폴더가 없습니다.' : '연결된 폴더가 없습니다.'}
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
          {remote.others.map((other) => (
            <View key={other.deviceId} style={{ backgroundColor: p.panel2, borderRadius: 12, padding: 12, marginTop: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 14, fontWeight: '800' }}>
                  {other.name}
                </Text>
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 999,
                    backgroundColor: other.online ? alpha(p.primary, 14) : p.panel,
                  }}
                >
                  <Text style={{ color: other.online ? p.primary : p.muted, fontSize: 11.5, fontWeight: '700' }}>
                    {other.online ? '켜짐' : '꺼짐'}
                  </Text>
                </View>
              </View>
              {other.folders.map((folder) => (
                <Text key={folder.id || folder.name} numberOfLines={1} style={{ color: p.text, fontSize: 13, marginTop: 6 }}>
                  {folder.name}
                </Text>
              ))}
            </View>
          ))}
          {remote.others.length ? (
            <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 8, lineHeight: 18 }}>
              다른 기기의 폴더도 이 대화에서 함께 쓰입니다. 그 기기가 켜져 있을 때만 사용할 수 있고, 연결과 해제는 그
              기기에서 합니다.
            </Text>
          ) : null}
        </ScrollView>

        {remote.lastRemoteUse && folders.length > 0 ? (
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 10, lineHeight: 18 }}>
            {remote.lastRemoteUse.originName}에서 온 요청으로 이 휴대폰의 폴더를 사용했습니다 ·{' '}
            {sinceLabel(remote.lastRemoteUse.at)}
          </Text>
        ) : null}
        {error ? <Text style={{ color: p.danger, fontSize: 12.5, marginTop: 10 }}>{error}</Text> : null}
        {!supported ? (
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 10 }}>
            이 기기에서는 폴더 연결을 지원하지 않습니다.
          </Text>
        ) : null}

        <Pressable
          onPress={() => void run(() => folderStore.add(interactionId, { takeOver: remote.elsewhere }))}
          disabled={busy || !supported}
          accessibilityRole="button"
          accessibilityLabel={remote.elsewhere ? '이 기기로 옮기기' : '폴더 추가'}
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
          <Text style={{ color: p.onPrimary, fontSize: 15, fontWeight: '800' }}>
            {remote.elsewhere ? '이 기기로 옮기기' : '폴더 추가'}
          </Text>
        </Pressable>
        <Text style={{ color: p.muted, fontSize: 12, marginTop: 10, lineHeight: 17 }}>
          {remote.elsewhere
            ? '옮기면 이 휴대폰에서 고른 폴더가 이 대화의 폴더가 되고 다른 기기의 연결은 해제됩니다.'
            : '연결을 해제하면 다음 요청부터 그 폴더를 쓰지 않습니다.'}
        </Text>
      </View>
    </Modal>
  );
}
