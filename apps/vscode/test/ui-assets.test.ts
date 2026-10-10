import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('chat webview script is valid, IME-aware, and avoids HTML injection', async () => {
  const script = await readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8');
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /compositionstart/);
  assert.match(script, /event\.isComposing/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /openConversation/);
  assert.match(script, /startSend/);
  assert.match(script, /showSettings/);
  assert.match(script, /useProfile/);
  assert.match(script, /configureLocalTools/);
  // 작업 영역 폴더가 대화의 작업 공간 — 옛 로컬 컨트롤 입력(작업 폴더·허용 범위)은 없다.
  assert.match(script, /localToolsFolders/);
  assert.match(script, /workspaceFolders/);
  assert.doesNotMatch(script, /useWorkspaceRoot|localToolsEnabled|localToolsRoots/);
});

test('chat styles use VS Code theme tokens and reduced-motion fallback', async () => {
  const styles = await readFile(path.join(extensionRoot, 'media', 'chat.css'), 'utf8');
  assert.match(styles, /--vscode-foreground/);
  assert.match(styles, /--vscode-focusBorder/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /\.conversation-list/);
  assert.match(styles, /\.start-control/);
  assert.match(styles, /\.settings-screen/);
  assert.match(styles, /\.local-tools-card/);
  assert.match(styles, /\.switch-control/);
});

test('extension contributes one unified workspace webview', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8')) as {
    contributes: { views: { xgenDex: Array<{ id: string; type?: string }> } };
  };
  assert.deepEqual(manifest.contributes.views.xgenDex, [
    { id: 'xgenDex.chat', name: 'Workspace', type: 'webview', icon: 'resources/xgen-dex.svg' },
  ]);
});

test('workspace provider loads authentication, profiles, agents, and local tools into the webview state', async () => {
  const provider = await readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8');
  assert.match(provider, /'profile\/list'/);
  assert.match(provider, /'auth\/status'/);
  assert.match(provider, /'agents\/list'/);
  assert.match(provider, /'localTools\/status'/);
  assert.match(provider, /'localTools\/configure'/);
  assert.match(provider, /'localTools\/start'/);
  assert.match(provider, /screen: this\.screen/);
});

test('every webview element referenced by the client script exists in the provider markup', async () => {
  const [script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  const referencedIds = [...script.matchAll(/byId\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(referencedIds.length > 30);
  for (const id of referencedIds) assert.match(provider, new RegExp(`id=["']${id}["']`), `missing markup id: ${id}`);
});

test('대화 목록과 헤더는 한 화면에 많이 들어와야 한다', async () => {
  // 사이드바에서 한 줄이 여러 줄을 먹으면 목록을 훑을 수가 없다. 예전 Agent 카드는 장식
  // 아이콘·없는 설명 자리·"대화 시작 →" 안내로 154px 를 썼다. 대화 한 줄은 작은 에이전트
  // 이름과 제목 두 줄뿐이다.
  const [styles, script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.css'), 'utf8'),
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  const ruleOf = (selector: string): string => {
    const at = styles.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing rule: ${selector}`);
    return styles.slice(at, styles.indexOf('}', at));
  };
  assert.doesNotMatch(ruleOf('.conversation-row'), /min-height/, '줄 높이를 고정하면 내용과 무관하게 자리를 먹는다');
  assert.match(ruleOf('.conversation-title'), /text-overflow:\s*ellipsis/, '긴 제목은 한 줄에서 말줄임');

  // 주석은 무엇을 왜 없앴는지 적어 두는 자리라 그 문구가 남아 있다. 코드만 본다.
  const code = (source: string): string => source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.doesNotMatch(code(script), /agent-card|agent-grid/, 'Agent 카드 격자는 대화 목록으로 바뀌었다');
  assert.doesNotMatch(code(script), /대화 시작 →/);
  assert.doesNotMatch(code(script), /등록된 설명이 없습니다/, '없는 설명으로 한 줄을 채우지 않는다');

  assert.doesNotMatch(code(provider), /agent-avatar/, '채팅 헤더의 장식 아바타는 대화창을 밀어낸다');
  assert.doesNotMatch(code(provider), /ACTIVE AGENT/, '이름 위의 머리글은 한 줄을 더 먹는다');
});

test('첫 화면은 대화 목록, [+ 새 채팅] 은 시작 화면이다', async () => {
  const [script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  // 대화 목록은 엔진 RPC 로만 읽고 고친다(/api 를 직접 부르지 않는다).
  assert.match(provider, /'history\/conversationPage'/);
  assert.match(provider, /'history\/conversations'/, '옛 dex-cli 는 쪽 나누기 대신 전부 받는다');
  assert.match(provider, /'history\/rename'/);
  assert.match(provider, /'history\/delete'/);
  assert.match(provider, /'history\/purgeDeletedAgents'/);
  assert.match(provider, /'agents\/createOptions'/);
  assert.match(provider, /'agents\/nameTaken'/);
  assert.match(provider, /'agents\/create'/);
  assert.doesNotMatch(provider, /\/api\//);
  // 이름 바꾸기는 입력 상자, 지우기·정리는 확인 뒤.
  assert.match(provider, /showInputBox/);
  assert.match(provider, /showWarningMessage\(\s*'이 대화를 지울까요\?'/);
  assert.match(provider, /showWarningMessage\(purgeQuestion\(count\)/);
  // 로그인한 뒤 갈 곳이 없으면 대화 목록. 옛 Agent 격자 화면은 없다.
  assert.match(provider, /else this\.screen = 'conversations';/);
  assert.doesNotMatch(provider, /'agents'/);
  assert.doesNotMatch(provider, /id="agents-screen"/);

  // 시작 화면: 머리말과 칸 이름만. 설명 문장은 두지 않는다.
  const start = provider.slice(provider.indexOf('<section id="start-screen"'), provider.indexOf('<section id="chat-screen"'));
  assert.match(start, /오늘은 무엇을 해볼까요\?/);
  assert.match(start, /id="start-agent"/);
  assert.match(start, /<summary>세부 설정<\/summary>/);
  assert.doesNotMatch(start, /<p[\s>]/, '시작 화면에 설명 문단을 두지 않는다');

  // 지워진 에이전트의 대화는 기록만, 입력창 대신 안내 한 줄.
  assert.match(provider, /지워진 에이전트입니다\. 지난 대화만 볼 수 있습니다\./);
  assert.match(script, /chatComposer\.classList\.toggle\('hidden', readOnly\)/);

  // 잠긴 입력창도 누를 수는 있어야 까닭을 보인다.
  assert.match(script, /startSend\.classList\.toggle\('locked', locked\)/);
  assert.match(script, /post\('startName'/);
  assert.match(script, /post\('loadMoreConversations'\)/);
});

test('목록: 새 채팅은 [+ 새 채팅] 하나뿐, 묶음 머리는 접고 펴며 그 상태를 웹뷰 상태에 남긴다', async () => {
  const [script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  // 에이전트 줄·에이전트 화면의 [+] 와 [다른 에이전트] 는 없다.
  assert.doesNotMatch(script + provider, /startWithAgent|other-agents|agent-view-new/);
  for (const name of ['recent', 'agents']) {
    assert.match(provider, new RegExp(`id="${name}-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="${name}-body"`));
  }
  assert.match(script, /vscode\.getState\(\)/);
  assert.match(script, /vscode\.setState\(\{ \.\.\.savedViewState\(\), collapsed/);
  assert.match(script, /post\('loadMoreAgents'\)/);
  assert.match(script, /post\('lessAgents'\)/);
});

test('새로 쓴 대화 목록·시작 화면 글에는 줄표(U+2014)가 없다', async () => {
  const helper = await readFile(path.join(extensionRoot, 'src', 'conversation-view.ts'), 'utf8');
  assert.doesNotMatch(helper, /\u2014/);
  const provider = await readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8');
  const markup = provider.slice(provider.indexOf('<section id="conversations-screen"'), provider.indexOf('<section id="settings-screen"'));
  assert.doesNotMatch(markup, /\u2014/);
});

test('답변 아래 버튼은 늘 보이는 아이콘이고, 이름은 테마 말풍선으로 뜬다', async () => {
  const [styles, script] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.css'), 'utf8'),
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
  ]);
  const rule = (selector: string): string => {
    const at = styles.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing rule: ${selector}`);
    return styles.slice(at, styles.indexOf('}', at));
  };
  // 마우스를 올려야 드러나던 버튼 — 있는 줄도 모르고 지나친다.
  assert.doesNotMatch(rule('.copy-button'), /opacity:\s*0/);
  assert.doesNotMatch(rule('.msg-footer .msg-actions'), /opacity:\s*0/);
  assert.doesNotMatch(styles, /:hover \.msg-footer \.msg-actions|\.message-body:hover \.copy-button/);
  // 이름은 브라우저 기본 title 이 아니라 VS Code 호버 위젯 색의 말풍선.
  assert.match(styles, /\[data-tip\]::after/);
  assert.match(styles, /--vscode-editorHoverWidget-background/);
  assert.match(script, /dataset\.tip = label/);
  assert.doesNotMatch(script.slice(script.indexOf('function copyButton'), script.indexOf('function appendInlineText')), /\.title =/);
});

test('입력창 아래 모델 칩 — 누르면 VS Code 빠른 선택, 다른 화면의 변경을 따라간다', async () => {
  const [script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  assert.match(script, /post\('pickModel'\)/);
  assert.match(provider, /'conversation\/model'/);
  assert.match(provider, /'conversation\/model\/set'/);
  assert.match(provider, /'conversation\/modelChanged'/);
  assert.match(provider, /showQuickPick/);
  // 새 대화도 첫 말 전에 고를 수 있고, 첫 턴이 그 번호로 나가야 고른 모델이 붙는다.
  assert.match(provider, /interactionId: this\.modelTarget\(\)/);
});

test('⋯ 메뉴는 [채팅 기록 관리] 와 [제거], 관리 탭은 엔진 RPC 로만 부르고 문자열 HTML 을 쓰지 않는다', async () => {
  const [panel, script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'src', 'conversation-manager-panel.ts'), 'utf8'),
    readFile(path.join(extensionRoot, 'media', 'manager.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  const menu = provider.slice(provider.indexOf('id="list-menu-panel"'), provider.indexOf('id="list-main"'));
  assert.match(menu, /id="list-manage"[^>]*>채팅 기록 관리</);
  assert.match(menu, /id="list-purge"/);
  assert.doesNotMatch(panel, /\/api\//);
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /innerHTML/);
  for (const [, id] of script.matchAll(/byId\('([^']+)'\)/g)) assert.match(panel, new RegExp(`id="${id}"`), `missing markup id: ${id}`);
});
