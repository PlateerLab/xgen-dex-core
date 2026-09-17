/**
 * [Trigger] 행 — Job/sub-agent 결과가 세션을 깨운 턴.
 *
 * 서버는 이 턴을 사용자 발화와 같은 길로 주입하지만 사용자가 친 채팅이 아니다.
 * 그래서 말풍선이 아니라 한 줄로 그리고, 누르면 원문을 편다. 전 앱(CLI/VSCode/
 * 데스크톱/웹) 공통 계약이다 — 라벨은 정본(@dex/protocol)이 만든다.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { AgentTrigger } from '@dex/protocol';
import { triggerRowLabel } from '@dex/protocol';
import { MONO, useP } from '../theme';

export const TriggerRow: React.FC<{ trigger: AgentTrigger }> = ({ trigger }) => {
  const p = useP();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignSelf: 'center', maxWidth: '92%' }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="트리거 원문 보기"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: p.border,
          borderRadius: 999,
          paddingHorizontal: 12,
          paddingVertical: 5,
          backgroundColor: p.panel,
        }}
      >
        <Text numberOfLines={1} style={{ color: p.muted, fontSize: 11.5, flexShrink: 1 }}>
          {triggerRowLabel(trigger)}
        </Text>
        <Text style={{ color: p.muted, fontSize: 12 }}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open && (
        <View
          style={{
            marginTop: 6,
            borderWidth: 1,
            borderColor: p.border,
            borderRadius: 10,
            backgroundColor: p.code,
            padding: 10,
            maxHeight: 280,
          }}
        >
          <ScrollView nestedScrollEnabled>
            <Text selectable style={{ color: p.muted, fontSize: 11.5, fontFamily: MONO, lineHeight: 17 }}>
              {trigger.body || '(내용 없음)'}
            </Text>
          </ScrollView>
        </View>
      )}
    </View>
  );
};
