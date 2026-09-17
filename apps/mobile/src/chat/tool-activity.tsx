/**
 * 도구 과정 — 답변이 도는 동안 **한 번에 하나**만, 다음 것으로 스르륵 교체된다.
 *
 * 예전 모바일은 도구가 쓰일 때마다 "도구 실행: X" 줄을 대화에 쌓았다. 스무 번
 * 쓰는 답변이면 대화가 그 줄로 덮여, 정작 답을 읽을 수 없었다. 데스크톱·웹과
 * 같은 규칙으로 바꾼다: 흐름에는 지금 쓰는 것 하나, 나머지는 [전체 로그] 에.
 *
 * 교체 규칙(칩을 세는 법·건너뛰기)은 정본이 정한다(@dex/protocol tool-activity).
 * 여기에는 화면과 타이머만 있다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { collapseToolSteps, nextToolIndex, shortToolName, toolPhase, type ToolEvent } from '@dex/protocol';
import { alpha, useP } from '../theme';

const STEP_MS = 320; // 한 도구가 최소로 머무는 시간
const FADE_MS = 220; // 교체 크로스페이드 길이

const PHASE_MARK: Record<string, string> = { run: '⋯', ok: '✓', err: '!' };

const Chip: React.FC<{ ev: ToolEvent; step?: string; leaving?: boolean; onPress?: () => void }> = ({
  ev,
  step,
  leaving,
  onPress,
}) => {
  const p = useP();
  const anim = useRef(new Animated.Value(leaving ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: leaving ? 0 : 1,
      duration: FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [anim, leaving]);
  const { label, tone } = toolPhase(ev);
  const color = tone === 'err' ? p.danger : tone === 'ok' ? p.ok : p.muted;
  return (
    <Animated.View
      pointerEvents={leaving ? 'none' : 'auto'}
      style={{
        position: 'absolute',
        left: 0,
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [leaving ? -6 : 6, 0] }) },
        ],
      }}
    >
      <Pressable
        onPress={onPress}
        disabled={leaving}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`도구 ${shortToolName(ev.toolName)} ${label} — 눌러서 기록 보기`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderWidth: 1,
          borderColor: tone === 'err' ? alpha(p.danger, 40) : p.border,
          backgroundColor: tone === 'err' ? alpha(p.danger, 12) : p.panel2,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
          maxWidth: 260,
        }}
      >
        <Text style={{ color, fontSize: 11, fontWeight: '800' }}>{PHASE_MARK[tone] ?? '⋯'}</Text>
        <Text numberOfLines={1} style={{ color: p.text, fontSize: 12, flexShrink: 1 }}>
          {shortToolName(ev.toolName)}
        </Text>
        {step ? <Text style={{ color: p.muted, fontSize: 10.5 }}>{step}</Text> : null}
      </Pressable>
    </Animated.View>
  );
};

export const ToolActivity: React.FC<{
  events: readonly ToolEvent[];
  streaming: boolean;
  onOpen?: (ev: ToolEvent) => void;
}> = ({ events, streaming, onOpen }) => {
  const steps = useMemo(() => collapseToolSteps(events), [events]);
  const [idx, setIdx] = useState(0);
  const [cur, setCur] = useState<{ key: number; ev: ToolEvent } | null>(null);
  const [out, setOut] = useState<{ key: number; ev: ToolEvent } | null>(null);

  // 밀린 단계 전진 — 많이 밀렸으면 최신으로 점프한다(여러 도구를 빠르게 쓰면 슥 지나감).
  useEffect(() => {
    if (!steps.length) return;
    if (idx > steps.length - 1) {
      setIdx(steps.length - 1);
      return;
    }
    if (idx === steps.length - 1) return;
    const t = setTimeout(() => setIdx((i) => nextToolIndex(i, steps.length)), STEP_MS);
    return () => clearTimeout(t);
  }, [steps.length, idx]);

  // 같은 단계의 상태 변화(⋯→✓)는 제자리, 단계가 바뀌면 크로스페이드.
  useEffect(() => {
    if (!streaming) return;
    const target = steps[Math.min(idx, steps.length - 1)];
    if (!target) return;
    setCur((prev) => {
      if (prev && prev.key === idx) return prev.ev === target ? prev : { key: idx, ev: target };
      if (prev) setOut(prev);
      return { key: idx, ev: target };
    });
  }, [idx, steps, streaming]);

  useEffect(() => {
    if (!out) return;
    const t = setTimeout(() => setOut(null), FADE_MS);
    return () => clearTimeout(t);
  }, [out]);

  // 턴이 끝나면 사라진다 — 완료된 답변 위에 낡은 칩을 남기지 않는다.
  useEffect(() => {
    if (streaming || !cur) return;
    setOut(cur);
    setCur(null);
  }, [streaming, cur]);

  if (!cur && !out) return null;
  return (
    <View style={{ height: 28, justifyContent: 'center', marginBottom: 4 }}>
      {out && <Chip key={`${out.key}-out`} ev={out.ev} leaving />}
      {cur && (
        <Chip
          key={`${cur.key}-in`}
          ev={cur.ev}
          step={steps.length > 1 ? `${Math.min(cur.key + 1, steps.length)}/${steps.length}` : undefined}
          onPress={() => onOpen?.(cur.ev)}
        />
      )}
    </View>
  );
};
