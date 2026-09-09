import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanMemoryText,
  filterMemoryFiles,
  memoryPreview,
  memoryTitle,
} from '../src/renderer/src/views/agent-memory-model';

test('complete and truncated internal envelopes do not become note titles', () => {
  assert.equal(
    memoryTitle({
      filename: 'a.md',
      title:
        'Execution #21 — <xgen_browser_context>{"version":1}</xgen_browser_context> 페이지 확인',
    }),
    'Execution #21 — 페이지 확인',
  );
  assert.equal(
    memoryTitle({
      filename: 'a.md',
      title: 'Execution #19 — <xgen_browser_context>{"version":1… · cancelled',
    }),
    'Execution #19',
  );
  assert.equal(
    memoryTitle({ filename: 'a.md', title: '대화: <xgen_teams_context>{"room":…' }),
    '대화 기록',
  );
  assert.equal(
    memoryTitle({ filename: 'a.md', title: 'XML <element> 설명' }),
    'XML <element> 설명',
  );
  assert.equal(memoryTitle({ filename: 'notes/회의록.md' }), '회의록');
});

test('display cleanup keeps the user request and leaves the source intact', () => {
  const source =
    '<xgen_teams_context>{"room":1}</xgen_teams_context>\n<xgen_browser_context>{"pages":[]}</xgen_browser_context>\n확인해줘';
  assert.equal(cleanMemoryText(source), '확인해줘');
  assert.ok(source.includes('"room":1'));
  assert.equal(
    memoryPreview('> Task: 로컬 쉘 확인\n> Duration: 4s · Session: private-id\n> Model: example'),
    '로컬 쉘 확인',
  );
  assert.equal(memoryPreview('> Task: <xgen_browser_context>{"version":1…'), '');
  assert.equal(
    memoryPreview('> **Task:** 로컬 쉘 확인\n> **Duration:** 4s · Session: private-id\n> **Model:** example'),
    '로컬 쉘 확인',
  );
});

test('search, category and tag combine; sorting does not mutate the server list', () => {
  const files = [
    {
      filename: 'a.md',
      title: '배포 기록',
      category: 'daily',
      tags: ['success'],
      modified: '2026-09-02T00:00:00Z',
    },
    {
      filename: 'b.md',
      title: '배포 기록 2',
      category: 'daily',
      tags: ['success'],
      modified: '2026-09-09T00:00:00Z',
    },
    { filename: 'c.md', title: '배포 기록 3', category: 'conversations', tags: ['success'] },
    {
      filename: 'd.md',
      title: '실패',
      category: 'daily',
      tags: ['failure'],
      first_paragraph: '배포 오류',
      modified: 'invalid',
    },
  ];
  assert.deepEqual(
    filterMemoryFiles(files, {
      query: ' 배포 ',
      category: 'daily',
      tag: 'success',
      sort: 'recent',
    }).map((file) => file.filename),
    ['b.md', 'a.md'],
  );
  assert.deepEqual(
    filterMemoryFiles(files, { query: '배포', category: 'daily', tag: '', sort: 'oldest' }).map(
      (file) => file.filename,
    ),
    ['a.md', 'b.md', 'd.md'],
  );
  assert.deepEqual(
    files.map((file) => file.filename),
    ['a.md', 'b.md', 'c.md', 'd.md'],
  );
  assert.equal(
    filterMemoryFiles(files, { query: '없는 단어', category: '', tag: '', sort: 'title' }).length,
    0,
  );
});

test('internal context is excluded from preview search and missing category maps to general', () => {
  const files = [
    {
      filename: 'a.md',
      title: '<xgen_browser_context>{"secret":1…',
      first_paragraph: '<xgen_browser_context>secret</xgen_browser_context>요청',
    },
  ];
  assert.equal(
    filterMemoryFiles(files, { query: 'secret', category: '', tag: '', sort: 'recent' }).length,
    0,
  );
  assert.equal(
    filterMemoryFiles(files, { query: '요청', category: 'root', tag: '', sort: 'recent' }).length,
    1,
  );
});
