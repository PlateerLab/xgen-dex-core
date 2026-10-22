/** 테스트용 최소 stdio MCP 서버 — argv/env 를 도구 목록에 그대로 노출한다.
 *  (args 배열 보존이 실제 spawn 까지 이어지는지 검증하기 위한 픽스처) */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const markerAt = argv.indexOf('--exit-marker')
const marker = markerAt >= 0 ? argv[markerAt + 1] : ''
if (marker) {
  const mark = () => { try { writeFileSync(marker, 'closed') } catch {} }
  process.once('SIGTERM', mark)
  process.once('SIGINT', mark)
  process.once('exit', mark)
}
const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_argv',
      // 인자와 환경변수를 설명에 실어 테스트가 검증할 수 있게 한다.
      description: `argv=${JSON.stringify(argv)} env=${process.env.FAKE_TOKEN ?? ''}`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'slow',
      description: 'waits forever until the transport is cancelled',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'slow') await new Promise(() => {})
  return { content: [{ type: 'text', text: JSON.stringify(argv) }] }
})
await server.connect(new StdioServerTransport())
