import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameElements, frameLine, runFrameCommand, snapshotFrames } from '../src/main/browser-frames';

// 10/20 네이버 메일쓰기 본문 iframe 의 접근성 트리(줄임).
const naverBody = [
  { role: { value: 'RootWebArea' }, name: { value: '' }, properties: [{ name: 'focusable', value: { value: true } }], backendDOMNodeId: 1 },
  { role: { value: 'generic' }, name: { value: '본문 내용' }, properties: [{ name: 'focusable', value: { value: true } }, { name: 'editable', value: { value: 'richtext' } }], backendDOMNodeId: 2 },
  { role: { value: 'paragraph' }, properties: [{ name: 'editable', value: { value: 'richtext' } }], backendDOMNodeId: 3 },
  { role: { value: 'button' }, name: { value: '표 삽입' }, ignored: true, backendDOMNodeId: 4 },
  // agent-browser 가 이미 싣는 요소 — 입력칸(편집 가능·초점 가능이지만 역할이 있다)과 버튼.
  { role: { value: 'textbox' }, name: { value: '표 제목' }, properties: [{ name: 'focusable', value: { value: true } }, { name: 'editable', value: { value: 'plaintext' } }], backendDOMNodeId: 5 },
  { role: { value: 'button' }, name: { value: '굵게' }, properties: [{ name: 'focusable', value: { value: true } }], backendDOMNodeId: 6 },
];

test('frameElements keeps only the editor root — agent-browser already lists inputs and buttons inside iframes', () => {
  assert.deepEqual(frameElements(naverBody), [{ backendNodeId: 2, name: '본문 내용' }]);
});

test('frameLine matches agent-browser snapshot lines', () => {
  assert.equal(frameLine({ backendNodeId: 2, name: '본문 내용' }, 'e151', '안녕\n하세요'), '- textbox "본문 내용" [ref=e151]: 안녕 하세요');
  assert.equal(frameLine({ backendNodeId: 2, name: '' }, 'e152', null), '- textbox [ref=e152]');
});

test('snapshotFrames numbers elements after the given ref and reads editor text', async () => {
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'body' } }] } };
    if (method === 'Accessibility.getFullAXTree') return { nodes: params?.frameId === 'body' ? naverBody : [] };
    if (method === 'DOM.resolveNode') return { object: { objectId: `o${params?.backendNodeId}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: '안녕' } };
    throw new Error(method);
  };
  const got = await snapshotFrames(send, 151);
  assert.deepEqual(got.lines, ['- textbox "본문 내용" [ref=e151]: 안녕']);
  assert.deepEqual([...got.targets], [['e151', 2]]);
});

test('runFrameCommand fill inserts in the page and falls back to keyboard input only when the page refuses', async () => {
  const run = async (accepted: boolean) => {
    const calls: string[] = [];
    const send = async (method: string, params?: Record<string, unknown>) => {
      calls.push(method === 'Runtime.callFunctionOn' ? `${method}:${JSON.stringify(params?.arguments)}` : method);
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } };
      return method === 'Runtime.callFunctionOn' ? { result: { value: accepted } } : {};
    };
    assert.deepEqual(await runFrameCommand(send, 2, ['fill', '@e151', '안녕']), { success: true, data: { filled: '@e151' } });
    return calls;
  };
  assert.deepEqual(await run(true), ['DOM.focus', 'DOM.resolveNode', 'Runtime.callFunctionOn:[{"value":true},{"value":"안녕"}]']);
  assert.equal((await run(false)).at(-1), 'Input.insertText');
  assert.equal(await runFrameCommand(async () => ({}), 2, ['hover', '@e151']), null);
});

test('runFrameCommand click refuses a covered target with the agent-browser wording and sends no mouse event', async () => {
  const calls: string[] = [];
  const send = async (method: string) => {
    calls.push(method);
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } };
    return method === 'Runtime.callFunctionOn' ? { result: { value: '<div#cover>' } } : {};
  };
  await assert.rejects(runFrameCommand(send, 5, ['click', '@e152']), /Element @e152 is covered by <div#cover>/);
  assert.ok(!calls.includes('Input.dispatchMouseEvent'));
});
