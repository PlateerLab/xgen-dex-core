import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  MODEL_PICKER_TEXT,
  THINKING_PICKER_TEXT,
  orderedChoices,
  sameModel,
  selectedThinking,
  thinkingValueLabel,
  type ConversationModelState,
  type ModelChoice,
  type ThinkingValue,
} from '@dex/protocol';
import { Footer } from './components';

/**
 * 모델 고르기 (Ctrl+O · /model) — 지금 모델이 맨 위, 제공자가 바뀌는 자리에 줄.
 *
 * 고르면 **이 대화만** 그 모델로 돈다. 다음 답변부터이고 세션은 다시 시작하지 않는다.
 * 이름은 서버가 정한 "제공자: 모델"(예 `Anthropic: Haiku 4.5`)을 그대로 쓴다 — 웹·앱·
 * VS Code 와 같은 글자다.
 */
export function ModelPicker(props: {
  state: ConversationModelState;
  height: number;
  onPick: (choice: ModelChoice) => void;
  onCancel: () => void;
}): React.ReactNode {
  const choices = useMemo(() => orderedChoices(props.state), [props.state]);
  const [cursor, setCursor] = useState(0);
  // 목록이 화면보다 길면 커서를 따라 창을 민다(제목·안내·테두리 몫을 뺀 줄 수).
  const rows = Math.max(3, props.height - 7);
  const start = Math.min(Math.max(0, cursor - Math.floor(rows / 2)), Math.max(0, choices.length - rows));
  const visible = choices.slice(start, start + rows);

  useInput((_input, key) => {
    if (key.escape) props.onCancel();
    else if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    else if (key.downArrow) setCursor((current) => Math.min(choices.length - 1, current + 1));
    else if (key.pageUp) setCursor((current) => Math.max(0, current - rows));
    else if (key.pageDown) setCursor((current) => Math.min(choices.length - 1, current + rows));
    else if (key.return && choices[cursor]) props.onPick(choices[cursor]);
  });

  const current = props.state.current;
  return (
    <Box flexDirection="column" flexGrow={1} height={props.height} borderStyle="double" borderColor="magenta" paddingX={1}>
      <Text bold>{MODEL_PICKER_TEXT.title}</Text>
      <Text dimColor>{MODEL_PICKER_TEXT.nextTurn}</Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {visible.map((choice, offset) => {
          const index = start + offset;
          const isCurrent = sameModel(choice, current);
          const prev = choices[index - 1];
          // 지금 모델 아래, 그리고 제공자 묶음이 바뀌는 자리에 줄을 긋는다.
          const sep = offset > 0 && !!prev && (sameModel(prev, current) || prev.group !== choice.group);
          return (
            <Box key={`${choice.provider}:${choice.model}`} flexDirection="column">
              {sep ? <Text dimColor>{'─'.repeat(24)}</Text> : null}
              <Text color={index === cursor ? 'magentaBright' : isCurrent ? 'green' : undefined} bold={isCurrent} wrap="truncate-end">
                {index === cursor ? '›' : ' '} {isCurrent ? '✓' : ' '} {choice.label}
                {isCurrent ? `  (${MODEL_PICKER_TEXT.current})` : ''}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Footer text="↑↓ 이동 · Enter 선택 · Esc 닫기" />
    </Box>
  );
}

/**
 * 생각(추론) 고르기 (/thinking) — 지금 모델이 받는 값만(서버가 준 선택지). 맨 위 "기본" 은 에이전트 설정을 따른다.
 */
export function ThinkingPicker(props: {
  state: ConversationModelState;
  height: number;
  onPick: (value: ThinkingValue) => void;
  onCancel: () => void;
}): React.ReactNode {
  const thinking = props.state.thinking;
  const options = thinking?.options ?? [];
  const pressed = thinking ? selectedThinking(thinking) : 'auto';
  const [cursor, setCursor] = useState(Math.max(0, options.indexOf(pressed)));

  useInput((_input, key) => {
    if (key.escape) props.onCancel();
    else if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    else if (key.downArrow) setCursor((current) => Math.min(options.length - 1, current + 1));
    else if (key.return && options[cursor]) props.onPick(options[cursor]);
  });

  return (
    <Box flexDirection="column" flexGrow={1} height={props.height} borderStyle="double" borderColor="magenta" paddingX={1}>
      <Text bold>{THINKING_PICKER_TEXT.title}</Text>
      <Text dimColor>
        {thinking && !thinking.canDisable ? `${THINKING_PICKER_TEXT.alwaysOn}. ` : ''}
        {THINKING_PICKER_TEXT.nextTurn}
      </Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {options.map((value, index) => {
          const isOn = value === pressed;
          return (
            <Text key={value} color={index === cursor ? 'magentaBright' : isOn ? 'green' : undefined} bold={isOn} wrap="truncate-end">
              {index === cursor ? '›' : ' '} {isOn ? '✓' : ' '} {thinkingValueLabel(value)}
              {value === 'auto' ? `  (${THINKING_PICKER_TEXT.autoHint})` : ''}
            </Text>
          );
        })}
      </Box>
      <Footer text="↑↓ 이동 · Enter 선택 · Esc 닫기" />
    </Box>
  );
}
