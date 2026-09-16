/**
 * 채팅 메시지 첨부 파일 — 작업 공간 경로 정규화와 배지 모양.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileBadge, isImageFile, workspacePathOf } from '../src/renderer/src/views/attachment-model';

test('서버 이력의 버킷 접두사와 workspace/ 를 걷어 작업 공간 기준 경로로', () => {
  assert.equal(
    workspacePathOf('geny-workspace:uploads/users/1/conn-a/conn-b/보고서.pdf'),
    'uploads/users/1/conn-a/conn-b/보고서.pdf',
  );
  assert.equal(workspacePathOf('workspace/uploads/a.pdf'), 'uploads/a.pdf');
  assert.equal(workspacePathOf('/uploads/a.pdf'), 'uploads/a.pdf');
  assert.equal(workspacePathOf('uploads/a.pdf'), 'uploads/a.pdf');
});

test('비었거나 상위 폴더로 나가는 경로는 쓰지 않는다', () => {
  assert.equal(workspacePathOf(''), undefined);
  assert.equal(workspacePathOf(undefined), undefined);
  assert.equal(workspacePathOf('bucket:'), undefined);
  assert.equal(workspacePathOf('uploads/../../etc/passwd'), undefined);
});

test('그림 파일은 대화창에 바로 그린다', () => {
  for (const name of ['chart.png', 'photo.JPG', 'shot.jpeg', 'icon.svg', 'anim.gif', 'pic.webp']) {
    assert.equal(isImageFile(name), true, name);
  }
  for (const name of ['결과.xlsx', 'report.pdf', 'data.json', 'notes']) {
    assert.equal(isImageFile(name), false, name);
  }
  assert.equal(isImageFile('scan', 'image/png'), true);
});

test('확장자로 배지 글자와 색 계열을 정한다', () => {
  assert.deepEqual(fileBadge('위해상품_공표문_85개.pdf'), { label: 'PDF', tone: 'pdf' });
  assert.deepEqual(fileBadge('결과.XLSX'), { label: 'XLSX', tone: 'sheet' });
  assert.deepEqual(fileBadge('data.csv'), { label: 'CSV', tone: 'sheet' });
  assert.deepEqual(fileBadge('제안서.pptx'), { label: 'PPTX', tone: 'slide' });
  assert.deepEqual(fileBadge('archive.tar.gz'), { label: 'GZ', tone: 'archive' });
  assert.deepEqual(fileBadge('notes'), { label: 'FILE', tone: 'other' });
  assert.deepEqual(fileBadge('scan', 'application/pdf'), { label: 'PDF', tone: 'pdf' });
});
