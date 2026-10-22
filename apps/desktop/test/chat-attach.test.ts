/** 작성기 첨부 규칙: 대화 화면과 시작 화면이 같은 검사(크기·개수·합계)를 쓴다. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_TOTAL_BYTES,
  TOO_LARGE_TOTAL,
  TOO_MANY_FILES,
  CHAT_MEMORY_MAX_BYTES,
  ownsDocumentPaste,
  pastedFiles,
  type ClipboardLike,
  type PasteNode,
  prepareChatImage,
  stageChatFiles,
  type StagedChatImage,
} from '../src/renderer/src/views/chat-attach';

const fakeFile = (name: string, size: number, type = 'application/pdf') => ({ name, size, type }) as unknown as File;

function harness(start: StagedChatImage[] = []) {
  const staged = [...start];
  return {
    staged,
    used: () => ({ count: staged.length, bytes: staged.reduce((sum, image) => sum + image.size, 0) }),
    add: (image: StagedChatImage) => staged.push(image),
    prepare: async (file: File): Promise<StagedChatImage> => ({
      id: file.name,
      dataUrl: 'data:application/pdf;base64,AA==',
      name: file.name,
      mime: file.type,
      size: file.size,
      kind: 'file',
    }),
  };
}

test('여러 파일을 차례로 올린다', async () => {
  const h = harness();
  const problem = await stageChatFiles([fakeFile('a.pdf', 10), fakeFile('b.xlsx', 20)], h.used, h.add, h.prepare);
  assert.equal(problem, null);
  assert.deepEqual(h.staged.map((image) => image.name), ['a.pdf', 'b.xlsx']);
});

test('빈 파일·너무 큰 파일은 건너뛰고 나머지는 올린다', async () => {
  const h = harness();
  const problem = await stageChatFiles(
    [fakeFile('empty.txt', 0), fakeFile('huge.zip', CHAT_IMAGE_MAX_BYTES + 1), fakeFile('ok.pdf', 5)],
    h.used,
    h.add,
    h.prepare,
  );
  assert.match(problem ?? '', /empty\.txt: 빈 파일/);
  assert.deepEqual(h.staged.map((image) => image.name), ['ok.pdf']);
});

test('개수는 이미 올려 둔 것까지 세어 최대에서 멈춘다', async () => {
  const h = harness();
  const files = Array.from({ length: CHAT_IMAGE_MAX_COUNT + 2 }, (_, i) => fakeFile(`f${i}.pdf`, 1));
  const problem = await stageChatFiles(files, h.used, h.add, h.prepare);
  assert.equal(problem, TOO_MANY_FILES);
  assert.equal(h.staged.length, CHAT_IMAGE_MAX_COUNT);
});

test('합계가 넘으면 그 파일부터 멈춘다', async () => {
  const fit = Math.floor(CHAT_IMAGE_MAX_TOTAL_BYTES / CHAT_IMAGE_MAX_BYTES);
  const h = harness();
  const files = Array.from({ length: fit + 2 }, (_, i) => fakeFile(`v${i}.mp4`, CHAT_IMAGE_MAX_BYTES));
  const problem = await stageChatFiles(files, h.used, h.add, h.prepare);
  assert.equal(problem, TOO_LARGE_TOTAL);
  assert.equal(h.staged.length, fit);
});

test('파일 한 개는 1GiB(동영상)까지, 넘으면 이유를 알린다', async () => {
  assert.equal(CHAT_IMAGE_MAX_BYTES, 1024 * 1024 * 1024);
  const h = harness();
  const problem = await stageChatFiles(
    [fakeFile('ok.mp4', CHAT_IMAGE_MAX_BYTES, 'video/mp4'), fakeFile('over.mp4', CHAT_IMAGE_MAX_BYTES + 1, 'video/mp4')],
    h.used,
    h.add,
    h.prepare,
  );
  assert.match(problem ?? '', /over\.mp4: 파일 한 개는 1GiB/);
  assert.deepEqual(h.staged.map((image) => image.name), ['ok.mp4']);
});

test('디스크의 큰 파일은 데이터 URL 없이 표만 든다 — 디스크 경로가 없으면 100MiB 까지만', async () => {
  const video = fakeFile('회의.mp4', 500 * 1024 * 1024, 'video/mp4');
  const staged = await prepareChatImage(video, () => 'file-7');
  assert.equal(staged.fileRef, 'file-7');
  assert.equal(staged.dataUrl, '');
  assert.equal(staged.kind, 'file');
  assert.equal(staged.size, video.size);
  await assert.rejects(prepareChatImage(fakeFile('붙여넣음.bin', CHAT_MEMORY_MAX_BYTES + 1), () => null), /100MiB/);
});

test('읽기에 실패한 파일은 알리고 다음 파일로 간다', async () => {
  const h = harness();
  const problem = await stageChatFiles(
    [fakeFile('bad.png', 3, 'image/png'), fakeFile('ok.pdf', 3)],
    h.used,
    h.add,
    async (file) => {
      if (file.name === 'bad.png') throw new Error('지원하지 않거나 손상된 이미지입니다.');
      return h.prepare(file);
    },
  );
  assert.equal(problem, '지원하지 않거나 손상된 이미지입니다.');
  assert.deepEqual(h.staged.map((image) => image.name), ['ok.pdf']);
});

// ── 붙여넣기 (웹 채팅 입력창과 같은 규칙) ──────────────────────────────────────────

const NOW = new Date(2026, 9, 22, 14, 3, 21);
const realPng = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

function clip(files: File[], text = '', viaItems = false): ClipboardLike {
  return {
    files: viaItems ? [] : files,
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    getData: (format: string) => (format === 'text/plain' ? text : ''),
  };
}

test('붙여넣기: 화면 캡처는 붙여 넣은 시각의 이름으로, 여러 장이면 번호가 붙는다', () => {
  assert.deepEqual(pastedFiles(clip([realPng()]), NOW).map((f) => f.name), ['붙여넣은 이미지 2026-10-22 14.03.21.png']);
  assert.deepEqual(pastedFiles(clip([realPng(), realPng()], '', true), NOW).map((f) => f.name), [
    '붙여넣은 이미지 2026-10-22 14.03.21 (1).png',
    '붙여넣은 이미지 2026-10-22 14.03.21 (2).png',
  ]);
});

test('붙여넣기: 엑셀 셀처럼 글과 그 그림이 함께 오면 글을 붙인다, 글만이면 첨부 없음', () => {
  assert.deepEqual(pastedFiles(clip([realPng()], '매출\t2026\n1월\t120'), NOW), []);
  assert.deepEqual(pastedFiles(clip([], '안녕하세요'), NOW), []);
  assert.deepEqual(pastedFiles(null), []);
});

test('붙여넣기: 탐색기에서 복사한 문서도 제 이름으로 받는다(함께 온 글이 이름·경로뿐)', () => {
  const report = new File(['x'], '보고서.pdf', { type: 'application/pdf' });
  assert.deepEqual(pastedFiles(clip([report], '보고서.pdf'), NOW).map((f) => f.name), ['보고서.pdf']);
  assert.equal(pastedFiles(clip([report, realPng('a.png')], '/Users/u/보고서.pdf\n/Users/u/a.png'), NOW).length, 2);
  assert.equal(pastedFiles(clip([realPng()], 'https://example.com/a.png'), NOW).length, 1);
  assert.equal(pastedFiles(clip([realPng()], 'image.png'), NOW)[0].name, 'image.png');
});

// 요소 흉내: 부모 사슬과 속성만 있다.
class FakeNode implements PasteNode {
  isConnected = true;
  offsetParent: unknown = {};
  isContentEditable = false;
  constructor(readonly tagName: string, readonly parent: FakeNode | null, readonly attrs: Record<string, string> = {}) {}
  closest(selector: string): FakeNode | null {
    const wants = selector.includes('data-paste-root')
      ? (n: FakeNode) => 'data-paste-root' in n.attrs
      : (n: FakeNode) => n.attrs.role === 'dialog' || n.attrs['aria-modal'] === 'true';
    for (let n: FakeNode | null = this; n; n = n.parent) if (wants(n)) return n;
    return null;
  }
  contains(other: unknown): boolean {
    for (let n = other as FakeNode | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

function page() {
  const body = new FakeNode('BODY', null);
  const left = new FakeNode('DIV', body, { 'data-paste-root': '' });
  const leftInput = new FakeNode('TEXTAREA', left);
  const leftSend = new FakeNode('BUTTON', left);
  const leftMessage = new FakeNode('DIV', left);
  const right = new FakeNode('DIV', body, { 'data-paste-root': '' });
  const rightInput = new FakeNode('TEXTAREA', right);
  const sidebar = new FakeNode('BUTTON', body);
  const nameField = new FakeNode('INPUT', left);
  const dialog = new FakeNode('DIV', body, { role: 'dialog' });
  const dialogButton = new FakeNode('BUTTON', dialog);
  return { body, leftInput, leftSend, leftMessage, rightInput, sidebar, nameField, dialogButton };
}

test('포커스 없는 붙여넣기: 단추에 포커스가 있으면 그 단추가 든 대화가 받는다', () => {
  const p = page();
  const none = { pointer: null, input: null };
  assert.equal(ownsDocumentPaste(p.leftSend, p.leftInput, none), true);
  assert.equal(ownsDocumentPaste(p.leftSend, p.rightInput, none), false, '나눠 본 옆 대화는 가져가지 않는다');
});

test('포커스 없는 붙여넣기: 아무것도 포커스되지 않았으면 마지막으로 누른 곳, 없으면 마지막으로 쓴 입력창의 대화', () => {
  const p = page();
  assert.equal(ownsDocumentPaste(p.body, p.leftInput, { pointer: p.leftMessage, input: p.rightInput }), true);
  assert.equal(ownsDocumentPaste(p.body, p.rightInput, { pointer: p.leftMessage, input: p.rightInput }), false);
  assert.equal(ownsDocumentPaste(p.body, p.rightInput, { pointer: null, input: p.rightInput }), true);
  assert.equal(ownsDocumentPaste(null, p.leftInput, { pointer: null, input: null }), true, '처음 붙여넣기는 보이는 입력창이 받는다');
});

test('포커스 없는 붙여넣기: 다른 입력칸·대화 상자·대화 밖에서는 받지 않는다, 숨은 입력창도', () => {
  const p = page();
  const none = { pointer: null, input: null };
  assert.equal(ownsDocumentPaste(p.nameField, p.leftInput, none), false);
  assert.equal(ownsDocumentPaste(p.dialogButton, p.leftInput, none), false);
  assert.equal(ownsDocumentPaste(p.sidebar, p.leftInput, none), false);
  assert.equal(ownsDocumentPaste(p.body, p.leftInput, { pointer: p.sidebar, input: null }), false, '사이드바를 누른 뒤');
  p.leftInput.offsetParent = null;
  assert.equal(ownsDocumentPaste(p.leftSend, p.leftInput, none), false);
});
