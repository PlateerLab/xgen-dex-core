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

/**
 * 메시지 입력창. 대화창과 시작 화면이 같은 것을 쓴다.
 *
 * `locked` 는 아직 보낼 수 없다는 표시다(시작 화면에서 새 에이전트의 이름이 없거나 겹칠 때).
 * 글은 칠 수 있게 두고 보내기만 막는다. 무엇이 모자란지는 부르는 쪽이 알린다.
 */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focused: boolean;
  disabled: boolean;
  /** 막혀 있는 동안 입력 칸 자리에 보일 글. */
  disabledText?: string;
  locked?: boolean;
  nativeIme: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): ReactNode {
  return (
    <Box borderStyle="round" borderColor={props.focused && !props.locked ? 'cyan' : 'gray'} paddingX={1}>
      {/* 자체 조합기는 상태를 표시하고, macOS 에서는 시스템 입력기를 쓴다고 알린다. */}
      <Text
        color={props.nativeIme || props.hangulMode ? 'yellow' : undefined}
        dimColor={!props.nativeIme && !props.hangulMode}
      >
        {props.nativeIme ? '한/영' : props.hangulMode ? '한' : 'EN'}
      </Text>
      {props.locked ? <Text dimColor> 잠김</Text> : null}
      <Text color={props.locked ? 'gray' : 'cyan'}> › </Text>
      {props.disabled ? (
        <Text dimColor>{props.disabledText ?? '응답을 기다리는 중...'}</Text>
      ) : (
        <ImeTextInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          focus={props.focused}
          placeholder="메시지를 입력하세요"
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      )}
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
