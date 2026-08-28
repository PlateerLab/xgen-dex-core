import { useState } from 'react';
import { Box, Text } from 'ink';
import { Footer, FormField, Header, Loading, Notice } from './components';

export function SetupScreen(props: {
  busy: boolean;
  error?: string;
  onSubmit: (serverUrl: string) => void;
}): React.ReactNode {
  const [serverUrl, setServerUrl] = useState('');
  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
        <Text bold>처음 오셨군요</Text>
        <Text dimColor>연결할 XGEN Gateway 주소를 입력하세요.</Text>
        <Box marginTop={1}>
          <FormField
            label="Server URL"
            value={serverUrl}
            onChange={setServerUrl}
            onSubmit={(value) => value.trim() && props.onSubmit(value.trim())}
            focus={!props.busy}
            cursorOrigin={{ x: 16, y: 6 }}
            placeholder="https://xgen.example.com"
          />
        </Box>
        {props.busy ? <Loading label="서버 프로필을 저장하는 중..." /> : null}
        {props.error ? <Notice error>{props.error}</Notice> : null}
      </Box>
      <Footer text="Enter 계속 · Ctrl+Q 종료" />
    </Box>
  );
}
