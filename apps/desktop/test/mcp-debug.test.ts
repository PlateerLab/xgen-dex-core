// 로컬 MCP 인디케이터가 JSON 디버그 옵션으로만 노출되는 계약을 검증한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const configSource = readFileSync(new URL('../src/main/config.ts', import.meta.url), 'utf8');
const workspaceSource = readFileSync(
  new URL('../src/renderer/src/views/Workspace.tsx', import.meta.url),
  'utf8',
);
const chatSource = readFileSync(new URL('../src/renderer/src/views/Chat.tsx', import.meta.url), 'utf8');

test('mcpDebug는 connector.json 기본 비활성 옵션이다', () => {
  assert.match(configSource, /mcpDebug\?: boolean/);
  assert.match(configSource, /mcpDebug: false/);
});

test('Workspace가 JSON 옵션을 Chat에 전달하고 Chat은 활성일 때만 인디케이터를 그린다', () => {
  assert.match(workspaceSource, /mcpDebug=\{config\.mcpDebug === true\}/);
  assert.match(chatSource, /\{mcpDebug && \(/);
  assert.match(chatSource, /if \(!mcpDebug\)/);
});
