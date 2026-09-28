// IDE 화면이 그려지는가 — 서버 렌더(DOM 없이)로 뼈대·문구·접근성 이름을 본다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToString } from 'react-dom/server';
import { IdeView, IdeStore } from '../src/index';
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

test('뼈대 — 활동 막대·탐색기·빈 편집기·채팅 자리·상태 표시줄', () => {
  const store = new IdeStore(host);
  const html = renderToString(<IdeView store={store} chat={<div id="chat-slot">채팅</div>} theme="dark" />);
  assert.match(html, /class="xide-root xide-theme-dark"/);
  assert.match(html, /aria-label="탐색기"/);
  assert.match(html, /분석 에이전트/);
  assert.match(html, /선택된 파일이 없습니다/);
  assert.match(html, /id="chat-slot"/);
  assert.match(html, /class="xide-status/);
  assert.doesNotMatch(html, /—/, '화면 문구에 줄표를 쓰지 않는다');
  store.dispose();
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
