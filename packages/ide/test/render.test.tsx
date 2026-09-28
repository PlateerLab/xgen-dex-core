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
