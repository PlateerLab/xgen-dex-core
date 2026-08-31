/**
 * 목록 맨 위의 [＋ 새 에이전트].
 *
 * 에이전트를 만드는 일이 CLI 에도 있어야 한다 — 웹에서 만들고 CLI 로 와서 쓰는 것이
 * 아니라, 어디서 시작하든 같은 자리에서 만들 수 있어야 한다. 따로 단축키를 외우게
 * 하는 대신 목록의 한 줄로 두어 ↑↓ 로 닿는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';
import { AgentCreateScreen } from '../src/tui/agent-create';
import type { TuiEngine } from '../src/tui/model';

const ARROW_DOWN = '\u001B[B';
const ARROW_RIGHT = '\u001B[C';
const ESCAPE = '\u001B';

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

function engine(overrides: Partial<TuiEngine> = {}): TuiEngine {
  return {
    async agentCreateOptions() {
      return OPTIONS;
    },
    async createAgent(input: { name: string }) {
      return { workflowId: 'wf_new', workflowName: input.name };
    },
    ...overrides,
  } as unknown as TuiEngine;
}

/** 프레임이 두 번 같아질 때까지 기다린다 — 시간이 아니라 안정을 기다린다. */
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

function screen(props: Partial<Parameters<typeof AgentCreateScreen>[0]> = {}) {
  const created: Array<{ workflowId: string; workflowName: string }> = [];
  const cancelled: boolean[] = [];
  const instance = render(
    <AgentCreateScreen
      engine={engine()}
      profile="corp"
      hangulMode={false}
      onHangulModeChange={() => undefined}
      onCreated={(agent) => void created.push(agent)}
      onCancel={() => void cancelled.push(true)}
      {...props}
    />,
  );
  return { instance, created, cancelled };
}

test('이름과 모델을 먼저 묻는다 — 세부설정은 접혀 있다', async () => {
  // 물어야 할 것은 "무엇을 연결할까"가 아니라 "이름이 무엇이고 어떤 모델로 생각하는가"다.
  const { instance } = screen();
  const frame = await settled(instance);
  assert.match(frame, /새 에이전트/);
  assert.match(frame, /이름/);
  assert.match(frame, /AI 제공사/);
  assert.match(frame, /모델/);
  assert.doesNotMatch(frame, /도구 노출 방식/, '세부설정은 Tab 을 눌러야 보인다');
});

test('Tab 으로 세부설정을 펼친다', async () => {
  const { instance } = screen();
  await settled(instance);
  instance.stdin.write('\t');
  const frame = await settled(instance);
  assert.match(frame, /도구 노출 방식/);
  assert.match(frame, /자기진화/);
});

test('기본 도구 노출은 계층형이다', async () => {
  // 도구 목록은 재고 목록이 아니라 지도다. 만들자마자 그래야 한다.
  const { instance } = screen();
  await settled(instance);
  instance.stdin.write('\t');
  const frame = await settled(instance);
  assert.match(frame, /계층형/);
  assert.doesNotMatch(frame, /‹ 평면형 ›/);
});

test('제공사를 바꾸면 모델도 그 제공사의 것으로 따라온다', async () => {
  // 그대로 두면 OpenAI 모델 이름으로 Anthropic 을 부르는 에이전트가 만들어진다.
  const { instance } = screen();
  await settled(instance);
  assert.match(await settled(instance), /GPT-4o mini/);
  instance.stdin.write(ARROW_DOWN); // ↓ AI 제공사
  await settled(instance);
  instance.stdin.write(ARROW_RIGHT); // → 다음 제공사
  const frame = await settled(instance);
  assert.match(frame, /Anthropic/);
  assert.match(frame, /Claude Sonnet/);
  assert.doesNotMatch(frame, /GPT-4o/);
});

test('이름이 비어 있으면 만들지 않는다', async () => {
  // 이름 없는 에이전트는 목록에서 찾을 수가 없다.
  const created: Array<unknown> = [];
  const { instance } = screen({
    engine: engine({
      async createAgent(input: { name: string }) {
        created.push(input);
        return { workflowId: 'wf_new', workflowName: input.name };
      },
    }),
  });
  await settled(instance);
  instance.stdin.write(ARROW_DOWN); // 글자 칸을 벗어나 Enter 가 여기서 처리되게
  await settled(instance);
  instance.stdin.write('\r');
  await settled(instance);
  assert.deepEqual(created, []);
});

test('이름을 치는 중에도 Esc 로 나갈 수 있다', async () => {
  // 글자 칸에 있다고 화면 키를 꺼 두면 사용자는 첫 칸에서 갇힌다.
  const { instance, cancelled } = screen();
  await settled(instance);
  instance.stdin.write(ESCAPE);
  await settled(instance);
  assert.deepEqual(cancelled, [true]);
});

test('불러오지 못하면 그렇다고 말한다', async () => {
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
});

test('이름을 치는 중에도 ↓ 로 내려가고 Tab 으로 세부설정을 펼친다', async () => {
  const { instance } = screen();
  await settled(instance);
  instance.stdin.write('\t');
  assert.match(await settled(instance), /도구 노출 방식/, '첫 칸에서도 Tab 이 듣는다');
  instance.stdin.write(ARROW_DOWN);
  const frame = await settled(instance);
  assert.match(frame, /› AI 제공사/, '첫 칸에서도 ↓ 가 듣는다');
});
