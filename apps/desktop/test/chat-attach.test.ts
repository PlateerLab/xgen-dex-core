/** 작성기 첨부 규칙: 대화 화면과 시작 화면이 같은 검사(크기·개수·합계)를 쓴다. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_TOTAL_BYTES,
  TOO_LARGE_TOTAL,
  TOO_MANY_FILES,
  pastedImageFiles,
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
  const half = Math.floor(CHAT_IMAGE_MAX_TOTAL_BYTES / 2);
  const h = harness();
  const problem = await stageChatFiles(
    [fakeFile('a.mp4', Math.min(half, CHAT_IMAGE_MAX_BYTES)), fakeFile('b.mp4', CHAT_IMAGE_MAX_BYTES), fakeFile('c.mp4', CHAT_IMAGE_MAX_BYTES)],
    h.used,
    h.add,
    h.prepare,
  );
  assert.equal(problem, TOO_LARGE_TOTAL);
  assert.deepEqual(h.staged.map((image) => image.name), ['a.mp4', 'b.mp4']);
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

test('붙여넣기는 그림 파일만 받는다(글 붙이기는 그대로 둔다)', () => {
  const png = fakeFile('shot.png', 4, 'image/png');
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'application/pdf', getAsFile: () => fakeFile('a.pdf', 1) },
    { kind: 'file', type: 'IMAGE/PNG', getAsFile: () => png },
  ] as unknown as DataTransferItem[];
  assert.deepEqual(pastedImageFiles(items), [png]);
  assert.deepEqual(pastedImageFiles([items[0]]), []);
});
