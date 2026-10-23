import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { executeBrowserStep } from '../src/main/browser-step';
import { allowsDeciderAction, type DecisionPost, type ElementRefs } from '../src/main/fast-act';
import { FIELD_LABEL_SCRIPT, type FieldLabel } from '../src/main/fast-act-labels';

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
  let bodyText = '검색 결과 플래티어';
  let fields: FieldLabel[] = [];
  let checked = false;
  let snapshotText: ((refs: ElementRefs) => string) = JSON.stringify;
  let applyFill = true;
  let onClick = () => {};
  let onSnapshot = (_refs: ElementRefs) => {};
  let onDecide = () => {};
  const runtime = {
    get: (id: string) => pages.get(id) ?? null,
    state: () => ({
      enabled: true,
      pages: [...pages.values()],
      activeByWorkflow: { w: 'parent' },
      popupRequests: [],
    }),
    pageScript: async <T>(_wid: string, _id: string, code: string): Promise<T> =>
      (code === FIELD_LABEL_SCRIPT ? fields : 0) as T,
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
        onSnapshot(refs);
        data = { refs, snapshot: snapshotText(refs) };
      } else if (command[0] === 'fill') {
        assert.ok(refs[command[1].slice(1)]);
        if (applyFill) fieldValue = command[2];
      } else if (command[0] === 'click') onClick();
      else if (command[0] === 'check' || command[0] === 'uncheck') checked = command[0] === 'check';
      else if (command[0] === 'is' && command[1] === 'checked') data = { checked };
      else if (command[0] === 'get' && command[1] === 'value') data = { value: fieldValue };
      else if (command[0] === 'get' && command[1] === 'text') data = { text: bodyText };
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
    setBodyText: (text: string) => { bodyText = text; },
    setFields: (value: FieldLabel[]) => { fields = value; },
    setSnapshotText: (render: (refs: ElementRefs) => string) => { snapshotText = render; },
    ignoreFill: () => {
      applyFill = false;
    },
    onClick: (fn: () => void) => {
      onClick = fn;
    },
    onSnapshot: (fn: (refs: ElementRefs) => void) => {
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

test('step decider receives the same unnamed field context as the form runner', async () => {
  const f = fixture();
  f.setFields([{ role: 'textbox', hint: '', label: '업체상품번호' }, { role: 'textbox', hint: '', label: '모델명' }]);
  f.onSnapshot(refs => { for (const ref of Object.values(refs)) if (ref.role === 'textbox') ref.name = ''; });
  f.setSnapshotText(refs => Object.entries(refs).map(([ref, el]) => `- ${el.role} "${el.name}" [ref=${ref}]`).join('\n'));
  const post: DecisionPost = async body => {
    assert.match(body.state, /업체상품번호/);
    assert.match(body.state, /모델명/);
    const ref = `e${f.page.generation * 10 + 1}`;
    return Object.fromEntries(Object.keys(body.questions).map(key => [key, { choice: ref, probabilities: { [ref]: 0.99 } }]));
  };
  const done = await executeBrowserStep(f.runtime, post, { ...f.page }, {
    operation: 'fill', instruction: '모델명 입력', text: 'ID-ORG-04-IV',
    expect: [{ kind: 'value', target: '모델명', value: 'ID-ORG-04-IV' }],
  }, () => {}, allowsDeciderAction);
  assert.equal(done.result.status, 'completed', JSON.stringify(done.result));
  assert.deepEqual(f.commands.filter(c => c[0] === 'fill'), [['fill', '@e11', 'ID-ORG-04-IV']]);
  assert.ok(f.commands.some(c => c.join(' ') === 'get value @e21'));
});

test('an unnamed supplier radio is identified by its row instead of a neighbouring supplier', async () => {
  const f = fixture();
  f.onSnapshot(refs => {
    const keys = Object.keys(refs);
    refs[keys[0]] = { role: 'row', name: '1000001 플래티어' };
    refs[keys[1]] = { role: 'radio', name: '' };
  });
  f.setSnapshotText(refs => {
    const [row, radio, button] = Object.keys(refs);
    return `- row "1000001 플래티어" [ref=${row}]\n  - radio [ref=${radio}]\n- button "확인" [ref=${button}]`;
  });
  const post: DecisionPost = async body => {
    const ref = `e${f.page.generation * 10 + 1}`;
    assert.match(body.state, /radio.*1000001 플래티어/);
    return Object.fromEntries(Object.keys(body.questions).map(key => [key, { choice: ref, probabilities: { [ref]: 0.99 } }]));
  };
  const done = await executeBrowserStep(f.runtime, post, { ...f.page }, {
    operation: 'check', instruction: '협력사 플래티어 선택',
    expect: [{ kind: 'checked', target: '1000001 플래티어', checked: true }],
  }, () => {}, allowsDeciderAction);
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(f.commands.filter(c => c[0] === 'check'), [['check', '@e11']]);
});

test('failed decisions and verification return the generation of the latest observation', async () => {
  const f = fixture();
  f.onDecide(() => { throw new Error('No confident target'); });
  const blocked = await execute(f);
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.page.generation, f.page.generation);
  f.onDecide(() => {});
  f.ignoreFill();
  const unverified = await execute(f);
  assert.equal(unverified.result.status, 'needs_replan');
  assert.equal(unverified.page.generation, f.page.generation);
  await f.runtime.runAgentCommand('w', unverified.page.pageId, ['get', 'value', '@e0'], 5000, unverified.page.generation);
});

test('fill uses quoted instruction text when text is omitted', async () => {
  const f = fixture();
  const done = await execute(f, {
    operation: 'fill',
    instruction: '협력사 칸에 「안녕」을 입력해줘',
    expect: [{ kind: 'value', target: '협력사', value: '안녕' }],
  });
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(f.commands.filter((c) => c[0] === 'fill'), [['fill', '@e10', '안녕']]);
});

test('explicit fill text takes precedence over quoted instruction text, including an empty value', async () => {
  for (const text of ['직접 전달한 값', '']) {
    const f = fixture();
    const done = await execute(f, {
      operation: 'fill', instruction: '협력사에 「다른 값」 입력해줘', text,
      expect: [{ kind: 'value', target: '협력사', value: text }],
    });
    assert.equal(done.result.status, 'completed');
    assert.deepEqual(f.commands.filter((c) => c[0] === 'fill'), [['fill', '@e10', text]]);
  }
});

test('fill rejects missing text and unusable quotes before any browser command', async () => {
  const f = fixture();
  for (const instruction of ['협력사 입력해줘', '협력사에 「」 입력해줘', '협력사에 「안녕 입력해줘']) {
    await assert.rejects(execute(f, { ...fill, instruction, text: undefined }), /put the exact text in `text`/);
  }
  assert.equal(f.commands.length, 0);
});

test('quoted fill text still requires a matching value check and does not replace invalid text', async () => {
  const f = fixture();
  const args = { ...fill, instruction: '협력사에 「안녕」 입력해줘', text: undefined };
  await assert.rejects(execute(f, args), /value check matching the exact text/);
  for (const text of [null, 123]) {
    await assert.rejects(execute(f, { ...args, text }), /text must be a string/);
  }
  assert.equal(f.commands.length, 0);
});

test('quoted action words in a field value do not block an exact fill', async () => {
  const f = fixture();
  const text = '삭제 금지 상품, 승인요청 문구';
  const done = await execute(f, {
    operation: 'fill', instruction: `협력사에 「${text}」 입력해줘`, text,
    expect: [{ kind: 'value', target: '협력사', value: text }],
  });
  assert.equal(done.result.status, 'completed');
  assert.equal(f.commands.filter(c => c[0] === 'fill').length, 1);
});

test('pre-existing menu text cannot verify a click, and the click is never replayed', async () => {
  const f = fixture();
  f.setBodyText('메일쓰기 임시보관함');
  const done = await execute(f, {
    operation: 'click', instruction: '확인 클릭',
    expect: [{ kind: 'text', value: '임시보관함' }],
  });
  assert.equal(done.result.status, 'needs_replan');
  assert.equal(f.commands.filter(c => c[0] === 'click').length, 1);
  assert.equal((done.result.checks as Array<{ changed: boolean }>)[0].changed, false);
});

test('a new completion notice verifies a click while an unchanged URL does not', async () => {
  const f = fixture();
  f.onClick(() => f.setBodyText('메일이 임시저장되었습니다.'));
  const done = await execute(f, {
    operation: 'click', instruction: '확인 클릭',
    expect: [{ kind: 'text', value: '메일이 임시저장되었습니다.' }],
  });
  assert.equal(done.result.status, 'completed');
  const unchanged = await execute(f, {
    operation: 'click', instruction: '확인 클릭',
    expect: [{ kind: 'url', value: f.page.url }],
  });
  assert.equal(unchanged.result.status, 'needs_replan');
  f.setBodyText('메일쓰기');
  f.onClick(() => f.setBodyText('메일쓰기 메일이 임시저장되었습니다.'));
  const mixed = await execute(f, {
    operation: 'click', instruction: '확인 클릭',
    expect: [{ kind: 'text', value: '메일쓰기' }, { kind: 'text', value: '메일이 임시저장되었습니다.' }],
  });
  assert.equal(mixed.result.status, 'completed');
});

test('navigation to a registration page reaches runtime inspection instead of a keyword block', async () => {
  const f = fixture();
  f.onClick(() => { f.page.url = 'https://example.test/register'; });
  f.onSnapshot(refs => {
    for (const ref of Object.values(refs)) {
      if (ref.role === 'button') Object.assign(ref, { role: 'link', name: '상품 등록' });
    }
  });
  const post: DecisionPost = async body => Object.fromEntries(Object.keys(body.questions).map(key =>
    [key, { choice: 'e12', probabilities: { e12: 0.99 } }]));
  const done = await executeBrowserStep(f.runtime, post, { ...f.page }, {
    operation: 'click', instruction: '상품 등록 페이지로 이동해줘',
    expect: [{ kind: 'url', value: 'https://example.test/register' }],
  }, () => {}, allowsDeciderAction);
  assert.equal(done.result.status, 'completed');
  assert.equal(f.commands.filter(c => c[0] === 'click').length, 1);
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
