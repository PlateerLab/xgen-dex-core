// 처음엔 죽고, 표식 파일이 생기면 정상 기동하는 서버.
// (사용자 사례 재현: uv 를 나중에 설치 → 그전 실패 문구가 남아 있으면 안 된다)
import { existsSync } from 'fs'
import { createInterface } from 'readline'

const marker = process.env.FLAKY_MARKER
if (!marker || !existsSync(marker)) {
  process.stderr.write('command not found: uvx\n')
  process.exit(127)
}
const reply = (r) => process.stdout.write(JSON.stringify(r) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize')
    reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flaky', version: '1' } } })
  else if (m.method === 'tools/list')
    reply({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } })
  else if (m.id !== undefined) reply({ jsonrpc: '2.0', id: m.id, result: {} })
})
