import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
import { timingStub } from './timing-fixture.mjs'

const source = ts.transpileModule(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
async function setup() {
  const timers = new Map(), writes = [], instances = [], state = { microphoneMuted: false, recording: { controlVersion: 1 } }
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
    require: id => id === './utterance-audio' ? { captureDiagnostics: () => ({ status: 'missing', durationMs: 0 }) }
      : id === './timings' ? timingStub() : id === './projects' ? { selectedProject: () => null, subscribeProjects: () => () => {} }
      : id === './models' ? {} : id === '../config' ? { BRIDGE_WS_URL: 'ws://127.0.0.1:8787' }
      : { useStore: { setState() {}, getState: () => state } },
  })
  const warming = exports.warmBridge()
  const ws = instances[0]; ws.open(); ws.emit({ type: 'ready', servers: ['opencode'] })
  ws.emit({ type: 'permission_mode', policy: { mode: 'manual', autoApproved: 0 } })
  await warming
  ws.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } })
  return { app: exports, ws, writes, timers, state, instances }
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

test('native questions retain their pending UI until reply confirmation, and status errors allow explicit retry', async () => {
  const { app, ws } = await setup()
  const request = { id: 'codex:runtime:thread:number:1', permission: 'user_input', patterns: [], metadata: { questions: [] } }
  ws.emit({ type: 'permissions', requests: [request] })
  const failed = app.replyUserInput(request.id, { q: { answers: ['respuesta'] } })
  assert.equal(ws.sent.at(-1).type, 'user_input')
  const rejected = assert.rejects(failed, /Solicitud inválida/)
  ws.emit({ type: 'status_error', ask: request.id, message: 'Solicitud inválida' })
  await rejected
  let settled = false
  const retry = app.replyUserInput(request.id, {}).then(() => { settled = true })
  await Promise.resolve(); assert.equal(settled, false)
  ws.emit({ type: 'permissions', requests: [] })
  await retry; assert.equal(settled, true)
  await assert.rejects(app.replyUserInput(request.id, {}), /venció|otra conversación/)
})

test('native permission replies reject on connection loss rather than leaving a disabled modal forever', async () => {
  const { app, ws } = await setup()
  ws.emit({ type: 'permissions', requests: [{ id: 'approval', permission: 'bash', patterns: [], metadata: {} }] })
  const decision = app.replyPermission('approval', 'reject')
  const rejected = assert.rejects(decision, /conexión cambió/)
  ws.close(); await rejected
})


test('history pending waits for matching acknowledgement; errors, timeout and disconnect permit retry', async () => {
  const { app, ws, timers, state } = await setup()
  let confirmed = false
  const pending = app.setRecordingActive(true).then(() => { confirmed = true })
  await Promise.resolve()
  const request = ws.sent.at(-1)
  assert.equal(request.type, 'recording')
  ws.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } })
  await Promise.resolve(); assert.equal(confirmed, false)
  ws.emit({ type: 'recording', requestID: request.requestID, recording: { active: true, controlVersion: 1 } })
  await pending; assert.equal(confirmed, true)
  const failed = app.setRecordingActive(true)
  const rejected = assert.rejects(failed, /Captura denegada/)
  await Promise.resolve()
  ws.emit({ type: 'status_error', requestID: ws.sent.at(-1).requestID, message: 'Captura denegada' })
  await rejected
  const retry = app.setRecordingActive(false); await Promise.resolve()
  ws.emit({ type: 'recording', requestID: ws.sent.at(-1).requestID, recording: { active: false, controlVersion: 1 } }); await retry
  state.microphoneMuted = true
  const muted = app.setRecordingActive(true); await Promise.resolve()
  assert.equal(ws.sent.at(-1).microphone, false)
  ws.emit({ type: 'recording', requestID: ws.sent.at(-1).requestID, recording: { active: true, audio: ['system'], controlVersion: 1 } }); await muted
  assert.equal(state.microphoneMuted, true)
  const timeout = app.setRecordingActive(false)
  const timed = assert.rejects(timeout, /No se confirmó/); await Promise.resolve()
  ;[...timers.values()].find(timer => timer.ms === 10000).fn(); await timed
  const lost = app.setRecordingActive(false)
  const disconnected = assert.rejects(lost, /conexión/); await Promise.resolve(); ws.close(); await disconnected
})


test('old bridge cannot start microphone-excluding history through an HMR-updated client', async () => {
  const { app, ws, state } = await setup(); state.recording = {}; state.microphoneMuted = true
  ws.emit({ type: 'recording', recording: { active: false } })
  const before = ws.sent.length
  await assert.rejects(app.setRecordingActive(true), /Reinicia el puente/)
  assert.equal(ws.sent.length, before, 'never send start to an old bridge that ignores microphone:false')
  const stop = app.setRecordingActive(false)
  const rejected = assert.rejects(stop, /necesita reiniciarse/); await Promise.resolve()
  assert.equal(ws.sent.at(-1).active, false, 'privacy pause remains available with an older bridge')
  ws.emit({ type: 'recording', recording: { active: false } }); await rejected
})


test('reconnect cannot reuse previous socket capabilities even with a stale compatible recording store', async () => {
  const { app, ws, state, instances } = await setup(); state.microphoneMuted = true
  ws.close()
  state.recording = { controlVersion: 1 }
  const warming = app.warmBridge(), next = instances.at(-1)
  next.open(); next.emit({ type: 'ready', servers: ['opencode'] }); await warming
  await assert.rejects(app.setRecordingActive(true), /Reinicia el puente/)
  assert.equal(next.sent.some(frame => frame.type === 'recording' && frame.active), false)
  ws.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } })
  await assert.rejects(app.setRecordingActive(true), /Reinicia el puente/)
  next.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } })
  const resumed = app.setRecordingActive(true); await Promise.resolve()
  assert.equal(next.sent.at(-1).microphone, false)
  next.emit({ type: 'recording', requestID: next.sent.at(-1).requestID, recording: { active: true, controlVersion: 1, audio: ['system'] } })
  await resumed
})
