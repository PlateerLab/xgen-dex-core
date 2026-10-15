/**
 * 화면 위에 덮는 한 장 — 앱 보기·에이전트 상세·파일 보기가 같은 머리(뒤로·제목·단추)를 쓴다.
 *
 * 이 앱에는 화면 쌓기(내비게이터)가 없다 — 칸들이 모두 떠 있고 숨겨질 뿐이라(채팅 소켓과 스크롤을 살리려고)
 * 위에 덮는 화면은 Modal 로 연다. 기기의 뒤로 단추(안드로이드)는 이 화면을 닫는다.
 */
import React from 'react';
import { Modal, Platform, Pressable, StatusBar as RnStatusBar, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TAP, useP } from '../theme';

export interface ScreenAction {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export const ScreenModal: React.FC<{
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  actions?: ScreenAction[];
  children: React.ReactNode;
}> = ({ visible, title, subtitle, onClose, actions = [], children }) => {
  const p = useP();
  const top = Platform.OS === 'android' ? (RnStatusBar.currentHeight ?? 0) : 50;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <View style={[st.root, { backgroundColor: p.bg }]}>
        <View style={[st.head, { paddingTop: top + 6, backgroundColor: p.panel, borderBottomColor: p.border }]}>
          <Pressable onPress={onClose} style={st.btn} accessibilityRole="button" accessibilityLabel="뒤로" hitSlop={6}>
            <Ionicons name="chevron-back" size={24} color={p.text} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[st.title, { color: p.text }]} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={[st.subtitle, { color: p.muted }]} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {actions.map((a) => (
            <Pressable
              key={a.label}
              onPress={a.onPress}
              disabled={a.disabled}
              style={[st.btn, a.disabled && { opacity: 0.4 }]}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              hitSlop={6}
            >
              <Ionicons name={a.icon} size={21} color={p.text} />
            </Pressable>
          ))}
        </View>
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    </Modal>
  );
};

const st = StyleSheet.create({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingBottom: 8, borderBottomWidth: 1 },
  btn: { width: TAP, height: TAP, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 12, marginTop: 1 },
});
