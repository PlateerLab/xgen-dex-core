/**
 * 답변 본문 렌더 — 데스크톱 채팅과 같은 것을 작은 화면에서 읽을 수 있게.
 *
 * 기본 마크다운 렌더러가 그리지 못하던 두 가지를 여기서 대신한다:
 *
 *   · **코드 블록** — 폰에서 코드는 거의 항상 화면보다 넓다. 줄바꿈으로 접으면
 *     들여쓰기가 무너져 읽을 수 없으므로 가로로 스크롤하고, 언어와 [복사] 를
 *     머리에 붙인다(폰에서 긴 코드를 손으로 긁어 복사하는 것은 사실상 불가능).
 *   · **표** — 같은 이유로 통째로 가로 스크롤한다. 접힌 표는 표가 아니다.
 *
 * 스트리밍 중에는 아직 닫히지 않은 ``` 도 코드 블록으로 그린다 — 닫힘을
 * 기다리는 동안 원문 기호가 그대로 보이면 답변이 깨진 것처럼 읽힌다.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import MarkdownDisplay from 'react-native-markdown-display';
import { MONO, useP, type Palette } from '../theme';

const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const p = useP();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await Clipboard.setStringAsync(code);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: p.border,
        borderRadius: 10,
        overflow: 'hidden',
        marginBottom: 10,
        backgroundColor: p.code,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: p.border,
        }}
      >
        <Text style={{ color: p.muted, fontSize: 11, fontWeight: '700' }}>
          {language || 'text'}
        </Text>
        <Pressable
          onPress={() => void copy()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="코드 복사"
        >
          <Text style={{ color: copied ? p.ok : p.primary, fontSize: 11.5, fontWeight: '700' }}>
            {copied ? '복사됨' : '복사'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 10 }}>
        <Text selectable style={{ color: p.text, fontFamily: MONO, fontSize: 12.5, lineHeight: 18 }}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
};

function markdownStyles(p: Palette) {
  return {
    body: { color: p.text, fontSize: 15.5, lineHeight: 23 },
    paragraph: { marginTop: 0, marginBottom: 10 },
    heading1: { fontSize: 20, fontWeight: '800' as const, marginBottom: 8, marginTop: 4, color: p.text },
    heading2: { fontSize: 18, fontWeight: '800' as const, marginBottom: 6, marginTop: 4, color: p.text },
    heading3: { fontSize: 16.5, fontWeight: '700' as const, marginBottom: 6, color: p.text },
    heading4: { fontSize: 15.5, fontWeight: '700' as const, color: p.text },
    strong: { fontWeight: '700' as const },
    link: { color: p.primary, textDecorationLine: 'underline' as const },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    list_item: { flexDirection: 'row' as const, marginBottom: 4 },
    blockquote: {
      backgroundColor: p.panel2,
      borderLeftWidth: 3,
      borderLeftColor: p.primary,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginBottom: 10,
      borderRadius: 4,
    },
    code_inline: {
      backgroundColor: p.panel2,
      color: p.text,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontSize: 13,
      fontFamily: MONO,
    },
    table: { borderWidth: 1, borderColor: p.border, borderRadius: 6, marginBottom: 10, minWidth: 420 },
    th: { padding: 8, fontWeight: '700' as const },
    td: { padding: 8, borderTopWidth: 1, borderColor: p.border },
    hr: { backgroundColor: p.border, height: 1, marginVertical: 12 },
  };
}

/** 코드 블록의 내용 — 렌더러 버전에 따라 담기는 자리가 달라 둘 다 본다. */
function fenceText(node: { content?: string; children?: unknown }): string {
  if (typeof node.content === 'string') return node.content.replace(/\n$/, '');
  return '';
}

export const AssistantMarkdown: React.FC<{ text: string }> = React.memo(({ text }) => {
  const p = useP();
  const styles = useMemo(() => markdownStyles(p), [p]);
  const rules = useMemo(
    () => ({
      fence: (node: { key: string; content?: string; sourceInfo?: string }) => (
        <CodeBlock key={node.key} code={fenceText(node)} language={node.sourceInfo} />
      ),
      code_block: (node: { key: string; content?: string; sourceInfo?: string }) => (
        <CodeBlock key={node.key} code={fenceText(node)} language={node.sourceInfo} />
      ),
      // 표는 통째로 가로 스크롤한다. 렌더러가 View 용 표 스타일을 따로 담아
      // 두므로(_VIEW_SAFE_*) 그 키를 그대로 쓴다 — style.table 은 비어 있다.
      table: (
        node: { key: string },
        children: React.ReactNode[],
        _parent: unknown,
        style: Record<string, object>,
      ) => (
        <ScrollView
          key={node.key}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 10 }}
        >
          <View style={style._VIEW_SAFE_table ?? style.table}>{children}</View>
        </ScrollView>
      ),
    }),
    [],
  );
  return (
    <MarkdownDisplay
      style={styles}
      rules={rules}
      onLinkPress={(url) => {
        void Linking.openURL(url).catch(() => undefined);
        return false; // 기본 핸들러 중복 방지
      }}
    >
      {text}
    </MarkdownDisplay>
  );
});
AssistantMarkdown.displayName = 'AssistantMarkdown';
