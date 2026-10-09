/**
 * 시작 화면 (2026-10-09): [＋ 새 채팅] 과 Ctrl+N 이 여는 자리.
 *
 * 따로 있던 [＋ 새 에이전트] 만들기 화면이 여기 들어왔다. 기본은 [새 에이전트로 시작] 이고,
 * 그 칸들(이름·AI 제공사·모델·세부설정)의 규칙은 예전 만들기 화면과 같다. 있는 에이전트를
 * 고르면 칸 없이 바로 첫 말을 적는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';
import type { Agent } from '@dex/engine';
import { NAME_CHECK_MS, NAME_REQUIRED, StartScreen, type AgentRef } from '../src/tui/start-screen';
import type { TuiEngine } from '../src/tui/model';

const UP = '\u001B[A';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';

const OPTIONS = {
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

function agent(workflowId: string, workflowName: string): Agent {
  return {
    id: 1,
    workflowId,
    workflowName,
    nodeCount: 1,
    isShared: false,
    isDeployed: true,
    isCompleted: true,
    description: '',
    username: 'alice',
    fullName: 'Alice',
    createdAt: '',
    updatedAt: '',
  };
}

const AGENTS = [agent('wf_sales', 'Sales Agent'), agent('wf_support', 'Support Desk')];

function engine(overrides: Partial<TuiEngine> = {}, checks: string[] = []): TuiEngine {
  return {
    async agentCreateOptions() {
      return OPTIONS;
    },
    async agentNameTaken(name: string) {
      checks.push(name);
      return name === 'Sales Agent';
    },
    async createAgent(input: { name: string }) {
      return { workflowId: 'wf_new', workflowName: input.name };
    },
    ...overrides,
  } as unknown as TuiEngine;
}

/** 프레임이 두 번 같아질 때까지 기다린다. 시간이 아니라 안정을 기다린다. */
async function settled(instance: { lastFrame: () => string | undefined }): Promise<string> {
  let previous = '';
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const frame = instance.lastFrame() ?? '';
    if (frame && frame === previous) return frame;
    previous = frame;
  }
  return previous;
}

function screen(props: Partial<Parameters<typeof StartScreen>[0]> = {}) {
  const started: Array<{ agent: AgentRef; text: string }> = [];
  const instance = render(
    <StartScreen
      engine={engine()}
      profile="corp"
      agents={AGENTS}
      focused
      hangulMode={false}
      onHangulModeChange={() => undefined}
      onStart={(picked, text) => void started.push({ agent: picked, text })}
      {...props}
    />,
  );
  return { instance, started };
}

test('기본은 [새 에이전트로 시작]: 이름과 모델을 묻고 세부설정은 접혀 있다', async () => {
  const { instance } = screen();
  const frame = await settled(instance);
  assert.match(frame, /오늘은 무엇을 해볼까요\?/);
  assert.match(frame, /‹ 새 에이전트로 시작 ›/);
  assert.match(frame, /› 이름/, '처음 커서는 이름 칸');
  assert.match(frame, /AI 제공사/);
  assert.match(frame, /GPT-4o mini/, '모델은 제공사의 기본 모델');
  assert.match(frame, /세부설정/);
  assert.doesNotMatch(frame, /도구 노출 방식/, '세부설정은 펼쳐야 보인다');
});

test('세부설정을 펼치면 기본 도구 노출은 계층형이다', async () => {
  const { instance } = screen();
  await settled(instance);
  for (const _ of [1, 2, 3]) {
    instance.stdin.write(DOWN); // AI 제공사 · 모델 · 세부설정
    await settled(instance);
  }
  instance.stdin.write(RIGHT);
  const frame = await settled(instance);
  assert.match(frame, /도구 노출 방식/);
  assert.match(frame, /자기진화/);
  assert.match(frame, /계층형/);
  assert.doesNotMatch(frame, /‹ 평면형 ›/);
});

test('제공사를 바꾸면 모델도 그 제공사의 것으로 따라온다', async () => {
  // 그대로 두면 OpenAI 모델 이름으로 Anthropic 을 부르는 에이전트가 만들어진다.
  const { instance } = screen();
  await settled(instance);
  instance.stdin.write(DOWN); // ↓ AI 제공사
  await settled(instance);
  instance.stdin.write(RIGHT); // → 다음 제공사
  const frame = await settled(instance);
  assert.match(frame, /Anthropic/);
  assert.match(frame, /Claude Sonnet/);
  assert.doesNotMatch(frame, /GPT-4o/);
});

test('칸을 불러오지 못하면 그렇다고 말하고 잠근다', async () => {
  // 못 불러온 것을 빈 목록으로 보여 주면 사용자는 고를 것이 없는 줄 안다.
  const { instance } = screen({
    engine: engine({
      async agentCreateOptions() {
        throw new Error('서버에 닿지 못했습니다');
      },
    }),
  });
  const frame = await settled(instance);
  assert.match(frame, /서버에 닿지 못했습니다/);
  assert.match(frame, /잠김/);
});

test('이름은 글자마다가 아니라 잠깐 멈췄을 때 한 번 묻는다', async () => {
  const checks: string[] = [];
  const { instance } = screen({ engine: engine({}, checks) });
  await settled(instance);
  for (const ch of 'abc') {
    instance.stdin.write(ch);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await new Promise((resolve) => setTimeout(resolve, NAME_CHECK_MS + 200));
  assert.deepEqual(checks, ['abc']);
  assert.doesNotMatch(await settled(instance), /잠김/);
});

test('이름 없이 보내면 이름부터 적으라고 한다', async () => {
  const { instance, started } = screen();
  await settled(instance);
  instance.stdin.write('\r'); // 이름 칸 → 입력창
  await settled(instance);
  instance.stdin.write('hi');
  await settled(instance);
  instance.stdin.write('\r');
  const frame = await settled(instance);
  assert.ok(frame.includes(NAME_REQUIRED));
  assert.deepEqual(started, []);
});

test('있는 에이전트는 찾아서 고르고 바로 첫 말을 보낸다 (만들지 않는다)', async () => {
  const created: unknown[] = [];
  const { instance, started } = screen({
    engine: engine({
      async createAgent(input: { name: string }) {
        created.push(input);
        return { workflowId: 'wf_new', workflowName: input.name };
      },
    }),
  });
  await settled(instance);
  instance.stdin.write(UP); // 에이전트 칸
  await settled(instance);
  instance.stdin.write('\r'); // 찾기 목록
  let frame = await settled(instance);
  assert.match(frame, /Support Desk/);
  instance.stdin.write('sup');
  frame = await settled(instance);
  assert.doesNotMatch(frame, /Sales Agent/, '찾는 글에 맞는 것만');
  instance.stdin.write('\r');
  frame = await settled(instance);
  assert.match(frame, /‹ Support Desk ›/);
  assert.doesNotMatch(frame, /AI 제공사/, '있는 에이전트에는 만들기 칸이 없다');
  assert.doesNotMatch(frame, /잠김/);
  instance.stdin.write('hello');
  await settled(instance);
  instance.stdin.write('\r');
  await settled(instance);
  assert.deepEqual(started, [{ agent: { workflowId: 'wf_support', workflowName: 'Support Desk' }, text: 'hello' }]);
  assert.deepEqual(created, []);
});
