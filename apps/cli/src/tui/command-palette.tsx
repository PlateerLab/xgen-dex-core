import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Footer } from './components';

export interface PaletteAction {
  id: string;
  label: string;
  run: () => void;
}

export function CommandPalette(props: {
  actions: PaletteAction[];
  onCancel: () => void;
}): React.ReactNode {
  const [cursor, setCursor] = useState(0);
  useInput((_input, key) => {
    if (key.escape) props.onCancel();
    if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    if (key.downArrow) setCursor((current) => Math.min(props.actions.length - 1, current + 1));
    if (key.return && props.actions[cursor]) props.actions[cursor].run();
  });
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="double" borderColor="magenta" padding={1}>
      <Text bold>명령</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.actions.map((action, index) => (
          <Text key={action.id} color={index === cursor ? 'magentaBright' : undefined}>
            {index === cursor ? '›' : ' '} {action.label}
          </Text>
        ))}
      </Box>
      <Footer text="↑↓ 이동 · Enter 실행 · Esc 닫기" />
    </Box>
  );
}
