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
  assert.match(script, /selectAgent/);
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
  assert.match(styles, /\.agent-grid/);
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

test('Agent 목록과 헤더는 한 화면에 많이 들어와야 한다', async () => {
  // 사이드바에서 카드 하나가 154px 를 쓰면 서너 개밖에 안 보여 목록을 훑을 수가
  // 없다. 그 높이는 장식 아이콘·없는 설명 자리·"대화 시작 →" 안내가 각각 한 줄씩
  // 먹어서 생긴 것이었다.
  const [styles, script, provider] = await Promise.all([
    readFile(path.join(extensionRoot, 'media', 'chat.css'), 'utf8'),
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
  ]);
  const cardRule = styles.slice(styles.indexOf('.agent-card {'), styles.indexOf('}', styles.indexOf('.agent-card {')));
  assert.doesNotMatch(cardRule, /min-height/, '카드 높이를 고정하면 내용과 무관하게 자리를 먹는다');

  // 주석은 무엇을 왜 없앴는지 적어 두는 자리라 그 문구가 남아 있다. 코드만 본다.
  const code = (source: string): string => source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.doesNotMatch(code(script), /agent-card-icon/, '카드마다 같은 장식 아이콘은 고르는 데 도움이 안 된다');
  assert.doesNotMatch(code(script), /대화 시작 →/, '카드 전체가 이미 버튼이다');
  assert.doesNotMatch(code(script), /등록된 설명이 없습니다/, '없는 설명으로 한 줄을 채우지 않는다');

  assert.doesNotMatch(code(provider), /agent-avatar/, '채팅 헤더의 장식 아바타는 대화창을 밀어낸다');
  assert.doesNotMatch(code(provider), /ACTIVE AGENT/, '이름 위의 머리글은 한 줄을 더 먹는다');
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
