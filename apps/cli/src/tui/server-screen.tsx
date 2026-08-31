import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Footer, FormField, Header, Loading, Notice } from './components';

/**
 * 서버 주소를 정하는 화면. **처음 설정과 나중 수정이 같은 화면**이다.
 *
 * 예전에는 처음 설정 전용이었다. 그래서 주소를 잘못 치고 넘어가면 되돌아올 길이
 * 없었다 — 로그인 화면에서 할 수 있는 것은 Ctrl+P 로 프로필 목록에 가서 새 프로필을
 * 만드는 것뿐이었고, 오타 하나 고치자고 프로필이 하나 더 생겼다.
 *
 * 고칠 때는 지금 값이 채워진 채로 열린다 — 다시 치는 게 아니라 고치는 것이다.
 */
export function ServerScreen(props: {
  /** 고칠 때의 현재 값. 처음 설정이면 비어 있다. */
  initialValue?: string;
  profile?: string;
  busy: boolean;
  error?: string;
  onSubmit: (serverUrl: string) => void;
  /** 처음 설정에는 없다 — 돌아갈 곳이 없기 때문이다. */
  onCancel?: () => void;
}): React.ReactNode {
  const [serverUrl, setServerUrl] = useState(props.initialValue ?? '');
  const editing = props.initialValue !== undefined;

  useInput(
    (_input, key) => {
      if (key.escape) props.onCancel?.();
    },
    { isActive: !props.busy && !!props.onCancel },
  );

  return (
    <Box flexDirection="column">
      <Header profile={props.profile} connected={false} />
      <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
        <Text bold>{editing ? '서버 주소 바꾸기' : '처음 오셨군요'}</Text>
        <Text dimColor>연결할 XGEN Gateway 주소를 입력하세요.</Text>
        <Box marginTop={1}>
          <FormField
            label="Server URL"
            value={serverUrl}
            onChange={setServerUrl}
            onSubmit={(value) => value.trim() && props.onSubmit(value.trim())}
            focus={!props.busy}
            cursorOrigin={{ x: 16, y: 6 }}
            placeholder="xgen.example.com"
          />
        </Box>
        {/* http:// 를 안 써도 된다는 것을 여기서 말해 준다 — 예전에는 그걸 모르고
            치다가 "http:// 또는 https://로 시작해야 합니다" 를 보고서야 알았다. */}
        <Text dimColor>https:// 는 생략해도 됩니다.</Text>
        {props.busy ? <Loading label="서버 프로필을 저장하는 중..." /> : null}
        {props.error ? <Notice error>{props.error}</Notice> : null}
      </Box>
      <Footer
        text={
          props.onCancel
            ? 'Enter 저장 · Esc 취소 · Ctrl+Q 종료'
            : 'Enter 계속 · Ctrl+Q 종료'
        }
      />
    </Box>
  );
}
