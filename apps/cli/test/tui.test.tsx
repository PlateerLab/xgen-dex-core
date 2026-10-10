import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import type { ProfileSummary } from '@dex/engine';
import type {
  ChatInput,
  ChatStopResult,
  Conversation,
  ConversationSnapshot,
  CreateAgentInput,
  HistoryTurn,
  ResolvedChatInput,
} from '@dex/engine';
import { searchConversationList } from '@dex/protocol';
import { App } from '../src/tui/app';
import { ImeTextInput } from '../src/tui/ime-text-input';
import type { TuiEngine } from '../src/tui/model';
import { DELETED_AGENT_NOTICE } from '../src/tui/conversation-list';
import { NAME_REQUIRED, NAME_TAKEN, START_HEADING } from '../src/tui/start-screen';

/** 가짜 서버가 받은 것. 화면이 엔진을 어떻게 불렀는지 본다. */
interface Calls {
  created: CreateAgentInput[];
  sent: ChatInput[];
  nameChecks: string[];
  renamed: Array<{ workflowId: string; interactionId: string; title: string }>;
  deleted: Array<{ workflowId: string; interactionId: string }>;
  purged: number;
}

function newCalls(): Calls {
  return { created: [], sent: [], nameChecks: [], renamed: [], deleted: [], purged: 0 };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 1,
    interactionId: 'int-1',
    workflowId: 'wf_abc',
    workflowName: 'Sales Agent',
    interactionCount: 4,
    metadata: {},
    createdAt: '2026-08-30T01:00:00.000Z',
    updatedAt: '2026-08-30T02:00:00.000Z',
    title: '분기 매출 정리',
    customTitle: false,
    tag: null,
    agentDeleted: false,
    agentOwnerId: 1,
    compare: [],
    ...over,
  };
}

function fakeEngine(
  profileList: ProfileSummary[] = [
    { name: 'corp', serverUrl: 'https://xgen.example.com', current: true },
  ],
  conversations: Conversation[] = [],
  calls: Calls = newCalls(),
): TuiEngine {
  // 서버의 대화 목록(마지막으로 말한 순서). 이름 바꾸기·지우기·첫 말이 여기를 고친다.
  let list = [...conversations];
  const agentNames = new Set(['Sales Agent']);
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
    async agentCreateOptions() {
      return {
        providers: [
          {
            value: 'openai',
            label: 'OpenAI',
            models: [
              { value: 'gpt-4o', label: 'GPT-4o' },
              { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
            ],
            defaultModel: 'gpt-4o-mini',
          },
          {
            value: 'anthropic',
            label: 'Anthropic',
            models: [{ value: 'claude-sonnet', label: 'Claude Sonnet' }],
            defaultModel: 'claude-sonnet',
          },
        ],
        defaultProvider: 'openai',
        settings: [
          {
            id: 'tool_exposure',
            label: '도구 노출 방식',
            type: 'STR',
            default: 'hierarchy',
            options: [
              { value: 'hierarchy', label: '계층형' },
              { value: 'flat', label: '평면형' },
            ],
          },
          { id: 'enable_self_evolution', label: '자기진화', type: 'BOOL', default: true },
        ],
        defaults: { tool_exposure: 'hierarchy', enable_self_evolution: true },
      };
    },
    async createAgent(input) {
      calls.created.push(input);
      agentNames.add(input.name);
      return { workflowId: 'wf_new', workflowName: input.name };
    },
    async agentNameTaken(name) {
      calls.nameChecks.push(name);
      return agentNames.has(name.trim());
    },
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
      return list;
    },
    async conversationPage(opts) {
      const offset = Number(opts.cursor ?? 0) || 0;
      const limit = opts.limit ?? 40;
      return {
        conversations: list.slice(offset, offset + limit),
        nextCursor: offset + limit < list.length ? String(offset + limit) : null,
        ...(offset === 0 ? { agentDeletedCount: list.filter((item) => item.agentDeleted).length } : {}),
      };
    },
    async searchConversations(query, opts) {
      // 서버 대신: 목록의 제목·에이전트 이름으로 찾는다(내용 검색은 서버 시험의 몫).
      return { ...searchConversationList(list, query, opts.limit ?? 30), contentSearched: true };
    },
    async renameConversation(workflowId, interactionId, title) {
      calls.renamed.push({ workflowId, interactionId, title });
      const found = list.find((item) => item.workflowId === workflowId && item.interactionId === interactionId);
      const next = title || '지난 질문';
      if (found) list = list.map((item) => (item === found ? { ...item, title: next, customTitle: !!title } : item));
      return { title: next, customTitle: !!title };
    },
    async deleteConversation(workflowId, interactionId) {
      calls.deleted.push({ workflowId, interactionId });
      list = list.filter((item) => !(item.workflowId === workflowId && item.interactionId === interactionId));
    },
    async purgeDeletedAgentConversations() {
      const before = list.length;
      list = list.filter((item) => !item.agentDeleted);
      calls.purged += before - list.length;
      return before - list.length;
    },
    async historyTurns(): Promise<HistoryTurn[]> {
      return [
        {
          logId: 1,
          ioId: 1,
          interactionId: 'int-1',
          workflowId: 'wf_abc',
          workflowName: 'Sales Agent',
          input: '지난 질문',
          output: '지난 답',
          attachments: [],
          updatedAt: '2026-08-30T02:00:00.000Z',
        },
      ];
    },
    async historySnapshot(): Promise<ConversationSnapshot> {
      // 이 가짜 서버에서는 도는 턴이 없다 — 이력만 그린다.
      return { turns: await this.historyTurns('wf_abc', 'int-1'), running: false };
    },
    async stopChat(): Promise<ChatStopResult> {
      return { stopped: true };
    },
    async resolveChatInput(input: ChatInput): Promise<ResolvedChatInput> {
      return {
        profile: input.profile ?? 'corp',
        workflowId: input.workflowId,
        workflowName: input.workflowName ?? 'Sales Agent',
        interactionId: input.interactionId ?? 'interaction-1',
        input: input.input,
        attachments: input.attachments ?? [],
        localFolders: input.localFolders ?? [],
      };
    },
    async uploadChatAttachment() {
      return {
        kind: 'file',
        attachment_id: 'att-1',
        name: 'sample.txt',
        mime_type: 'text/plain',
        size: 1,
        workspace_path: 'attachments/interaction-1/att-1/sample.txt',
      };
    },
    async *chat(input: ChatInput): AsyncGenerator<
      { kind: 'text'; content: string } | { kind: 'end' },
      ResolvedChatInput
    > {
      calls.sent.push(input);
      // 서버는 첫 말을 받으면 그 대화를 목록 맨 위에 적는다(제목 = 첫 말).
      const id = input.interactionId ?? 'interaction-1';
      if (!list.some((item) => item.interactionId === id)) {
        list = [
          conversation({
            id: 100 + list.length,
            interactionId: id,
            workflowId: input.workflowId,
            workflowName: input.workflowName ?? 'Agent',
            title: String(input.input),
            updatedAt: new Date().toISOString(),
          }),
          ...list,
        ];
      }
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
      placeholder="입력"
    />
  );
}

function NativeImeInputHarness(): React.ReactNode {
  const [value, setValue] = useState('');
  return (
    <ImeTextInput
      value={value}
      onChange={setValue}
      focus
      nativeIme
      // 저장 파일에 예전 자체 조합 상태가 남아 있어도 nativeIme가 우선해야 한다.
      hangulMode
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

const UP = '\u001B[A';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';
const TAB = '\t';

/** 시작 화면이 다 그려졌다(새 에이전트 칸을 불러와 이름 칸에 커서가 있다). */
async function startScreenReady(view: { lastFrame: () => string | undefined }): Promise<string> {
  const frame = await waitForFrame(view.lastFrame, (value) => value.includes(START_HEADING) && value.includes('› 이름'));
  await waitForSettled(view.lastFrame);
  return frame;
}

/** 시작 화면에서 있는 에이전트(Sales Agent)를 고르고 입력창으로 간다. */
async function chooseSalesAgent(view: {
  lastFrame: () => string | undefined;
  stdin: { write: (data: string) => void };
}): Promise<void> {
  await startScreenReady(view);
  view.stdin.write(UP); // 에이전트 칸
  await waitForSettled(view.lastFrame);
  view.stdin.write(RIGHT); // 새 에이전트로 시작 → Sales Agent
  await waitForFrame(view.lastFrame, (value) => value.includes('‹ Sales Agent ›'));
  await waitForSettled(view.lastFrame);
  view.stdin.write(DOWN); // 입력창
  await waitForSettled(view.lastFrame);
}

test('TUI boots an authenticated profile and streams a chat turn', async () => {
  const view = render(<App engine={fakeEngine()} />);
  try {
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes(START_HEADING));
    assert.match(frame, /Connected/);
    await chooseSalesAgent(view);
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

test('macOS native IME mode passes both Latin and composed Hangul through unchanged', async () => {
  const view = render(<NativeImeInputHarness />);
  try {
    view.stdin.write('dkssud');
    view.stdin.write('안녕');
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('dkssud안녕'));
    assert.match(frame, /dkssud안녕/);
  } finally {
    view.cleanup();
  }
});

test('macOS dashboard tells the user to switch with Caps Lock', async () => {
  const view = render(
    <App engine={fakeEngine()} preferences={{ nativeIme: true, hangulMode: true }} />,
  );
  try {
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('Caps Lock 한/영'));
    assert.doesNotMatch(frame, /Ctrl\+Space 한\/영/);
    assert.doesNotMatch(frame, /\[EN\]/);
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


// ── 대화 목록 (2026-10-09) ─────────────────────────────────────────
//
// 에이전트를 먼저 고르던 사이드바가 웹·데스크톱과 같은 대화 목록이 됐다. 한 줄은 작은
// 에이전트 이름(사라졌으면 [지워짐])과 꼬리표, 그리고 대화 제목이다.

const CONVERSATION = conversation();
const DEPLOYED = conversation({
  id: 2,
  interactionId: 'deploy_abc',
  title: '고객 문의 응대',
  tag: 'deploy',
  updatedAt: '2026-08-29T02:00:00.000Z',
});
const ORPHAN = conversation({
  id: 3,
  interactionId: 'int-3',
  workflowId: 'wf_gone',
  workflowName: 'Old Agent',
  title: '지난 회의 정리',
  agentDeleted: true,
  updatedAt: '2026-08-28T02:00:00.000Z',
});

const pause = (ms = SETTLE_MS): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('목록은 대화 제목·작은 에이전트 이름·꼬리표·[지워짐] 으로 보인다', async () => {
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION, DEPLOYED, ORPHAN])} />);
  try {
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('지난 회의 정리'));
    assert.match(frame, /＋ 새 채팅/);
    assert.match(frame, /분기 매출 정리/);
    assert.match(frame, /Sales Agent · 배포/);
    assert.match(frame, /고객 문의 응대/);
    assert.match(frame, /지워짐/);
    assert.doesNotMatch(frame, /Old Agent/, '사라진 에이전트의 이름 대신 [지워짐]');
    assert.match(frame, /에이전트가 사라진 채팅/);
    // 마지막으로 말한 순서(서버 순서) 그대로.
    assert.ok(frame.indexOf('분기 매출 정리') < frame.indexOf('고객 문의 응대'));
    assert.ok(frame.indexOf('고객 문의 응대') < frame.indexOf('지난 회의 정리'));
  } finally {
    view.cleanup();
  }
});

test('목록에서 대화를 고르면 그 내용과 제목이 대화창에 올라온다', async () => {
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION])} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('분기 매출 정리'));
    await startScreenReady(view);
    view.stdin.write(TAB); // 목록으로
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN); // ＋ 새 채팅 아래가 그 대화
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    // 질문과 답을 함께 기다린다. 느린 러너에서는 대화창 높이를 재기 전 한 장에 답 줄만 걸릴 수 있다.
    const frame = await waitForFrame(
      view.lastFrame,
      (value) => value.includes('지난 답') && value.includes('지난 질문'),
    );
    assert.doesNotMatch(frame, new RegExp(START_HEADING), '시작 화면은 닫힌다');
    // 제목 줄: 대화 제목과 작은 에이전트 이름.
    assert.match(frame, /분기 매출 정리 · Sales Agent/);
  } finally {
    view.cleanup();
  }
});

test('목록에서 / 를 누르면 채팅 검색이 뜨고, 고른 대화가 열린다', async () => {
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION, DEPLOYED, ORPHAN])} />);
  try {
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes('분기 매출 정리'));
    assert.match(frame, /⌕ \//, '[＋ 새 채팅] 줄 오른쪽에 검색이 보인다');
    await startScreenReady(view);
    view.stdin.write(TAB); // 목록으로
    await waitForSettled(view.lastFrame);
    view.stdin.write('/');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('채팅 검색') && value.includes('최근 채팅'));
    assert.match(frame, /분기 매출 정리/, '검색어가 비면 최근 채팅');
    // 검색칸의 키 처리기는 그린 뒤에 붙는다. 화면이 멈춘 뒤에 친다(다른 칸의 시험과 같다).
    await waitForSettled(view.lastFrame);
    view.stdin.write('고객');
    frame = await waitForFrame(
      view.lastFrame,
      (value) => value.includes('고객 문의 응대') && !value.includes('최근 채팅') && !value.includes('분기 매출 정리'),
    );
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('지난 답') && value.includes('지난 질문'));
    assert.match(frame, /고객 문의 응대/);
    assert.doesNotMatch(frame, /최근 채팅/, '검색 칸은 닫힌다');
  } finally {
    view.unmount();
    view.cleanup();
  }
});

test('채팅 검색은 Esc 로 닫고 목록으로 돌아간다', async () => {
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION])} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('분기 매출 정리'));
    await startScreenReady(view);
    view.stdin.write(TAB);
    await waitForSettled(view.lastFrame);
    view.stdin.write('/');
    await waitForFrame(view.lastFrame, (value) => value.includes('최근 채팅'));
    await waitForSettled(view.lastFrame);
    view.stdin.write('\u001B');
    const frame = await waitForFrame(view.lastFrame, (value) => !value.includes('최근 채팅') && value.includes('＋ 새 채팅'));
    assert.match(frame, /분기 매출 정리/);
  } finally {
    view.unmount();
    view.cleanup();
  }
});

test('에이전트가 지워진 대화는 지난 대화만 보이고 보낼 수 없다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [ORPHAN], calls)} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('지난 회의 정리'));
    await startScreenReady(view);
    view.stdin.write(TAB);
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN); // [에이전트가 사라진 채팅 제거]
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN); // 그 대화
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('지난 답'));
    assert.ok(frame.includes(DELETED_AGENT_NOTICE), '지워진 에이전트라고 알린다');
    assert.doesNotMatch(frame, /메시지를 입력하세요/, '입력창이 없다');
    view.stdin.write('hello');
    await pause();
    view.stdin.write('\r');
    await pause();
    assert.deepEqual(calls.sent, []);
  } finally {
    view.cleanup();
  }
});

test('시작 화면: 기본은 [새 에이전트로 시작] 이고 이름이 없으면 입력창이 잠겨 있다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [], calls)} />);
  try {
    let frame = await startScreenReady(view);
    assert.match(frame, /‹ 새 에이전트로 시작 ›/);
    assert.match(frame, /잠김/);
    view.stdin.write('\r'); // 이름 칸에서 Enter → 입력창
    await waitForSettled(view.lastFrame);
    view.stdin.write('hello');
    await waitForFrame(view.lastFrame, (value) => value.includes('hello'));
    view.stdin.write('\r');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes(NAME_REQUIRED));
    assert.deepEqual(calls.created, []);
    assert.deepEqual(calls.sent, []);
  } finally {
    view.cleanup();
  }
});

test('시작 화면: 이미 있는 이름이면 그렇다고 말하고 잠근 채 둔다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [], calls)} />);
  try {
    await startScreenReady(view);
    view.stdin.write('Sales Agent');
    await waitForFrame(view.lastFrame, (value) => value.includes(NAME_TAKEN));
    view.stdin.write('\r'); // → 입력창
    await waitForSettled(view.lastFrame);
    view.stdin.write('hello');
    await waitForFrame(view.lastFrame, (value) => value.includes('hello'));
    view.stdin.write('\r');
    await pause();
    const frame = view.lastFrame() ?? '';
    assert.ok(frame.includes(NAME_TAKEN));
    assert.match(frame, /잠김/);
    assert.deepEqual(calls.created, []);
    assert.deepEqual(calls.sent, []);
  } finally {
    view.cleanup();
  }
});

test('시작 화면: 새 이름으로 보내면 에이전트를 세우고 새 대화를 열어 첫 말을 보낸다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [], calls)} />);
  try {
    await startScreenReady(view);
    view.stdin.write('New Bot');
    // 적는 대로 묻고(잠깐 멈추면), 겹치지 않으면 잠금이 풀린다.
    await waitForFrame(view.lastFrame, (value) => value.includes('New Bot') && !value.includes('잠김'));
    view.stdin.write('\r'); // → 입력창
    await waitForSettled(view.lastFrame);
    view.stdin.write('hello');
    await waitForFrame(view.lastFrame, (value) => value.includes('hello'));
    view.stdin.write('\r');
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('You said: hello'));
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0]!.name, 'New Bot');
    assert.equal(calls.created[0]!.provider, 'openai');
    assert.equal(calls.created[0]!.model, 'gpt-4o-mini');
    assert.deepEqual(calls.created[0]!.settings, { tool_exposure: 'hierarchy', enable_self_evolution: true });
    // 만들기 직전에 한 번 더 물었다.
    assert.ok(calls.nameChecks.filter((name) => name === 'New Bot').length >= 2);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0]!.workflowId, 'wf_new');
    assert.equal(calls.sent[0]!.input, 'hello');
    // 새 대화는 목록 맨 위에 첫 말을 제목으로 선다. 제목 줄에는 새 에이전트 이름.
    assert.match(frame, /hello · New Bot/);
    assert.doesNotMatch(frame, new RegExp(START_HEADING));
  } finally {
    view.cleanup();
  }
});

test('목록에서 r 로 이름을 바꾼다 (순서는 그대로)', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION, DEPLOYED], calls)} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('고객 문의 응대'));
    await startScreenReady(view);
    view.stdin.write(TAB);
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN);
    await waitForSettled(view.lastFrame);
    view.stdin.write('r');
    await waitForFrame(view.lastFrame, (value) => value.includes('Enter 저장'));
    await waitForSettled(view.lastFrame);
    for (let i = 0; i < 10; i += 1) view.stdin.write('\u007F');
    await waitForSettled(view.lastFrame);
    view.stdin.write('Q3 report');
    await waitForFrame(view.lastFrame, (value) => value.includes('Q3 report'));
    view.stdin.write('\r');
    const frame = await waitForFrame(
      view.lastFrame,
      (value) => !value.includes('Enter 저장') && value.includes('Q3 report'),
    );
    assert.deepEqual(calls.renamed, [{ workflowId: 'wf_abc', interactionId: 'int-1', title: 'Q3 report' }]);
    assert.doesNotMatch(frame, /분기 매출 정리/);
    assert.ok(frame.indexOf('Q3 report') < frame.indexOf('고객 문의 응대'), '이름을 바꿔도 순서는 그대로');
  } finally {
    view.cleanup();
  }
});

test('목록에서 d 로 지운다: 한 번 묻는다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION, DEPLOYED], calls)} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('고객 문의 응대'));
    await startScreenReady(view);
    view.stdin.write(TAB);
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN);
    await waitForSettled(view.lastFrame);
    view.stdin.write('d');
    await waitForFrame(view.lastFrame, (value) => value.includes('이 채팅을 지울까요?'));
    await waitForSettled(view.lastFrame);
    assert.deepEqual(calls.deleted, [], '묻기 전에는 지우지 않는다');
    view.stdin.write('y');
    const frame = await waitForFrame(
      view.lastFrame,
      (value) => !value.includes('이 채팅을 지울까요?') && !value.includes('분기 매출 정리'),
    );
    assert.deepEqual(calls.deleted, [{ workflowId: 'wf_abc', interactionId: 'int-1' }]);
    assert.match(frame, /고객 문의 응대/);
  } finally {
    view.cleanup();
  }
});

test('Ctrl+K 의 [에이전트가 사라진 채팅 제거] 는 묻고 나서 지운다', async () => {
  const calls = newCalls();
  const view = render(<App engine={fakeEngine(undefined, [CONVERSATION, ORPHAN], calls)} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('지난 회의 정리'));
    await startScreenReady(view);
    view.stdin.write('\u000b'); // Ctrl+K
    // 'Enter 실행' 은 팔레트에만 있다('명령' 은 아래 안내줄에도 있다).
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes('Enter 실행'));
    assert.match(frame, /에이전트가 사라진 채팅 제거 \(1\)/);
    // 팔레트: 새 채팅 · 채팅 검색 · 대화 기록 · 에이전트가 사라진 채팅 제거
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN);
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN);
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN);
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    // 좁은 목록 자리에 뜨므로 묻는 글은 접혀 보인다.
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('지울까요?'));
    assert.match(frame, /1개를/);
    await waitForSettled(view.lastFrame);
    view.stdin.write('y');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('1개를 지웠습니다.'));
    assert.equal(calls.purged, 1);
    assert.doesNotMatch(frame, /지난 회의 정리/);
    assert.doesNotMatch(frame, /에이전트가 사라진 채팅 제거/);
    assert.match(frame, /분기 매출 정리/);
  } finally {
    view.cleanup();
  }
});


// ── 서버 주소를 잘못 쳤을 때 ────────────────────────────────────────
//
// 예전에는 로그인 화면에서 되돌아올 길이 없었다. 할 수 있는 것은 Ctrl+P 로 프로필
// 목록에 가서 **새 프로필을 만드는 것**뿐이었고, 오타 하나에 프로필이 하나 늘었다.

test('로그인 화면에서 Ctrl+E 로 서버 주소를 고친다 — 프로필은 늘지 않는다', async () => {
  const engine = fakeEngine();
  const created: { name: string; serverUrl: string }[] = [];
  engine.setProfile = async (name, serverUrl) => {
    created.push({ name, serverUrl });
    return { name, serverUrl, current: true };
  };
  // 로그인 안 된 상태로 들어가 로그인 화면을 띄운다.
  engine.authStatus = async (profile) => ({
    profile: profile ?? 'corp',
    serverUrl: 'https://xgen.example.com',
    authenticated: false,
    reason: 'missing_session' as const,
  });

  const view = render(<App engine={engine} />);
  try {
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes('로그인'));
    assert.match(frame, /Ctrl\+E/, '서버를 고칠 수 있다는 것이 화면에 있어야 한다');

    await waitForSettled(view.lastFrame);
    view.stdin.write('\u0005'); // Ctrl+E
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('서버 주소 바꾸기'));
    // 지금 값이 채워져 있어야 한다 — 다시 치는 게 아니라 고치는 것이다.
    // 출처는 **프로필**이다(authStatus 가 아니라) — 지금 어느 서버를 가리키고 있는지는
    // 프로필이 정한다.
    assert.match(frame, /https:\/\/xgen\.example\.com/);

    assert.deepEqual(created, [], '아직 아무것도 저장하지 않았다');
  } finally {
    view.cleanup();
  }
});

test('처음 설정 화면은 https 를 생략해도 된다고 말한다', async () => {
  const view = render(<App engine={fakeEngine([])} />);
  try {
    const frame = await waitForFrame(view.lastFrame, (value) => value.includes('처음 오셨군요'));
    assert.match(frame, /https:\/\/ 는 생략해도 됩니다/);
  } finally {
    view.cleanup();
  }
});

// ── 대화 도중 모델 바꾸기 (Ctrl+O · /model) ─────────────────────────
//
// 세션은 그대로다 — 다음 답변부터 고른 모델이 답한다. 지금 모델이 늘 맨 위이고,
// 다른 화면에서 바꾸면 제목 줄이 곧바로 따라간다.

function withModels(engine: TuiEngine): { engine: TuiEngine; picks: Array<{ interactionId: string; provider: string; model: string }> } {
  const choices = [
    { provider: 'anthropic', model: 'claude-sonnet-4-5', name: 'Sonnet 4.5', label: 'Anthropic: Sonnet 4.5', group: 'Anthropic' },
    { provider: 'anthropic', model: 'claude-haiku-4-5', name: 'Haiku 4.5', label: 'Anthropic: Haiku 4.5', group: 'Anthropic' },
    { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI' },
  ];
  const chosen = new Map<string, (typeof choices)[number]>();
  const picks: Array<{ interactionId: string; provider: string; model: string }> = [];
  const view = (id: string) => {
    const current = chosen.get(id) ?? choices[0]!;
    return {
      supported: true,
      locked: false,
      current: { ...current, source: chosen.has(id) ? ('conversation' as const) : ('agent' as const) },
      agent: { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Anthropic: Sonnet 4.5' },
      choices: [current, ...choices.filter((c) => c !== current)],
    };
  };
  engine.conversationModel = async (_wf, id) => view(id);
  engine.setConversationModel = async (_wf, id, choice) => {
    picks.push({ interactionId: id, ...choice });
    chosen.set(id, choices.find((c) => c.provider === choice.provider && c.model === choice.model)!);
    return view(id);
  };
  return { engine, picks };
}

test('Ctrl+O 로 지금 모델이 맨 위인 목록을 열고, 고르면 첫 턴이 그 대화 번호로 나간다', async () => {
  const { engine, picks } = withModels(fakeEngine());
  const sent: Array<string | undefined> = [];
  const resolve = engine.resolveChatInput.bind(engine);
  engine.resolveChatInput = async (input) => {
    sent.push(input.interactionId);
    return resolve(input);
  };
  const view = render(<App engine={engine} />);
  try {
    await startScreenReady(view);
    view.stdin.write(UP); // 에이전트 칸
    await waitForSettled(view.lastFrame);
    view.stdin.write(RIGHT); // Sales Agent: 그 에이전트의 모델이 칸 옆에 선다
    let frame = await waitForFrame(view.lastFrame, (value) => value.includes('Anthropic: Sonnet 4.5'));
    assert.match(frame, /Ctrl\+O 모델/);

    await waitForSettled(view.lastFrame);
    view.stdin.write('\u000f'); // Ctrl+O
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('다음 답변부터'));
    const lines = frame.split('\n');
    const at = (label: string) => lines.findIndex((line) => line.includes(label));
    assert.ok(at('Anthropic: Sonnet 4.5') < at('Anthropic: Haiku 4.5'), '지금 모델이 맨 위');
    assert.match(lines[at('Anthropic: Sonnet 4.5')]!, /✓.*\(현재\)/);

    await waitForSettled(view.lastFrame);
    view.stdin.write('\u001B[B'); // ↓ Haiku
    await waitForSettled(view.lastFrame);
    view.stdin.write('\r');
    frame = await waitForFrame(view.lastFrame, (value) => value.includes('· Anthropic: Haiku 4.5'));
    assert.equal(picks.length, 1);

    // 첫 말이 모델을 고른 그 대화 번호로 나가야 고른 모델이 첫 턴부터 붙는다.
    await waitForSettled(view.lastFrame);
    view.stdin.write(DOWN); // 입력창
    await waitForSettled(view.lastFrame);
    view.stdin.write('hello');
    await waitForFrame(view.lastFrame, (value) => value.includes('hello'));
    view.stdin.write('\r');
    await waitForFrame(view.lastFrame, (value) => value.includes('You said: hello'));
    assert.equal(sent.at(-1), picks[0]!.interactionId);
  } finally {
    view.cleanup();
  }
});

test('다른 화면에서 모델을 바꾸면 제목 줄이 곧바로 따라간다', async () => {
  const { engine } = withModels(fakeEngine());
  const sent: Array<string | undefined> = [];
  const resolve = engine.resolveChatInput.bind(engine);
  engine.resolveChatInput = async (input) => {
    sent.push(input.interactionId);
    return resolve(input);
  };
  const view = render(<App engine={engine} />);
  try {
    await chooseSalesAgent(view);
    await waitForFrame(view.lastFrame, (value) => value.includes('· Anthropic: Sonnet 4.5'));
    await waitForSettled(view.lastFrame);
    view.stdin.write('hello');
    await waitForFrame(view.lastFrame, (value) => value.includes('hello'));
    view.stdin.write('\r');
    await waitForFrame(view.lastFrame, (value) => value.includes('You said: hello'));
    await waitForSettled(view.lastFrame);
    // 다른 대화의 소식은 이 화면과 상관없다.
    engine.onConversationModel?.({
      interactionId: 'someone-else',
      notice: { current: { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Anthropic: Haiku 4.5', source: 'conversation' } },
    });
    engine.onConversationModel?.({
      interactionId: sent.at(-1)!,
      notice: { current: { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI', source: 'conversation' } },
    });
    await waitForFrame(view.lastFrame, (value) => value.includes('· OpenAI: GPT-4o'));
  } finally {
    view.cleanup();
  }
});

test('대화 목록 소켓: 다른 기기의 이름 바꾸기·지우기·새 대화가 곧바로 목록에 보인다', async () => {
  const conversations = [CONVERSATION, DEPLOYED];
  const engine = fakeEngine(undefined, conversations);
  let watched = 0;
  let unwatched = 0;
  engine.watchConversationList = async () => {
    watched += 1;
  };
  engine.unwatchConversationList = () => {
    unwatched += 1;
  };
  const view = render(<App engine={engine} />);
  try {
    await waitForFrame(view.lastFrame, (value) => value.includes('분기 매출 정리'));
    assert.equal(watched, 1, '목록이 서면 목록 소켓을 연다');
    // 다른 기기에서 이름을 바꿨다: 제목만 바뀐다.
    engine.onConversationListChange?.({
      kind: 'conversation_updated',
      interactionId: CONVERSATION.interactionId,
      workflowId: CONVERSATION.workflowId,
      data: { title: '바뀐 이름', custom_title: true },
    });
    await waitForFrame(view.lastFrame, (value) => value.includes('바뀐 이름'));
    // 다른 기기에서 지웠다: 줄이 빠진다.
    engine.onConversationListChange?.({
      kind: 'conversation_deleted',
      interactionId: DEPLOYED.interactionId,
      workflowId: DEPLOYED.workflowId,
      data: {},
    });
    await waitForFrame(view.lastFrame, (value) => !value.includes('고객 문의 응대'));
    // 화면을 내리면 목록 소켓도 닫는다(cleanup 은 내리지 않고 정리만 한다).
    view.unmount();
    assert.equal(unwatched, 1, '화면을 닫으면 목록 소켓도 닫는다');
  } finally {
    view.cleanup();
  }
});
