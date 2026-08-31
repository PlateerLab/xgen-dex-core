// 첫 실행이 오래 걸리는 서버 흉내 — uv 가 인터프리터/의존성을 내려받는 동안
// stderr 로 진행 상황을 뱉다가 뒤늦게 MCP 초기화에 응답한다.
import { createInterface } from 'readline'

const start = Date.now()
const READY_AFTER_MS = 1200
const pkgs = ['cpython-3.13.14 (24.0MiB)', 'lxml (8.2MiB)', 'cryptography (3.8MiB)', 'pydantic-core (1.9MiB)']
let i = 0
const beat = setInterval(() => {
  process.stderr.write(`Downloading ${pkgs[i % pkgs.length]}\n`)
  i++
}, 120)

const pending = []
function reply(res) {
  process.stdout.write(JSON.stringify(res) + '\n')
}
function handle(msg) {
  if (msg.method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } },
    })
  } else if (msg.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } })
  } else if (msg.id !== undefined) {
    reply({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // 준비되기 전 요청은 쌓아 두었다가 나중에 답한다 (설치가 끝나야 서버가 뜬다).
  if (Date.now() - start < READY_AFTER_MS) pending.push(msg)
  else handle(msg)
})

setTimeout(() => {
  clearInterval(beat)
  process.stderr.write('Installed 31 packages\n')
  for (const m of pending.splice(0)) handle(m)
}, READY_AFTER_MS)
