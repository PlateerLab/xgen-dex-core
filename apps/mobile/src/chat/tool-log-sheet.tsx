/**
 * 한 답변에서 쓴 도구의 **전체** 기록 — 바닥에서 올라오는 시트.
 *
 * 흐름에는 하나씩 지나가게 두고, 무언가 잘못됐을 때 여기서 전부·순서대로·인자와
 * 결과까지 본다(데스크톱 [도구 실행 기록] 과 같은 내용).
 *
 * 폰에서는 복사가 더 중요하다 — 긴 결과를 손으로 긁는 것은 사실상 불가능하므로
 * 항목마다, 그리고 전체에 복사를 붙인다. 이름 줄이기·상태·복사 텍스트 규칙은
 * 정본(@dex/protocol tool-activity)이 정한다.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  formatToolLog,
  shortToolName,
  toolPhase,
  toolValueText,
  type ToolEvent,
} from '@dex/protocol';
import { MONO, TAP, alpha, useP } from '../theme';

export const ToolLogSheet: React.FC<{
  events: readonly ToolEvent[];
  /** 이 항목을 펼친 채 연다 — 흐름의 칩을 눌러 "그 시점" 으로 바로 들어오는 길. */
  initialOpen?: number;
  onClose: () => void;
}> = ({ events, initialOpen, onClose }) => {
  const p = useP();
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(initialOpen !== undefined && initialOpen >= 0 ? [initialOpen] : []),
  );
  const [copied, setCopied] = useState('');
  const all = useMemo(() => formatToolLog(events), [events]);

  const copy = async (value: string, key: string): Promise<void> => {
    await Clipboard.setStringAsync(value);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((k) => (k === key ? '' : k)), 1500);
  };

  const toggle = (i: number): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
        accessibilityLabel="닫기"
        onPress={onClose}
      />
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '85%',
          backgroundColor: p.panel,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderWidth: 1,
          borderColor: p.border,
          paddingBottom: 24,
        }}
      >
        <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center', marginTop: 8 }} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: p.border,
          }}
        >
          <Text style={{ flex: 1, color: p.text, fontSize: 16, fontWeight: '800' }}>
            도구 실행 기록 <Text style={{ color: p.muted, fontSize: 13 }}>{events.length}건</Text>
          </Text>
          <Pressable
            onPress={() => void copy(all, 'all')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="전체 복사"
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: p.panel2 }}
          >
            <Text style={{ color: copied === 'all' ? p.ok : p.text, fontSize: 12.5, fontWeight: '700' }}>
              {copied === 'all' ? '복사됨' : '전체 복사'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="닫기"
            style={{ width: TAP - 12, height: TAP - 12, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: p.muted, fontSize: 18, fontWeight: '700' }}>✕</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
          {events.length === 0 ? (
            <Text style={{ color: p.muted, textAlign: 'center', padding: 24 }}>
              이 답변에서는 도구를 쓰지 않았습니다.
            </Text>
          ) : (
            events.map((e, i) => {
              const { label, tone } = toolPhase(e);
              const isOpen = open.has(i);
              const input = toolValueText(e.toolInput);
              const result = toolValueText(e.result);
              const color = tone === 'err' ? p.danger : tone === 'ok' ? p.ok : p.muted;
              return (
                <View
                  key={`${e.toolUseId ?? e.runId ?? e.toolName ?? 'tool'}-${i}`}
                  style={{
                    borderWidth: 1,
                    borderColor: tone === 'err' ? alpha(p.danger, 40) : p.border,
                    borderRadius: 12,
                    backgroundColor: p.panel2,
                    overflow: 'hidden',
                  }}
                >
                  <Pressable
                    onPress={() => toggle(i)}
                    accessibilityRole="button"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, minHeight: TAP }}
                  >
                    <Text style={{ color: p.muted, fontSize: 11, width: 18 }}>{i + 1}</Text>
                    <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 13.5, fontWeight: '700' }}>
                      {shortToolName(e.toolName)}
                    </Text>
                    <Text style={{ color, fontSize: 11.5, fontWeight: '700' }}>{label}</Text>
                    {typeof e.durationMs === 'number' ? (
                      <Text style={{ color: p.muted, fontSize: 11 }}>{e.durationMs}ms</Text>
                    ) : null}
                    <Text style={{ color: p.muted, fontSize: 14 }}>{isOpen ? '−' : '+'}</Text>
                  </Pressable>
                  {isOpen && (
                    <View style={{ padding: 12, paddingTop: 0, gap: 8 }}>
                      {e.toolName && shortToolName(e.toolName) !== e.toolName ? (
                        <Text style={{ color: p.muted, fontSize: 11, fontFamily: MONO }}>{e.toolName}</Text>
                      ) : null}
                      {input ? <LogBlock label="입력" value={input} /> : null}
                      {e.error ? <LogBlock label="오류" value={String(e.error)} danger /> : null}
                      {result ? <LogBlock label="결과" value={result} /> : null}
                      <Pressable
                        onPress={() => void copy(formatToolLog([e]), `i${i}`)}
                        hitSlop={8}
                        accessibilityRole="button"
                        style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: p.panel }}
                      >
                        <Text style={{ color: copied === `i${i}` ? p.ok : p.primary, fontSize: 12, fontWeight: '700' }}>
                          {copied === `i${i}` ? '복사됨' : '이 항목 복사'}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

/** 인자·결과 한 덩이 — 길면 세로로 접고, 넓으면 가로로 민다. */
const LogBlock: React.FC<{ label: string; value: string; danger?: boolean }> = ({
  label,
  value,
  danger,
}) => {
  const p = useP();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: danger ? p.danger : p.muted, fontSize: 11, fontWeight: '700' }}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ maxHeight: 220, backgroundColor: p.code, borderRadius: 8 }}
      >
        <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }} contentContainerStyle={{ padding: 10 }}>
          <Text selectable style={{ color: danger ? p.danger : p.text, fontFamily: MONO, fontSize: 11.5, lineHeight: 17 }}>
            {value}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
};
