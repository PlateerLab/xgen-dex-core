import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ImeTextInput } from './ime-text-input';

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

export function Footer({ text, mode }: { text: string; mode?: string }): ReactNode {
  return (
    <Box paddingX={1}>
      {/* 지금 한글인지 영문인지는 상태바에서도 보여야 한다 — 입력창에서 눈을 떼고
          있다가 모르고 치면 `dkssud` 이 나온다. */}
      {mode ? (
        <Text bold color={mode === '한' ? 'yellow' : 'gray'}>
          [{mode}]{' '}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
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
  placeholder?: string;
  secret?: boolean;
}): ReactNode {
  return (
    // 가로로 늘려 둬야 입력 칸이 남는 폭을 알 수 있다. 내용만큼만 넓으면 칸의 폭이
    // 곧 글자 폭이 되어, 긴 주소가 스스로를 잘라 내는 꼴이 된다.
    <Box flexGrow={1}>
      <Box width={14} flexShrink={0}>
        <Text color={props.focus ? 'cyan' : undefined}>{props.focus ? '›' : ' '} {props.label}</Text>
      </Box>
      <ImeTextInput
        value={props.value}
        onChange={props.onChange}
        onSubmit={props.onSubmit}
        focus={props.focus}
        placeholder={props.placeholder}
        mask={props.secret ? '•' : undefined}
      />
    </Box>
  );
}
