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

async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2000;
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
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write('hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
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
