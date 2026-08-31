import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ImeTextInput, type CursorOrigin } from './ime-text-input';

export function Header(props: {
  profile?: string;
  username?: string;
  connected?: boolean;
}): ReactNode {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text bold color="blueBright">
        XGEN Dex
      </Text>
      {props.profile ? (
        <Text>
          {props.profile} · {props.username ?? '로그인 필요'} ·{' '}
          <Text color={props.connected ? 'green' : 'yellow'}>
            {props.connected ? 'Connected' : 'Offline'}
          </Text>
        </Text>
      ) : (
        <Text dimColor>설정 필요</Text>
      )}
    </Box>
  );
}

export function Footer({ text }: { text: string }): ReactNode {
  return (
    <Box paddingX={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

export function Loading({ label = '불러오는 중...' }: { label?: string }): ReactNode {
  return (
    <Box padding={1}>
      <Text color="cyan">◆ {label}</Text>
    </Box>
  );
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }): ReactNode {
  return (
    <Box borderStyle="round" borderColor={error ? 'red' : 'cyan'} paddingX={1}>
      <Text color={error ? 'red' : undefined}>{children}</Text>
    </Box>
  );
}

export function FormField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus: boolean;
  cursorOrigin: CursorOrigin;
  placeholder?: string;
  secret?: boolean;
}): ReactNode {
  return (
    <Box>
      <Box width={14}>
        <Text color={props.focus ? 'cyan' : undefined}>{props.focus ? '›' : ' '} {props.label}</Text>
      </Box>
      <ImeTextInput
        value={props.value}
        onChange={props.onChange}
        onSubmit={props.onSubmit}
        focus={props.focus}
        cursorOrigin={props.cursorOrigin}
        placeholder={props.placeholder}
        mask={props.secret ? '•' : undefined}
      />
    </Box>
  );
}
