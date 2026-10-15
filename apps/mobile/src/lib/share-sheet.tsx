/**
 * 공유 시트 부품: 앱 공유·채팅 공유 시트가 함께 쓴다(데스크톱·웹 공유 창과 같은 내용).
 *
 *   ShareSheet          아래에서 올라오는 시트(제목·닫기·내용·아래 단추 줄)
 *   ShareAudienceRows   공개 범위 두 갈래(XGEN 사용자에게 / 모두에게)
 *   ShareToggle         함께 공유할 것 한 줄(작업 과정·파일)
 *   ShareLinkBox        만든 링크 + [링크 복사]·[보내기](기기의 공유 시트)
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import type { ShareAudience } from '@dex/protocol';
import { alpha, MONO, TAP, useP } from '../theme';

export function ShareSheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  const p = useP();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} accessibilityLabel="닫기" onPress={onClose} />
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '88%',
          backgroundColor: p.panel,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderWidth: 1,
          borderColor: p.border,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 24,
        }}
      >
        <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center', marginBottom: 10 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 16, fontWeight: '800' }}>
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="닫기"
            style={{ minWidth: TAP, minHeight: TAP, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Ionicons name="close" size={22} color={p.muted} />
          </Pressable>
        </View>
        <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        {footer ? <View style={{ marginTop: 12 }}>{footer}</View> : null}
      </View>
    </Modal>
  );
}

export function ShareSectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  const p = useP();
  return <Text style={{ color: p.text, fontSize: 13, fontWeight: '800', marginTop: 14, marginBottom: 8 }}>{children}</Text>;
}

export function ShareAudienceRows({
  value,
  onChange,
  disabled,
  labels,
}: {
  value: ShareAudience;
  onChange: (next: ShareAudience) => void;
  disabled?: boolean;
  labels: Record<ShareAudience, { title: string; hint: string }>;
}): React.ReactElement {
  const p = useP();
  return (
    <View style={{ gap: 8 }} accessibilityRole="radiogroup">
      {(['users', 'public'] as const).map((key) => {
        const on = value === key;
        return (
          <Pressable
            key={key}
            disabled={disabled}
            onPress={() => onChange(key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: on ? p.primary : p.border,
              backgroundColor: on ? alpha(p.primary, 8) : p.panel,
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <Ionicons
              name={key === 'users' ? 'lock-closed-outline' : 'globe-outline'}
              size={19}
              color={on ? p.primary : p.muted}
              style={{ marginTop: 1 }}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: on ? p.primary : p.text, fontSize: 14.5, fontWeight: '700' }}>{labels[key].title}</Text>
              <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>{labels[key].hint}</Text>
            </View>
            <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? p.primary : p.border} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function ShareToggle({
  checked,
  onChange,
  title,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  hint: string;
  disabled?: boolean;
}): React.ReactElement {
  const p = useP();
  return (
    <Pressable
      disabled={disabled}
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8, opacity: disabled ? 0.6 : 1 }}
    >
      <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={21} color={checked ? p.primary : p.muted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: p.text, fontSize: 14.5, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>{hint}</Text>
      </View>
    </Pressable>
  );
}

export function ShareLinkBox({
  url,
  copyLabel,
  copiedLabel,
}: {
  url: string;
  copyLabel: string;
  copiedLabel: string;
}): React.ReactElement {
  const p = useP();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await Clipboard.setStringAsync(url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text
        selectable
        numberOfLines={2}
        style={{
          color: p.text,
          fontFamily: MONO,
          fontSize: 12.5,
          backgroundColor: p.panel2,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        {url}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ShareButton label={copied ? copiedLabel : copyLabel} icon="copy-outline" onPress={() => void copy()} primary />
        <ShareButton label="보내기" icon="share-outline" onPress={() => void Share.share({ message: url }).catch(() => undefined)} />
      </View>
    </View>
  );
}

export function ShareButton({
  label,
  onPress,
  icon,
  primary,
  danger,
  disabled,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  const p = useP();
  const color = primary ? p.onPrimary : danger ? p.danger : p.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{
        flex: 1,
        minHeight: TAP,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: primary ? 0 : 1,
        borderColor: danger ? alpha(p.danger, 50) : p.border,
        backgroundColor: primary ? p.primary : p.panel,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <Ionicons name={icon} size={16} color={color} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 14, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ShareMessage({ text, tone }: { text: string; tone: 'ok' | 'error' | 'warn' | 'muted' }): React.ReactElement | null {
  const p = useP();
  if (!text) return null;
  const color = tone === 'ok' ? p.ok : tone === 'error' ? p.danger : tone === 'warn' ? '#B54708' : p.muted;
  return <Text style={{ color, fontSize: 12.5, lineHeight: 18, marginTop: 8 }}>{text}</Text>;
}
