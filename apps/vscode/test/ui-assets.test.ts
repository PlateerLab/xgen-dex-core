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
  assert.match(script, /useWorkspaceRoot/);
  assert.match(script, /canonicalMode/);
  assert.match(script, /canonicalRetry/);
  assert.match(script, /post\('send', \{ text: raw \}\)/, 'Canonical send must preserve the textarea value exactly');
  assert.match(script, /new TextEncoder\(\)\.encode\(raw\)\.byteLength > CANONICAL_INPUT_MAX_BYTES/);
  assert.match(script, /post\('canonicalInputRejected'\)/);
  assert.ok(script.indexOf("post('canonicalInputRejected')") < script.indexOf("post('send', { text: raw })"),
    'oversized Canonical input must be rejected before send or textarea clearing');
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

test('Canonical mode is an explicit native-only composer path with stable controls', async () => {
  const [provider, script] = await Promise.all([
    readFile(path.join(extensionRoot, 'src', 'chat-view-provider.ts'), 'utf8'),
    readFile(path.join(extensionRoot, 'media', 'chat.js'), 'utf8'),
  ]);
  for (const id of ['canonical-mode', 'canonical-retry', 'input', 'send', 'cancel']) {
    assert.match(provider, new RegExp(`id=["']${id}["']`));
  }
  assert.match(provider, /attachNative\(controller: NativeSessionController\)/);
  assert.match(provider, /updateNative\(state: NativeSessionViewState\)/);
  assert.match(provider, /this\.native\?\.submitTurn\(input\)/);
  assert.match(provider, /catch \{\s*this\.canonicalNotice = '메시지를 보내지 못했습니다\./,
    'the extension host must handle synchronous Canonical input failures with a static notice');
  assert.match(provider, /data\.type === 'canonicalInputRejected'/);
  assert.match(provider, /this\.native\?\.retryTurn\(\)/);
  assert.match(provider, /this\.native\?\.stopTurn\(\)/);
  assert.match(provider, /if \(this\.canonicalMode\) return;/, 'attachments must be unavailable in Canonical mode');
  assert.match(provider,
    /messages: this\.canonicalMode \? \(canonicalConversation \? canonicalMessages\(canonicalConversation\) : \[\]\) : this\.messages/,
    'a missing Canonical snapshot must never reveal the legacy transcript');
  assert.match(script, /if \(state\.canonical\?\.active\)/);
  assert.match(script, /elements\.attach\.disabled = canonical/);
  assert.match(script, /canonical\.identity && canonicalIdentity && canonical\.identity !== canonicalIdentity/);
  assert.match(script, /canonical\.connectionVersion/);
  assert.match(script, /legacyDraft = elements\.input\.value/);
  assert.match(script, /elements\.input\.value = ''/,
    'scope/session/reset transitions must clear the Canonical textarea');
  for (const id of ['canonical-session-older', 'canonical-session-refresh', 'canonical-session-page']) {
    assert.match(provider, new RegExp(`id=["']${id}["']`));
  }
  assert.match(provider, /data\.type === 'canonicalCatalogOlder'/);
  assert.match(provider, /loadOlderAgentSessions\(scope\.profile, scope\.user_id\)/);
  assert.match(script, /post\('canonicalCatalogOlder'\)/);
  assert.match(script, /catalog\.hasMore/);
  assert.match(script, /catalog\?\.nextCursor/);
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
