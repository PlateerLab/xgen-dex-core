// IDE 화면이 그려지는가 — 서버 렌더(DOM 없이)로 뼈대·문구·접근성 이름을 본다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToString } from 'react-dom/server';
import { IdeView, IdeStore, ideActivityItems, pressIdeActivity } from '../src/index';
import type { IdeHost } from '../src/types';

const host: IdeHost = {
  workflowId: 'wf1',
  agentName: '분석 에이전트',
  session: async () => ({ readonly: false, terminals: [] }),
  listFiles: async () => [],
  readFile: async () => ({ bytes: new Uint8Array(), sha: '', size: 0 }),
  saveFile: async () => ({ sha: '' }),
  stat: async () => ({}),
  readRaw: async () => new Uint8Array(),
  fs: async () => undefined,
  search: async () => ({ files: [], total: 0, truncated: false }),
  replace: async () => ({ changed: [], skipped: [] }),
  git: async <T,>() => ({ repos: [] }) as T,
  terminals: async () => [],
  closeTerminal: async () => undefined,
  openTerminal: () => ({ send() {}, close() {} }),
  loadMonaco: async () => {
    throw new Error('테스트에서는 편집기를 띄우지 않는다');
  },
};

test('뼈대 — 활동 막대·탐색기·빈 편집기·채팅 자리, 하단 바는 없다', () => {
  const store = new IdeStore(host);
  const html = renderToString(<IdeView store={store} chat={<div id="chat-slot">채팅</div>} theme="dark" />);
  assert.match(html, /class="xide-root xide-theme-dark"/);
  assert.match(html, /aria-label="탐색기"/);
  assert.match(html, /분석 에이전트/);
  assert.match(html, /선택된 파일이 없습니다/);
  assert.match(html, /id="chat-slot"/);
  assert.match(html, /class="xide-activity"/);
  assert.doesNotMatch(html, /xide-status/, '하단 바(상태 표시줄)는 그리지 않는다');
  assert.doesNotMatch(html, /xide-connbar/, '연결 줄은 끊겼을 때만 뜬다');
  assert.doesNotMatch(html, /—/, '화면 문구에 줄표를 쓰지 않는다');
  store.dispose();
});

test('호스트가 활동 막대를 가져가면 IDE 안에는 그리지 않는다', () => {
  const store = new IdeStore(host);
  const html = renderToString(<IdeView store={store} chat={<div />} theme="light" activityBar={false} />);
  assert.doesNotMatch(html, /class="xide-activity"/);
  assert.match(html, /aria-label="탐색기"/, '사이드바 보기는 그대로 그린다');
  store.dispose();
});

test('활동 단추 — 보기·터미널·채팅, 누르면 보기를 접고 칸을 여닫는다', () => {
  const store = new IdeStore(host);
  let items = ideActivityItems(store.getState());
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.id}`),
    ['view:explorer', 'view:search', 'view:scm', 'toggle:terminal', 'toggle:chat'],
  );
  assert.equal(items.find((i) => i.id === 'explorer')?.active, true);
  assert.match(items.find((i) => i.id === 'search')!.title, /찾기 \(/, '단축키를 풍선 도움말에 붙인다');

  pressIdeActivity(store, { id: 'explorer', kind: 'view' });
  assert.equal(store.getState().layout.sideView, null, '열린 보기를 다시 누르면 접는다');
  pressIdeActivity(store, { id: 'scm', kind: 'view' });
  assert.equal(store.getState().layout.sideView, 'scm');

  const chatOpen = store.getState().layout.chatOpen;
  pressIdeActivity(store, { id: 'chat', kind: 'toggle' });
  assert.equal(store.getState().layout.chatOpen, !chatOpen);

  assert.equal(
    ideActivityItems(store.getState(), { chat: false }).some((i) => i.id === 'chat'),
    false,
    '채팅 칸이 없으면 채팅 단추도 없다',
  );
  store.dispose();
});

test('연결이 끊기면 편집기 위에 한 줄로 알리고, 다시 시도 단추를 준다', () => {
  const store = new IdeStore(host);
  (store as unknown as { set(p: object): void }).set({ connection: 'retrying', sessionError: '서버에 잠시 닿지 않습니다' });
  const html = renderToString(<IdeView store={store} chat={<div />} theme="light" />);
  assert.match(html, /class="xide-connbar xide--retrying"/);
  assert.match(html, /서버에 잠시 닿지 않습니다\. 스스로 다시 연결합니다/);
  assert.match(html, /지금 다시 시도/);
  store.dispose();
});

test('호스트가 알림을 가지면 그쪽으로만 보낸다 (IDE 토스트와 겹치지 않게)', () => {
  const got: string[] = [];
  const withNotify = new IdeStore({ ...host, notify: (kind, message) => got.push(`${kind}:${message}`) });
  withNotify.notify('success', '토큰을 등록했습니다');
  assert.deepEqual(got, ['success:토큰을 등록했습니다']);
  assert.equal(withNotify.getState().notice, null);
  withNotify.dispose();

  const own = new IdeStore(host);
  own.notify('error', '저장하지 못했습니다');
  assert.equal(own.getState().notice?.message, '저장하지 못했습니다');
  const html = renderToString(<IdeView store={own} chat={<div />} theme="light" />);
  assert.match(html, /class="xide-toast xide--error"/);
  own.dispose();
});

test('밝은 테마·채팅 닫힘·사이드바 찾기', () => {
  const store = new IdeStore(host);
  store.setLayout({ sideView: 'search', chatOpen: false });
  const html = renderToString(<IdeView store={store} chat={<div id="chat-slot" />} theme="light" />);
  assert.match(html, /xide-theme-light/);
  assert.match(html, /aria-label="찾기"/);
  assert.match(html, /aria-hidden="true"/, '닫힌 채팅은 남겨 두되 감춘다');
  store.dispose();
});

// ── 미리보기와 읽기 전용 탐색기 (2026-10-02) ─────────────────────────────

import { FileTree } from '../src/index';
import type { IdePreviewRequest } from '../src/types';

test('미리보기 탭 — 호스트의 렌더러가 그 자리를 그리고, 요청에 경로·이름·판이 실린다', async () => {
  const seen: IdePreviewRequest[] = [];
  const previewHost: IdeHost = {
    ...host,
    listFiles: async () => [{ path: 'docs/보고서.docx', isDir: false, size: 10, modifiedAt: 't1' }],
    preview: {
      mode: (p) => (p.endsWith('.docx') ? 'view' : null),
      render: (req) => {
        seen.push(req);
        return <div id="host-preview">{req.name}</div>;
      },
    },
  };
  const store = new IdeStore(previewHost);
  await store.start();
  await store.openFile('docs/보고서.docx', { preview: false });
  const html = renderToString(<IdeView store={store} chat={<div />} theme="light" />);
  assert.match(html, /id="host-preview"/);
  assert.match(html, /class="xide-preview-pane"/);
  assert.equal(seen[0]?.path, 'docs/보고서.docx');
  assert.equal(seen[0]?.name, '보고서.docx');
  assert.equal(seen[0]?.local, false);
  assert.equal(seen[0]?.version, 't1');
  store.dispose();
});

test('읽기 전용 탐색기 — IDE 탐색기와 같은 마크업(클래스·아이콘·줄)이다', () => {
  const html = renderToString(
    <FileTree
      rootName="카톡분석"
      entries={[
        { path: 'uploads', isDir: true },
        { path: 'uploads/a.png', isDir: false, size: 10 },
        { path: '리포트.docx', isDir: false, size: 45666 },
        { path: '리포트.md', isDir: false, size: 17674 },
      ]}
      activePath="리포트.docx"
      onOpen={() => undefined}
      theme="dark"
    />,
  );
  assert.match(html, /class="xide-root xide-theme-dark xide-filetree"/);
  assert.match(html, /class="xide-side-view xide-explorer"/);
  assert.match(html, /class="xide-section-title">카톡분석</);
  assert.match(html, /class="xide-tree-row[^"]*xide--active[^"]*"[^>]*data-path="리포트.docx"/);
  assert.match(html, /xide-file-badge/, '확장자 배지 아이콘');
  assert.doesNotMatch(html, /data-path="uploads\/a.png"/, '접힌 폴더의 파일은 그리지 않는다');
  assert.doesNotMatch(html, /—/, '화면 문구에 줄표를 쓰지 않는다');
});

test('md·csv 의 미리보기/편집 전환은 탭 줄의 동작 칸에 있다(편집기 위에 떠 있지 않다)', async () => {
  const toggleHost: IdeHost = {
    ...host,
    listFiles: async () => [{ path: 'titanic.csv', isDir: false, size: 10, modifiedAt: 't1' }],
    preview: { mode: (p) => (p.endsWith('.csv') ? 'toggle' : null), render: () => <div id="csv-table" /> },
  };
  const store = new IdeStore(toggleHost);
  await store.start();
  await store.openFile('titanic.csv', { preview: false }).catch(() => undefined);
  // 테스트에는 Monaco 가 없다 — 문서가 열린 상태만 세운다.
  (store as unknown as { patchDoc(path: string, patch: Record<string, unknown>): void }).patchDoc('titanic.csv', {
    status: 'ready', path: 'titanic.csv',
  });
  let html = renderToString(<IdeView store={store} chat={<div />} theme="dark" />);
  assert.match(html, /class="xide-tabbar-actions"><div class="xide-view-switch" role="group" aria-label="보기">/);
  assert.match(html, /aria-pressed="true"[^>]*title="그린 모습으로 보기"/);
  assert.match(html, /id="csv-table"/);
  assert.doesNotMatch(html, /xide-view-toggle/, '편집기 위에 떠 있는 전환은 없다');
  store.setRendered('titanic.csv', false);
  html = renderToString(<IdeView store={store} chat={<div />} theme="dark" />);
  assert.match(html, /aria-pressed="true"[^>]*title="편집기로 고치기"/);
  assert.doesNotMatch(html, /id="csv-table"/);
  store.dispose();
});
