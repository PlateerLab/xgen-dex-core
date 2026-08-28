import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ProfileSummary } from '../engine';
import { Footer, FormField, Header, Loading, Notice } from './components';

export function ProfileScreen(props: {
  profiles: ProfileSummary[];
  busy: boolean;
  error?: string;
  onSelect: (name: string) => void;
  onCreate: (name: string, serverUrl: string) => void;
  onCancel: () => void;
}): React.ReactNode {
  const [cursor, setCursor] = useState(Math.max(0, props.profiles.findIndex((profile) => profile.current)));
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState<'name' | 'url'>('name');
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => setCursor((current) => Math.min(current, Math.max(0, props.profiles.length - 1))), [props.profiles]);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (creating) setCreating(false);
        else props.onCancel();
        return;
      }
      if (creating) {
        if (key.tab) setFocus((current) => (current === 'name' ? 'url' : 'name'));
        return;
      }
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      if (key.downArrow && props.profiles.length > 0) {
        setCursor((current) => Math.min(props.profiles.length - 1, current + 1));
      }
      if (key.return && props.profiles[cursor]) props.onSelect(props.profiles[cursor].name);
      if (input === 'n') {
        setCreating(true);
        setFocus('name');
      }
    },
    { isActive: !props.busy },
  );

  const create = (): void => {
    if (focus === 'name') {
      setFocus('url');
      return;
    }
    if (name.trim() && serverUrl.trim()) props.onCreate(name.trim(), serverUrl.trim());
  };

  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold>{creating ? '새 프로필' : '프로필 전환'}</Text>
        {creating ? (
          <Box flexDirection="column" marginTop={1}>
            <FormField
              label="Name"
              value={name}
              onChange={setName}
              onSubmit={() => setFocus('url')}
              focus={!props.busy && focus === 'name'}
              cursorOrigin={{ x: 16, y: 5 }}
              placeholder="corp"
            />
            <FormField
              label="Server URL"
              value={serverUrl}
              onChange={setServerUrl}
              onSubmit={create}
              focus={!props.busy && focus === 'url'}
              cursorOrigin={{ x: 16, y: 6 }}
              placeholder="https://xgen.example.com"
            />
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {props.profiles.map((profile, index) => (
              <Text key={profile.name} color={index === cursor ? 'cyan' : undefined}>
                {index === cursor ? '›' : ' '} {profile.current ? '●' : '○'} {profile.name} ·{' '}
                <Text dimColor>{profile.serverUrl}</Text>
              </Text>
            ))}
            {props.profiles.length === 0 ? <Text dimColor>저장된 프로필이 없습니다.</Text> : null}
          </Box>
        )}
        {props.busy ? <Loading label="프로필을 전환하는 중..." /> : null}
        {props.error ? <Notice error>{props.error}</Notice> : null}
      </Box>
      <Footer
        text={creating ? 'Tab 이동 · Enter 저장 · Esc 뒤로' : '↑↓ 이동 · Enter 선택 · N 새 프로필 · Esc 닫기'}
      />
    </Box>
  );
}
