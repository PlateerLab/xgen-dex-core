import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ElementRefs } from '../src/main/fast-act';
import { accepts, fileNameIn, listFiles, namesFile, uploadLanded, withFileFields, type FileField } from '../src/main/fast-act-upload';

const field = (n: number, label: string, over: Partial<FileField> = {}): FileField => ({
  n,
  label,
  accept: '',
  visible: false,
  files: [],
  imgs: [],
  text: '',
  ...over,
});
const BO = [field(0, '대표이미지'), field(1, '동영상'), field(2, '추가이미지')];

test('fileNameIn: 말에 든 파일 이름, 뒤 조사는 뺀다', () => {
  assert.equal(fileNameIn('대표이미지를 INNO-20261016-001_대표이미지.png로 업로드해줘'), 'INNO-20261016-001_대표이미지.png');
  assert.equal(fileNameIn('"a.JPG" 올려줘'), 'a.JPG');
  assert.equal(fileNameIn('대표이미지에 상품이미지/a.png를 올려줘'), '상품이미지/a.png');
  assert.equal(fileNameIn('대표이미지 올려줘'), null);
  assert.equal(fileNameIn('버전 1.5로 바꿔줘'), null);
});

test('namesFile: 이름만 또는 연결 폴더 안 경로로', () => {
  const p = '/Users/x/신제품/상품이미지/INNO-001_대표이미지.png';
  assert.ok(namesFile(p, 'INNO-001_대표이미지.png'));
  assert.ok(namesFile(p, '상품이미지/INNO-001_대표이미지.png'));
  assert.ok(!namesFile(p, '다른폴더/INNO-001_대표이미지.png'));
  assert.ok(!namesFile(p, '001_대표이미지.png'));
});

test('uploadLanded: 미리보기·파일 이름·보이는 칸만 올라간 것으로 본다', () => {
  const before = field(0, '대표이미지', { text: '업로드할 파일을 드래그 하거나 선택해 주세요' });
  assert.equal(uploadLanded(before, { ...before, imgs: ['blob:x'] }, 'a.png'), 'preview');
  assert.equal(uploadLanded(before, { ...before, text: 'a.png (1.2MB) 삭제' }, 'a.png'), 'name');
  assert.equal(uploadLanded(field(0, '첨부', { visible: true }), field(0, '첨부', { visible: true, files: ['a.png'] }), 'a.png'), 'picked');
  // 숨은 칸에 파일만 들어가고 화면이 그대로면 올라간 것이 아니다(10/19 BO).
  assert.equal(uploadLanded(before, { ...before, files: ['a.png'] }, 'a.png'), null);
  assert.equal(uploadLanded(before, { ...before, text: '파일 형식이 올바르지 않습니다' }, 'a.png'), null);
});

test('listFiles: 하위 폴더까지, 숨은 폴더는 빼고', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upload-'));
  mkdirSync(join(root, '상품이미지'));
  mkdirSync(join(root, '.cache'));
  writeFileSync(join(root, '상품이미지', 'a.png'), '');
  writeFileSync(join(root, '.cache', 'a.png'), '');
  assert.deepEqual(await listFiles([root]), [join(root, '상품이미지', 'a.png')]);
});

test('accepts: accept 꼴마다', () => {
  assert.ok(accepts('image/png,image/jpg,image/jpeg,image/gif', '/x/a.JPEG'));
  assert.ok(!accepts('image/png,image/jpg', '/x/a.pdf'));
  assert.ok(accepts('image/*', '/x/a.webp'));
  assert.ok(accepts('.pdf', '/x/a.pdf'));
  assert.ok(accepts('', '/x/a.xlsx'));
});

test('withFileFields: 파일 칸을 같은 이름 제목 바로 뒤에 입력칸 줄로 넣는다', () => {
  const refs = {
    e94: { role: 'heading', name: '대표이미지 *' },
    e146: { role: 'generic', name: '' },
    e95: { role: 'heading', name: '동영상' },
    e96: { role: 'heading', name: 'SEO 정보' },
  } as ElementRefs;
  const { refs: out, files } = withFileFields(refs, [field(0, '대표이미지'), field(1, '동영상'), field(2, '')]);
  assert.deepEqual(Object.keys(out), ['e94', 'e8001', 'e146', 'e95', 'e8002', 'e96', 'e8003']);
  assert.deepEqual(out.e8001, { role: 'textbox', name: '대표이미지 파일 올리기' });
  assert.equal(out.e8003.name, '파일 올리기');
  assert.equal(files.e8002.n, 1);
  assert.deepEqual(withFileFields(refs, []).refs, refs);
});
