import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = ts.transpileModule(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
async function setup() {
  const timers = new Map(), writes = [], instances = []
  let sequence = 0
  class Socket {
    static OPEN = 1; static CLOSED = 3
    readyState = 0; listeners = new Map(); sent = []
    constructor() { instances.push(this) }
    addEventListener(type, listener) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set) }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
    open() { this.readyState = 1; this.onopen() }
    send(data) { this.sent.push(JSON.parse(data)) }
    emit(data) { this.listeners.get('message')?.forEach(fn => fn({ data: JSON.stringify(data) })) }
    close() { this.readyState = 3; this.onclose(); this.listeners.get('close')?.forEach(fn => fn()) }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, URL, WebSocket: Socket, location: { port: '5173' }, console, window: { setTimeout: () => 0 },
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => timers.delete(id),
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) },
    require: id => id === './models' ? {} : id === '../config' ? { BRIDGE_WS_URL: 'ws://127.0.0.1:8787' }
      : { useStore: { setState() {}, getState: () => ({}) } },
  })
  const warming = exports.warmBridge()
  const ws = instances[0]; ws.open(); ws.emit({ type: 'ready', servers: ['opencode'] })
  ws.emit({ type: 'permission_mode', policy: { mode: 'manual', autoApproved: 0 } })
  await warming
  return { app: exports, ws, writes, timers }
}

test('permission indicator uses confirmed server mode only; total needs confirmation and never persists', async () => {
  const { app, ws, writes } = await setup()
  assert.throws(() => app.setPermissionMode('total'), /confirmar/)
  app.setPermissionMode('total', true)
  assert.equal(app.permissionModeSnapshot().mode, 'manual')
  assert.equal(app.permissionModeSnapshot().pending, true)
  assert.equal(ws.sent.at(-1).confirmed, true)
  ws.emit({ type: 'permission_mode', requestID: ws.sent.at(-1).requestID, policy: { mode: 'total', autoApproved: 0 } })
  assert.equal(app.permissionModeSnapshot().mode, 'total')
  ws.close()
  assert.equal(app.permissionModeSnapshot().mode, 'manual')
  assert.equal(app.permissionModeSnapshot().connected, false)
  assert.equal(writes.length, 0)
})
test('unacknowledged escalation closes the connection instead of leaving an uncertain automatic mode', async () => {
  const { app, ws, timers } = await setup()
  app.setPermissionMode('limited')
  ws.emit({ type: 'permission_mode', policy: { mode: 'manual', autoApproved: 1 } })
  assert.equal(app.permissionModeSnapshot().pending, true, 'counter update is not the requested mode acknowledgement')
  const timeout = [...timers.values()].find(t => t.ms === 5000)
  assert.ok(timeout); timeout.fn()
  assert.equal(ws.readyState, 3)
  assert.equal(app.permissionModeSnapshot().mode, 'manual')
  assert.equal(app.permissionModeSnapshot().connected, false)
  assert.equal(app.permissionModeSnapshot().pending, false)
})
