import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { executeBrowserStep } from '../src/main/browser-step';
import { allowsDeciderAction, type DecisionPost, type ElementRefs } from '../src/main/fast-act';

function fixture() {
  const page: BrowserPageInfo = {
    pageId: 'parent',
    workflowId: 'w',
    workflowName: 'W',
    mode: 'shared',
    url: 'https://example.test/',
    title: '상품',
    loading: 'idle',
    canGoBack: false,
    canGoForward: false,
    partition: 'test',
    generation: 0,
  };
  const pages = new Map([[page.pageId, page]]);
  const commands: string[][] = [];
  let refs: ElementRefs = {};
  let fieldValue = '';
  let applyFill = true;
  let onClick = () => {};
  let onSnapshot = () => {};
  let onDecide = () => {};
  const runtime = {
    get: (id: string) => pages.get(id) ?? null,
    state: () => ({
      enabled: true,
      pages: [...pages.values()],
      activeByWorkflow: { w: 'parent' },
      popupRequests: [],
    }),
    runAgentCommand: async (
      _wid: string,
      id: string | undefined,
      command: string[],
      _timeout?: number,
      generation?: number,
    ) => {
      const p = pages.get(id!);
      assert.ok(p);
      if (generation !== undefined)
        assert.equal(generation, p.generation, 'only use refs from the latest snapshot');
      commands.push(command);
      let data: Record<string, unknown> = {};
      if (command[0] === 'snapshot') {
        p.generation++;
        refs = {
          [`e${p.generation * 10}`]: { role: 'textbox', name: '협력사' },
          [`e${p.generation * 10 + 1}`]: { role: 'textbox', name: '상품명' },
          [`e${p.generation * 10 + 2}`]: { role: 'button', name: '확인' },
        };
        onSnapshot();
        data = { refs, snapshot: JSON.stringify(refs) };
      } else if (command[0] === 'fill') {
        assert.ok(refs[command[1].slice(1)]);
        if (applyFill) fieldValue = command[2];
      } else if (command[0] === 'click') onClick();
      else if (command[0] === 'get' && command[1] === 'value') data = { value: fieldValue };
      else if (command[0] === 'get' && command[1] === 'text') data = { text: '검색 결과 플래티어' };
      else throw new Error(`Unexpected command ${command.join(' ')}`);
      return { page: { ...(pages.get(id!) ?? page) }, result: { success: true, data } };
    },
  };
  const post: DecisionPost = async (body) => {
    onDecide();
    const name = body.state.endsWith('확인 클릭') ? '확인' : '협력사';
    const chosen = Object.keys(refs).find((k) => refs[k].name === name)!;
    return Object.fromEntries(
      Object.entries(body.questions).map(([key, question]) => [
        key,
        {
          choice: chosen,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((k) => [k, k === chosen ? 0.99 : 0.005]),
          ),
        },
      ]),
    );
  };
  return {
    page,
    pages,
    runtime,
    commands,
    post,
    setValue: (v: string) => {
      fieldValue = v;
    },
    ignoreFill: () => {
      applyFill = false;
    },
    onClick: (fn: () => void) => {
      onClick = fn;
    },
    onSnapshot: (fn: () => void) => {
      onSnapshot = fn;
    },
    onDecide: (fn: () => void) => {
      onDecide = fn;
    },
  };
}

const fill = {
  operation: 'fill',
  instruction: '협력사 입력',
  text: '플래티어 "정확한 값"',
  expect: [{ kind: 'value', target: '협력사', value: '플래티어 "정확한 값"' }],
};
const execute = (
  f: ReturnType<typeof fixture>,
  args: Record<string, unknown> = fill,
  signal?: AbortSignal,
) =>
  executeBrowserStep(f.runtime, f.post, { ...f.page }, args, () => {}, allowsDeciderAction, signal);

test('planner text is filled exactly once and verified using a fresh ref and actual value', async () => {
  const f = fixture();
  const done = await execute(f);
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(
    f.commands.filter((c) => c[0] === 'fill'),
    [['fill', '@e10', fill.text]],
  );
  assert.ok(f.commands.some((c) => c.join(' ') === 'get value @e20'));
  assert.equal(
    f.commands.some((c) => c[0] === 'press'),
    false,
    'fill does not silently submit',
  );
});

test('a successful command with an unchanged field needs replanning and is never replayed', async () => {
  const f = fixture();
  f.ignoreFill();
  const done = await execute(f);
  assert.equal(done.result.status, 'needs_replan');
  assert.equal(f.commands.filter((c) => c[0] === 'fill').length, 1);
  assert.match(JSON.stringify(done.result.checks), /"actual":""/);
});

test('popup completion checks both closure and the actual parent field', async () => {
  const f = fixture();
  const popup: BrowserPageInfo = {
    ...f.page,
    pageId: 'popup',
    mode: 'popup',
    openerPageId: 'parent',
  };
  f.pages.set('popup', popup);
  f.onClick(() => {
    f.pages.delete('popup');
    f.setValue('플래ティア');
  });
  const args = {
    operation: 'click',
    instruction: '확인 클릭',
    expect: [{ kind: 'popup_closed' }, { kind: 'value', target: '협력사', value: '플래티어' }],
  };
  const done = await executeBrowserStep(
    f.runtime,
    f.post,
    popup,
    args,
    () => {},
    allowsDeciderAction,
  );
  assert.equal(done.result.status, 'needs_replan', 'closure alone cannot prove supplier selection');
  assert.equal(done.page.pageId, 'parent');
  assert.equal(f.commands.filter((c) => c[0] === 'click').length, 1);
  f.setValue('플래티어');
  const verified = await execute(f, {
    operation: 'observe',
    instruction: '부모 협력사 확인',
    expect: [args.expect[1]],
  });
  assert.equal(verified.result.status, 'completed');
});

test('new popup observations follow the opened page rather than the original parent', async () => {
  const f = fixture();
  f.onClick(() =>
    f.pages.set('popup', {
      ...f.page,
      pageId: 'popup',
      mode: 'popup',
      openerPageId: 'parent',
      url: 'https://example.test/vendor',
    }),
  );
  const done = await execute(f, {
    operation: 'click',
    instruction: '확인 클릭',
    expect: [{ kind: 'url', value: 'https://example.test/vendor' }],
  });
  assert.equal(done.result.status, 'completed');
  assert.equal(done.page.pageId, 'popup');
});

test('a popup command interrupted after closure can complete only after verifying its parent callback', async () => {
  const f = fixture();
  const popup: BrowserPageInfo = {
    ...f.page,
    pageId: 'popup',
    mode: 'popup',
    openerPageId: 'parent',
  };
  f.pages.set('popup', popup);
  f.onClick(() => {
    f.pages.delete('popup');
    f.setValue('플래티어');
    throw new Error('agent-browser exited null');
  });
  const done = await executeBrowserStep(
    f.runtime,
    f.post,
    popup,
    {
      operation: 'click',
      instruction: '확인 클릭',
      expect: [{ kind: 'popup_closed' }, { kind: 'value', target: '협력사', value: '플래티어' }],
    },
    () => {},
    allowsDeciderAction,
  );
  assert.equal(done.result.status, 'completed');
  assert.match(String(done.result.execution_error), /exited null/);
  assert.equal(f.commands.filter((c) => c[0] === 'click').length, 1);
});

test('cancellation during a decision prevents the mutation', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.onDecide(() => controller.abort());
  const done = await execute(f, fill, controller.signal);
  assert.equal(done.result.status, 'blocked');
  assert.equal(done.result.mutation_attempted, false);
  assert.equal(
    f.commands.some((c) => c[0] === 'fill'),
    false,
  );
});

test('dangerous requests keep their existing confirmation path', async () => {
  const f = fixture();
  const done = await execute(f, {
    operation: 'click',
    instruction: '모두 삭제해',
    expect: [{ kind: 'text', value: '완료' }],
  });
  assert.equal(done.result.status, 'blocked');
  assert.equal(
    f.commands.some((c) => c[0] === 'click'),
    false,
  );
});

test('malformed and missing completion checks are rejected before any browser command', async () => {
  const f = fixture();
  for (const args of [
    { ...fill, expect: [] },
    { ...fill, expect: [{ kind: 'text', value: '완료' }] },
    { operation: 'observe', instruction: '확인', expect: [{ kind: 'text', value: '' }] },
  ])
    await assert.rejects(execute(f, args), /check/);
  assert.equal(f.commands.length, 0);
});

test('final verification never performs an action and checks actual text', async () => {
  const f = fixture();
  const done = await execute(f, {
    operation: 'observe',
    instruction: '검색 결과 확인',
    expect: [{ kind: 'text', value: '플래티어' }],
  });
  assert.equal(done.result.status, 'completed');
  assert.equal(done.result.mutation_attempted, false);
  assert.ok(f.commands.every((c) => ['snapshot', 'get'].includes(c[0])));
  // LLM 에 돌려주는 결과: 요소만 읽은 스냅샷 글, refs 없음, 통과한 글 검사는 찾은 글만.
  assert.ok(f.commands.filter((c) => c[0] === 'snapshot').every((c) => c[1] === '-i'));
  assert.equal(typeof done.result.observation, 'string');
  assert.deepEqual((done.result.checks as Array<{ actual: unknown }>).map((c) => c.actual), ['플래티어']);
});

test('voice requests wait for the conversation planner without speculative browser actions', async () => {
  const { VoiceStreamHub } = await import('../src/main/voice-stream');
  const previous = process.env.DEX_VOICE_TEST;
  process.env.DEX_VOICE_TEST = '1';
  try {
    const hub = new VoiceStreamHub(() => ({
      baseUrl: () => 'https://example.test',
      token: async () => '',
      allowPrivateCertificate: () => false,
      wakeWords: () => null,
      planBeforeAct: () => true,
    }));
    const events: unknown[] = [];
    const result = await hub.testText('w', '협력사 입력하고 확인해줘', (e) => events.push(e));
    assert.equal(result.text, '협력사 입력하고 확인해줘');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(events, []);
  } finally {
    if (previous === undefined) delete process.env.DEX_VOICE_TEST;
    else process.env.DEX_VOICE_TEST = previous;
  }
});
