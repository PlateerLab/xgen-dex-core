/** 표준 MCP 설정 JSON 가져오기 — 실제 사용자들이 붙여넣는 형태들. */
import assert from 'assert'
import { test } from 'node:test'
import {
  McpImportError, parseMcpConfig, toDisplayCommand, toMcpConfigJson,
} from '../src/renderer/src/views/mcp-import'

test('type:"sse" 는 transport:sse 로 보존한다 (이전엔 http 로 뭉개졌다)', () => {
  const { servers, warnings } = parseMcpConfig(JSON.stringify({
    mcpServers: { remote: { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer x' } } },
  }))
  assert.equal(warnings.length, 0)
  assert.equal(servers.length, 1)
  assert.equal(servers[0].transport, 'sse')
  assert.equal(servers[0].url, 'https://example.com/sse')
  assert.equal(servers[0].headers?.Authorization, 'Bearer x')
  // 내보내기 왕복도 sse 유지
  const json = JSON.parse(toMcpConfigJson(servers))
  assert.equal(json.mcpServers.remote.type, 'sse')
})

test('사용자가 붙여넣은 mcp-atlassian 설정을 그대로 가져온다', () => {
  const { servers, warnings } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      'mcp-atlassian': {
        command: 'uvx',
        args: ['mcp-atlassian'],
        env: {
          JIRA_URL: 'https://your-company.atlassian.net',
          JIRA_USERNAME: 'your.email@company.com',
          JIRA_API_TOKEN: 'your_api_token',
          CONFLUENCE_URL: 'https://your-company.atlassian.net/wiki',
          CONFLUENCE_USERNAME: 'your.email@company.com',
          CONFLUENCE_API_TOKEN: 'your_api_token',
        },
      },
    },
  }))
  assert.equal(warnings.length, 0)
  assert.equal(servers.length, 1)
  const s = servers[0]
  assert.equal(s.name, 'mcp-atlassian')
  assert.equal(s.transport, 'stdio')
  assert.equal(s.command, 'uvx')
  assert.deepEqual(s.args, ['mcp-atlassian'])
  assert.equal(s.env?.JIRA_URL, 'https://your-company.atlassian.net')
  assert.equal(Object.keys(s.env ?? {}).length, 6)
  assert.equal(s.enabled, true)
})

test('공백이 든 인자는 argv 로 보존되고 표시용에서만 인용된다', () => {
  const { servers } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Docs'] },
    },
  }))
  assert.deepEqual(servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Docs'])
  assert.equal(
    toDisplayCommand(servers[0].command!, servers[0].args),
    'npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"',
  )
})

test('http/sse 서버 (url·headers·type)', () => {
  const { servers } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com/api', headers: { Authorization: 'Bearer x' } },
      legacy: { url: 'https://sse.example.com/v1' },
    },
  }))
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
  assert.equal(byName.remote.transport, 'http')
  assert.equal(byName.remote.headers?.Authorization, 'Bearer x')
  assert.equal(byName.legacy.transport, 'http', 'type 없이 url 만 있어도 http')
})

test('disabled/enabled 플래그를 반영한다', () => {
  const { servers } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      a: { command: 'x', disabled: true },
      b: { command: 'y', enabled: false },
      c: { command: 'z' },
    },
  }))
  const m = Object.fromEntries(servers.map((s) => [s.name, s.enabled]))
  assert.deepEqual(m, { a: false, b: false, c: true })
})

test('변형 형태: servers 키 / 맵만 / 서버 하나', () => {
  assert.equal(parseMcpConfig('{"servers":{"a":{"command":"x"}}}').servers[0].name, 'a')
  assert.equal(parseMcpConfig('{"a":{"command":"x"}}').servers[0].name, 'a')
  const one = parseMcpConfig('{"command":"uvx","args":["srv"]}', 'pasted')
  assert.equal(one.servers[0].name, 'pasted')
  assert.deepEqual(one.servers[0].args, ['srv'])
})

test('잘못된 입력은 사람이 읽을 오류로 실패한다', () => {
  assert.throws(() => parseMcpConfig(''), McpImportError)
  assert.throws(() => parseMcpConfig('not json'), (e: unknown) => e instanceof McpImportError && /JSON 형식/.test((e as Error).message))
  assert.throws(() => parseMcpConfig('[1,2]'), McpImportError)
  assert.throws(() => parseMcpConfig('{"mcpServers":{}}'), McpImportError)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{}}}'), (e: unknown) => /command 도 url 도 없어/.test((e as Error).message))
})

test('일부만 잘못된 경우 나머지는 가져오고 경고를 남긴다', () => {
  const r = parseMcpConfig(JSON.stringify({
    mcpServers: { good: { command: 'ok' }, bad: { note: 'no command' } },
  }))
  assert.equal(r.servers.length, 1)
  assert.equal(r.servers[0].name, 'good')
  assert.equal(r.warnings.length, 1)
})

test('env 값이 문자열이 아니어도 문자열로 정규화한다', () => {
  const { servers } = parseMcpConfig('{"mcpServers":{"a":{"command":"x","env":{"PORT":8080,"NUL":null}}}}')
  assert.deepEqual(servers[0].env, { PORT: '8080' })
})

test('내보내기 → 가져오기 왕복이 동일하다', () => {
  const original = [
    { name: 'mcp-atlassian', transport: 'stdio' as const, command: 'uvx', args: ['mcp-atlassian'], env: { A: '1' }, enabled: true },
    { name: 'remote', transport: 'http' as const, url: 'https://x/api', headers: { H: 'v' }, enabled: false },
  ]
  const round = parseMcpConfig(toMcpConfigJson(original)).servers
  assert.equal(round.length, 2)
  assert.deepEqual(round[0].args, ['mcp-atlassian'])
  assert.equal(round[0].env?.A, '1')
  assert.equal(round[1].transport, 'http')
  assert.equal(round[1].enabled, false, 'disabled 플래그가 왕복되어야 한다')
})
