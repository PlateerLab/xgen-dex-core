/** 테스트용 최소 stdio MCP 서버 — argv/env 를 도구 목록에 그대로 노출한다.
 *  (args 배열 보존이 실제 spawn 까지 이어지는지 검증하기 위한 픽스처) */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const argv = process.argv.slice(2)
const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_argv',
      // 인자와 환경변수를 설명에 실어 테스트가 검증할 수 있게 한다.
      description: `argv=${JSON.stringify(argv)} env=${process.env.FAKE_TOKEN ?? ''}`,
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))
await server.connect(new StdioServerTransport())
