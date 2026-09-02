// 파일 뷰어 순수 모델 — 종류 판정·텍스트 판별·CSV 파서·강조 줄 분할.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeText,
  escapeHtml,
  extOf,
  fileTabId,
  formatBytes,
  kindForFile,
  langForFile,
  looksBinary,
  parseCsv,
  splitHighlightedLines,
} from '../src/renderer/src/views/file-viewer-model';

test('extOf — 확장자·dot 파일·특수 이름', () => {
  assert.equal(extOf('a/b/report.PDF'), 'pdf');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf('Makefile'), 'makefile');
  assert.equal(extOf('Dockerfile'), 'dockerfile');
  assert.equal(extOf('noext'), '');
});

test('kindForFile — 뷰어 종류 판정', () => {
  assert.equal(kindForFile('hynix_stock.py'), 'code');
  assert.equal(kindForFile('kra_data.md'), 'markdown');
  assert.equal(kindForFile('photo.JPG'), 'image');
  assert.equal(kindForFile('doc.pdf'), 'pdf');
  assert.equal(kindForFile('song.mp3'), 'audio');
  assert.equal(kindForFile('clip.mp4'), 'video');
  assert.equal(kindForFile('data.csv'), 'csv');
  assert.equal(kindForFile('발표.pptx'), 'office');
  assert.equal(kindForFile('한글.hwp'), 'office');
  assert.equal(kindForFile('archive.zip'), 'binary');
  // 미지의 확장자는 binary — 내용이 텍스트면 뷰어가 code 로 승격한다.
  assert.equal(kindForFile('weird.xyz'), 'binary');
});

test('langForFile — 구문 강조 언어', () => {
  assert.equal(langForFile('app.tsx'), 'typescript');
  assert.equal(langForFile('run.sh'), 'bash');
  assert.equal(langForFile('style.SCSS'), 'scss');
  assert.equal(langForFile('unknown.xyz'), 'plaintext');
});

test('looksBinary / decodeText — NUL 스니핑과 BOM 제거', () => {
  assert.equal(looksBinary(new TextEncoder().encode('plain text\n한글')), false);
  assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('abc')]);
  assert.equal(decodeText(bom), 'abc');
});

test('parseCsv — 따옴표·이스케이프·따옴표 안 개행·CRLF', () => {
  const { rows } = parseCsv('a,b,c\r\n"x,1","say ""hi""","multi\nline"\r\n', ',');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x,1', 'say "hi"', 'multi\nline'],
  ]);
});

test('parseCsv — 행 상한에서 끊고 잘림을 알린다', () => {
  const text = Array.from({ length: 10 }, (_, i) => `r${i}`).join('\n');
  const { rows, truncated } = parseCsv(text, ',', 4);
  assert.equal(rows.length, 4);
  assert.equal(truncated, true);
});

test('splitHighlightedLines — 줄 경계를 넘는 span 을 닫고 다시 연다', () => {
  const html = '<span class="hljs-string">line1\nline2</span>\nplain';
  const lines = splitHighlightedLines(html);
  assert.deepEqual(lines, [
    '<span class="hljs-string">line1</span>',
    '<span class="hljs-string">line2</span>',
    'plain',
  ]);
});

test('splitHighlightedLines — 중첩 span 유지', () => {
  const html = '<span class="a">x<span class="b">y\nz</span></span>';
  const lines = splitHighlightedLines(html);
  assert.equal(lines[0], '<span class="a">x<span class="b">y</span></span>');
  assert.equal(lines[1], '<span class="a"><span class="b">z</span></span>');
});

test('escapeHtml / formatBytes / fileTabId', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(formatBytes(2867), '2.8KB');
  assert.equal(fileTabId('wf1', 'tools/a.py'), 'file:wf1:tools/a.py');
});
