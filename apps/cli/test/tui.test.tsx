import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import type { ProfileSummary } from '@dex/engine';
import type { ChatInput, ResolvedChatInput } from '@dex/engine';
import { App } from '../src/tui/app';
import { ImeTextInput } from '../src/tui/ime-text-input';
import type { TuiEngine } from '../src/tui/model';

function fakeEngine(profileList: ProfileSummary[] = [
  { name: 'corp', serverUrl: 'https://xgen.example.com', current: true },
]): TuiEngine {
  return {
    async listProfiles() {
      return profileList;
    },
    async setProfile(name, serverUrl) {
      return { name, serverUrl, current: true };
    },
    async useProfile(name) {
      const profile = profileList.find((item) => item.name === name);
      if (!profile) throw new Error('missing profile');
      return { ...profile, current: true };
    },
    async login(_email, _password, profile) {
      return {
        profile: profile ?? 'corp',
        serverUrl: 'https://xgen.example.com',
        authenticated: true,
        user: { userId: '1', username: 'alice', isSuperuser: false, roles: [], permissions: [] },
      };
    },
    async authStatus(profile) {
      return {
        profile: profile ?? 'corp',
        serverUrl: 'https://xgen.example.com',
        authenticated: true,
        user: { userId: '1', username: 'alice', isSuperuser: false, roles: [], permissions: [] },
      };
    },
    async logout() {},
    async listAgents() {
      return {
        items: [
          {
            id: 1,
            workflowId: 'wf_abc',
            workflowName: 'Sales Agent',
            nodeCount: 1,
            isShared: false,
            isDeployed: true,
            isCompleted: true,
            workflowType: 'canvas',
            description: '',
            username: 'alice',
            fullName: 'Alice',
            createdAt: '',
            updatedAt: '',
          },
        ],
        pagination: { page: 1, pageSize: 100, totalCount: 1, totalPages: 1 },
      };
    },
    async listConversations() {
      return [];
    },
    async historyTurns() {
      return [];
    },
    async resolveChatInput(input: ChatInput): Promise<ResolvedChatInput> {
      return {
        profile: input.profile ?? 'corp',
        workflowId: input.workflowId,
        workflowName: input.workflowName ?? 'Sales Agent',
        interactionId: input.interactionId ?? 'interaction-1',
        input: input.input,
      };
    },
    async *chat(input: ChatInput): AsyncGenerator<
      { kind: 'text'; content: string } | { kind: 'end' },
      ResolvedChatInput
    > {
      yield { kind: 'text', content: `You said: ${String(input.input)}` };
      yield { kind: 'end' };
      return this.resolveChatInput(input);
    },
  };
}

/** TUI 렌더가 한 바퀴 돌 여유. */
const SETTLE_MS = 250;

/**
 * 화면이 **더 이상 변하지 않을 때까지** 기다린다.
 *
 * 어떤 문구가 나타나는 것과 앱이 그 입력을 받을 준비가 된 것은 다르다. 목록에
 * 'Sales Agent' 가 그려진 뒤에도 대시보드로 그 목록이 내려가는 상태 갱신이 아직
 * 남아 있을 수 있고, 그 사이에 Enter 를 누르면 selectAgent() 가 빈 목록을 보고
 * 조용히 되돌아간다 — 아무 일도 일어나지 않고 테스트는 타임아웃까지 기다린다.
 *
 * 이건 추측이 아니라 관찰이다: 이 자리에 console.error 한 줄(=이벤트 루프 양보)을
 * 넣었더니 6/6 통과했다. 그래서 '문구가 보인다'가 아니라 '화면이 잠잠하다'를
 * 기다린다.
 */
async function waitForSettled(lastFrame: () => string | undefined): Promise<void> {
  const deadline = Date.now() + 15_000;
  let previous = lastFrame();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const current = lastFrame();
    if (current === previous) return;
    previous = current;
  }
}

/**
 * 화면이 조건을 만족할 때까지 기다린다.
 *
 * 마감은 **안전망이지 타이밍 단언이 아니다** — 2초는 느린 러너에서 진짜 실패와
 * 단순히 느린 것을 구분하지 못한다. 넉넉히 두면 통과할 것은 통과하고, 깨진 것은
 * 여전히 깨진다.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = lastFrame() ?? '';
    if (predicate(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for frame:\n${lastFrame() ?? ''}`);
}

function ImeInputHarness(props: { onSubmit: (value: string) => void }): React.ReactNode {
  const [value, setValue] = useState('');
  return (
    <ImeTextInput
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      focus
      cursorOrigin={{ x: 0, y: 0 }}
      placeholder="입력"
    />
  );
}

test('TUI shows onboarding when no profile exists', async () => {
  const view = render(<App engine={fakeEngine([])} />);
  try {
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('처음 오셨군요'));
    assert.match(frame, /Server URL/);
  } finally {
    view.cleanup();
  }
});

test('TUI boots an authenticated profile and streams a chat turn', async () => {
  const view = render(<App engine={fakeEngine()} />);
  try {
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes('Sales Agent'));
    assert.match(frame, /Connected/);
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    view.stdin.write('hello');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    view.stdin.write('\r');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('You said: hello'));
    assert.match(frame, /You said: hello/);
  } finally {
    view.cleanup();
  }
});

test('IME input keeps consecutive Hangul commits and submits the current value', async () => {
  let submitted = '';
  const view = render(<ImeInputHarness onSubmit={(value) => { submitted = value; }} />);
  try {
    view.stdin.write('ㅎ');
    view.stdin.write('ㅇ');
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('ㅎㅇ'));
    assert.match(frame, /ㅎㅇ/);

    view.stdin.write('\r');
    assert.equal(submitted, 'ㅎㅇ');
  } finally {
    view.cleanup();
  }
});

test('IME input edits by grapheme instead of UTF-16 code unit', async () => {
  const view = render(<ImeInputHarness onSubmit={() => undefined} />);
  try {
    view.stdin.write('한글');
    await waitForFrame(view.lastFrame, (value) => value.includes('한글'));
    view.stdin.write('\u001B[D');
    view.stdin.write('국');
    await waitForFrame(view.lastFrame, (value) => value.includes('한국글'));
    view.stdin.write('\u007F');
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('한글'));
    assert.doesNotMatch(frame, /국/);
  } finally {
    view.cleanup();
  }
});
