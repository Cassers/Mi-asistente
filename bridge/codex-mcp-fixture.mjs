// Disposable native-smoke MCP child. A stubborn SIGTERM handler verifies that
// closing the CLI launcher also cleans up its descendants, without real tools.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.argv[2], `${process.pid}\n`)
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!Object.hasOwn(message, 'id')) return
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codex-lifecycle-fixture', version: '1' } }
    : message.method === 'tools/list' ? { tools: [] } : {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
})
