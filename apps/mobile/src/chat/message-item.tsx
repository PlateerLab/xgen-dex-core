/**
 * 대화 한 줄.
 *
 * 데스크톱과 같은 것을 담되 자리는 폰에 맞춘다:
 *   · 사용자 = 오른쪽 말풍선, 답변 = 폭을 다 쓰는 글 (좁은 화면에서 말풍선에
 *     가둔 답변은 표·코드가 전부 접혀 읽을 수 없다)
 *   · 도구를 쓴 답변은 작업 과정 타임라인(데스크톱·웹과 같은 단계·도구·소요 시간)으로,
 *     아래에 [복사]·[전체 로그 · N건]·출처
 *   · 실패는 본문 대신 구조로 — 무슨 일인지 · 이제 뭘 하면 되는지 · 문의 코드
 *   · 길게 누르면 그 줄을 복사한다 (폰에는 마우스 우클릭이 없다)
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { parseAgentTrigger, INTERRUPTED_TEXT, type ToolEvent } from '@dex/protocol';
import { alpha, useP } from '../theme';
import { AssistantMarkdown } from './markdown';
import { ToolActivity } from './tool-activity';
import { TriggerRow } from './trigger-row';
import { ProcessTimeline, hasProcessFlow } from './process-timeline';
import type { ChatMessage } from './message-model';

/** 답변이 도는 동안 깜빡이는 자리 — 본문 문자열에 ▍를 섞으면 마크다운이 깨진다. */
const Caret: React.FC = () => {
  const p = useP();
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.15, duration: 520, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 520, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink]);
  return (
    <Animated.View
      style={{ opacity: blink, width: 8, height: 16, borderRadius: 2, backgroundColor: p.primary, marginTop: 2 }}
    />
  );
};

const ErrorBlock: React.FC<{ info: NonNullable<ChatMessage['errorInfo']> }> = ({ info }) => {
  const p = useP();
  const [open, setOpen] = useState(false);
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderWidth: 1,
        borderColor: alpha(p.danger, 45),
        backgroundColor: alpha(p.danger, 10),
        borderRadius: 12,
        padding: 12,
        gap: 6,
      }}
    >
      <Text style={{ color: p.danger, fontSize: 14, fontWeight: '800' }}>⚠️ {info.title}</Text>
      {info.hint ? <Text style={{ color: p.text, fontSize: 13, lineHeight: 19 }}>{info.hint}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: p.muted, fontSize: 11, fontWeight: '700' }}>{info.code}</Text>
        {info.detail ? (
          <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: p.primary, fontSize: 12, fontWeight: '700' }}>
              {open ? '자세히 접기' : '자세히'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {open && info.detail ? (
        <Text selectable style={{ color: p.muted, fontSize: 11.5, lineHeight: 17 }}>
          {info.detail}
        </Text>
      ) : null}
    </View>
  );
};

/**
 * 답변 아래 아이콘 단추 — 늘 보인다. 손가락에는 마우스 올리기가 없으므로 길게 누르면 이름이
 * 잠깐 뜬다(스크린 리더는 accessibilityLabel 을 읽는다).
 */
const IconAction: React.FC<{ icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; active?: boolean }> = ({
  icon,
  label,
  onPress,
  active,
}) => {
  const p = useP();
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const t = setTimeout(() => setTip(false), 1400);
    return () => clearTimeout(t);
  }, [tip]);
  return (
    <View>
      {tip ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: 30,
            left: -8,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: p.text,
          }}
        >
          <Text numberOfLines={1} style={{ color: p.bg, fontSize: 11.5, fontWeight: '600' }}>
            {label}
          </Text>
        </View>
      ) : null}
      <Pressable
        onPress={onPress}
        onLongPress={() => setTip(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ padding: 4 }}
      >
        <Ionicons name={icon} size={17} color={active ? p.primary : p.muted} />
      </Pressable>
    </View>
  );
};

const FooterButton: React.FC<{ label: string; onPress: () => void; tone?: 'muted' | 'primary' }> = ({
  label,
  onPress,
  tone = 'muted',
}) => {
  const p = useP();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={{ color: tone === 'primary' ? p.primary : p.muted, fontSize: 12, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
};

export const MessageItem: React.FC<{
  message: ChatMessage;
  /** 본문 표시용 정리(마커 제거)를 마친 글. */
  text: string;
  /** 글 조각 하나를 같은 규칙으로 정리한다 — 작업 과정의 단계 글에 쓴다. */
  clean: (text: string) => string;
  onOpenLog: (events: ToolEvent[], initialOpen?: number) => void;
}> = React.memo(({ message: m, text, clean, onOpenLog }) => {
  const p = useP();
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (m.role === 'user') {
    const trigger = parseAgentTrigger(text);
    if (trigger) return <TriggerRow trigger={trigger} />;
    return (
      <Pressable
        onLongPress={() => void copy()}
        delayLongPress={350}
        accessibilityLabel="보낸 메시지 — 길게 누르면 복사합니다"
        style={{
          alignSelf: 'flex-end',
          maxWidth: '88%',
          backgroundColor: p.primary,
          borderRadius: 18,
          borderBottomRightRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 8,
        }}
      >
        {m.attachments && m.attachments.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {m.attachments.map((file, i) => (
              <View
                key={`${file.name}-${i}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  backgroundColor: alpha('#FFFFFF', 18),
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  maxWidth: 200,
                }}
              >
                <Text style={{ fontSize: 11 }}>{file.kind === 'image' ? '🖼' : '📎'}</Text>
                <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 12, flexShrink: 1 }}>
                  {file.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {text ? <Text style={{ color: '#FFFFFF', fontSize: 15.5, lineHeight: 22 }}>{text}</Text> : null}
        {copied ? <Text style={{ color: alpha('#FFFFFF', 75), fontSize: 11 }}>복사됨</Text> : null}
      </Pressable>
    );
  }

  const tools = m.tools ?? [];
  const live = !!m.streaming || !!m.remotePartial;
  const showFooter = !live && (!!text || tools.length > 0);
  // 순서를 아는 답(내 스트림·다른 화면의 턴·서버가 되살린 지난 턴)은 타임라인으로 — 칩 한 칸은 순서를 모를 때만.
  const timeline = hasProcessFlow(m);
  const timelineView = timeline ? (
    <ProcessTimeline message={m} clean={clean} onOpenLog={onOpenLog} caret={<Caret />} />
  ) : null;
  return (
    <View style={{ alignSelf: 'stretch', gap: 2 }}>
      {!timeline && tools.length > 0 && (
        <ToolActivity
          events={tools}
          streaming={!!m.streaming || !!m.remotePartial}
          onOpen={(ev) => onOpenLog([...tools], tools.lastIndexOf(ev))}
        />
      )}
      <Pressable
        onLongPress={() => void copy()}
        delayLongPress={350}
        accessibilityLabel="답변 — 길게 누르면 복사합니다"
        style={{
          backgroundColor: p.assistantBubble,
          borderWidth: 1,
          borderColor: p.border,
          borderRadius: 16,
          borderTopLeftRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        {m.errorInfo ? (
          <View style={{ gap: 10 }}>
            {timelineView}
            <ErrorBlock info={m.errorInfo} />
          </View>
        ) : timeline ? (
          timelineView
        ) : text ? (
          <AssistantMarkdown text={text} />
        ) : (
          <Caret />
        )}
        {!!text && live && !timeline ? <Caret /> : null}
      </Pressable>

      {m.interrupted ? (
        <Text style={{ color: p.muted, fontSize: 11.5, marginTop: 2 }}>{INTERRUPTED_TEXT}</Text>
      ) : null}

      {m.citations && m.citations.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          <Text style={{ color: p.muted, fontSize: 11, fontWeight: '700' }}>출처</Text>
          {m.citations.map((c, i) => (
            <View
              key={`${c.fileName ?? 'doc'}-${i}`}
              style={{
                borderWidth: 1,
                borderColor: p.border,
                borderRadius: 999,
                paddingHorizontal: 8,
                paddingVertical: 2,
                backgroundColor: p.panel2,
              }}
            >
              <Text style={{ color: p.muted, fontSize: 11 }} numberOfLines={1}>
                {c.fileName ?? '문서'}
                {c.pageNumber ? ` p.${c.pageNumber}` : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {showFooter ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6, paddingLeft: 2 }}>
          {!!text && (
            <IconAction
              icon={copied ? 'checkmark' : 'copy-outline'}
              label={copied ? '복사됨' : '답변 복사'}
              active={copied}
              onPress={() => void copy()}
            />
          )}
          {tools.length > 0 && (
            <FooterButton
              tone="primary"
              label={`전체 로그 보기 · ${tools.length}건`}
              onPress={() => onOpenLog([...tools])}
            />
          )}
        </View>
      ) : null}
    </View>
  );
});
MessageItem.displayName = 'MessageItem';
