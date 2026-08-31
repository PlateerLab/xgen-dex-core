import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Footer, FormField, Header, Loading, Notice } from './components';

export function LoginScreen(props: {
  profile: string;
  serverUrl: string;
  busy: boolean;
  error?: string;
  onSubmit: (email: string, password: string) => void;
  onProfiles: () => void;
  /** 주소를 잘못 친 것을 여기서 바로 고친다 — 프로필을 새로 만들지 않고. */
  onEditServer: () => void;
}): React.ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [focus, setFocus] = useState<'email' | 'password'>('email');

  useInput(
    (input, key) => {
      if (key.tab) setFocus((current) => (current === 'email' ? 'password' : 'email'));
      if (key.ctrl && input === 'p') props.onProfiles();
      if (key.ctrl && input === 'e') props.onEditServer();
    },
    { isActive: !props.busy },
  );

  const submit = (): void => {
    if (focus === 'email') {
      setFocus('password');
      return;
    }
    if (email.trim() && password) {
      const secret = password;
      setPassword('');
      props.onSubmit(email.trim(), secret);
    }
  };

  return (
    <Box flexDirection="column">
      <Header profile={props.profile} connected={false} />
      <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
        <Text bold>로그인</Text>
        {/* 주소를 크게 보여 준다 — 로그인이 안 될 때 가장 먼저 의심할 값이다. */}
        <Text dimColor>
          {props.serverUrl} <Text color="cyan">(Ctrl+E 바꾸기)</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <FormField
            label="Email"
            value={email}
            onChange={setEmail}
            onSubmit={() => setFocus('password')}
            focus={!props.busy && focus === 'email'}
            placeholder="me@corp.com"
          />
          <FormField
            label="Password"
            value={password}
            onChange={setPassword}
            onSubmit={submit}
            focus={!props.busy && focus === 'password'}
            secret
          />
        </Box>
        {props.busy ? <Loading label="로그인하는 중..." /> : null}
        {props.error ? <Notice error>{props.error}</Notice> : null}
      </Box>
      <Footer text="Tab 이동 · Enter 로그인 · Ctrl+E 서버 · Ctrl+P 프로필 · Ctrl+Q 종료" />
    </Box>
  );
}
