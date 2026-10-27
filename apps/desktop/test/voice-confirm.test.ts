import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createConfirmVoiceResponder, type VoiceConfirmTarget } from '../src/renderer/src/voice/confirm-response';
import type { VoiceConfirmIntent } from '@dex/protocol/voice-confirm';

test('manual recording can be stopped after its card closes while the agent remains busy', () => {
  const source = ts.createSourceFile('Chat.tsx', readFileSync(new URL('../src/renderer/src/views/Chat.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let disabled: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button') {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      if (attrs.some(a => a.name.getText(source) === 'onClick' && a.initializer?.getText(source) === '{toggleMic}')) {
        const value = attrs.find(a => a.name.getText(source) === 'disabled')?.initializer;
        if (value && ts.isJsxExpression(value)) disabled = value.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(disabled, 'the actual microphone button must expose its disabled state');
  const state = { streamVoice: false, recording: true, transcribing: false, busy: true, voiceConfirm: {} as object | null };
  const isDisabled = () => runInNewContext(disabled!.getText(source), state);
  assert.equal(isDisabled(), false, 'recording can stop while the card is open');
  state.voiceConfirm = null;
  assert.equal(isDisabled(), false, 'closing the card must not disable recording stop');
  state.recording = false;
  assert.equal(isDisabled(), true, 'busy agent still prevents starting a new manual recording');
  state.busy = false;
  state.transcribing = true;
  assert.equal(isDisabled(), true, 'transcription still prevents another manual recording');
  state.streamVoice = true;
  assert.equal(isDisabled(), false, 'continuous listening can still be toggled');
});

function fixture(kind: 'browser' | 'user' = 'browser') {
  let target: VoiceConfirmTarget | null = kind === 'browser'
    ? { kind, request: { requestId: 'first', workflowId: 'wf', tool: 'click', dialogText: '저장?', buttons: ['확인'], press: '확인', createdAt: 1, expiresAt: Date.now() + 60_000 } }
    : { kind, request: { requestId: 'first', workflowId: 'wf', question: '진행?', createdAt: 1, expiresAt: Date.now() + 60_000 } };
  const answers: unknown[] = [];
  const notices: string[] = [];
  const decisions: { requestId: string; text: string }[] = [];
  let intent: VoiceConfirmIntent = 'approve';
  let decide = async (requestId: string, text: string) => { decisions.push({ requestId, text }); return intent; };
  let resolve = async (answer: unknown) => { answers.push(answer); return true; };
  const respond = createConfirmVoiceResponder({ current: () => target, decide: (id, text) => decide(id, text), browser: a => resolve(a), user: a => resolve(a), notice: t => notices.push(t) });
  return { respond, answers, notices, decisions, get target() { return target; }, set target(value) { target = value; }, set intent(value: VoiceConfirmIntent) { intent = value; }, set decide(value: typeof decide) { decide = value; }, set resolve(value: typeof resolve) { resolve = value; } };
}

test('decider approval, rejection and revision use the existing APIs and preserve the original speech', async () => {
  for (const kind of ['browser', 'user'] as const) {
    for (const [text, intent] of [['응 그렇게 해줘', 'approve'], ['이번에는 하지 않았으면 좋겠어', 'reject'], ['응 그런데 가격부터 낮추자', 'revise']] as const) {
      const f = fixture(kind);
      f.intent = intent;
      assert.equal(await f.respond(text, 'first'), true);
      const choice = kind === 'browser' ? (intent === 'approve' ? 'once' : 'deny') : (intent === 'approve' ? 'proceed' : 'revise');
      assert.deepEqual(f.decisions, [{ requestId: 'first', text }]);
      assert.deepEqual(f.answers, [{ requestId: 'first', choice, ...(intent === 'revise' ? { message: text } : {}) }]);
    }
  }
});

test('conversation permission requires the explicit scoped phrase and only applies to browser cards', async () => {
  const f = fixture();
  f.intent = 'unclear';
  await f.respond('다시 묻지 마', 'first');
  assert.deepEqual(f.answers, []);
  f.intent = 'conversation';
  await f.respond('이 대화에서 같은 창은 다시 묻지 마', 'first');
  assert.deepEqual(f.answers, [{ requestId: 'first', choice: 'conversation' }]);
  const user = fixture('user');
  user.intent = 'conversation';
  await user.respond('이 대화에서 같은 창은 다시 묻지 마', 'first');
  assert.deepEqual(user.answers, []);
});

test('ambiguous speech stays on the card; ordinary speech without a card is not consumed', async () => {
  const f = fixture();
  f.intent = 'unclear';
  assert.equal(await f.respond('음 글쎄', 'first'), true);
  assert.match(f.notices.at(-1)!, /확실히 이해하지/);
  assert.deepEqual(f.answers, []);
  assert.deepEqual(f.decisions, [{ requestId: 'first', text: '음 글쎄' }]);
  f.target = null;
  assert.equal(await f.respond('일반 채팅', null), false);
});

test('expired, removed, replaced and pre-card recordings never resolve a card', async () => {
  const f = fixture();
  assert.equal(await f.respond('네', null), true);
  assert.equal(await f.respond('네', 'other'), true);
  f.target!.request.expiresAt = Date.now() - 1;
  assert.equal(await f.respond('네', 'first'), true);
  f.target = null;
  assert.equal(await f.respond('네', 'first'), true);
  assert.deepEqual(f.answers, []);
  assert.deepEqual(f.decisions, []);
});

test('pending and successful answers are sent only once; failures allow retry', async () => {
  const f = fixture();
  let finish!: (value: boolean) => void;
  f.resolve = async answer => { f.answers.push(answer); return new Promise<boolean>(r => { finish = r; }); };
  const first = f.respond('네', 'first');
  await f.respond('네', 'first');
  assert.equal(f.answers.length, 1);
  finish(true);
  await first;
  await f.respond('네', 'first');
  assert.equal(f.answers.length, 1);

  const retry = fixture();
  retry.resolve = async () => { throw new Error('offline'); };
  await retry.respond('네', 'first');
  assert.match(retry.notices.at(-1)!, /처리하지 못/);
  retry.resolve = async answer => { retry.answers.push(answer); return true; };
  await retry.respond('네', 'first');
  assert.equal(retry.answers.length, 1);
});

test('a card that expires, disappears or changes while decider is running is never resolved', async () => {
  for (const change of ['expired', 'removed', 'replaced'] as const) {
    const f = fixture();
    let finish!: (intent: VoiceConfirmIntent) => void;
    f.decide = () => new Promise(r => { finish = r; });
    const response = f.respond('응 그렇게 해줘', 'first');
    if (change === 'removed') f.target = null;
    else if (change === 'replaced') f.target!.request.requestId = 'second';
    else f.target!.request.expiresAt = Date.now() - 1;
    finish('approve');
    await response;
    assert.deepEqual(f.answers, [], change);
  }
});

test('decider timeouts leave the card pending and allow another voice attempt', async () => {
  const f = fixture();
  f.decide = async () => { throw new Error('timeout'); };
  await f.respond('응 그렇게 해줘', 'first');
  assert.deepEqual(f.answers, []);
  assert.match(f.notices.at(-1)!, /처리하지 못/);
  f.decide = async () => 'approve';
  await f.respond('그대로 해도 돼', 'first');
  assert.deepEqual(f.answers, [{ requestId: 'first', choice: 'once' }]);
});

test('trace explains unclear, stale, successful and duplicate confirmation routing', async () => {
  const f = fixture();
  const reasons: string[] = [];
  f.intent = 'unclear';
  await f.respond('글쎄', 'first', reason => reasons.push(reason));
  assert.deepEqual(reasons, ['confirmation_deciding', 'confirmation_unclear']);
  f.intent = 'reject';
  await f.respond('취소', 'first', reason => reasons.push(reason));
  assert.deepEqual(reasons.slice(-3), ['confirmation_deciding', 'confirmation_reject_requested', 'confirmation_reject_resolved']);
  await f.respond('취소', 'first', reason => reasons.push(reason));
  assert.equal(reasons.at(-1), 'confirmation_duplicate');
  f.target = null;
  await f.respond('취소', 'first', reason => reasons.push(reason));
  assert.equal(reasons.at(-1), 'confirmation_stale');
  assert.deepEqual(f.answers, [{ requestId: 'first', choice: 'deny' }]);
});
