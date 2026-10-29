import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { timingStub } from './timing-fixture.mjs'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const bridgeCode = compile(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'))
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'watchConnection') callback = node.arguments[0].getText(app)
  ts.forEachChild(node, visit)
}
visit(app)
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const backoffs = [500, 1000, 2000, 4000, 8000, 8000]

function fixture({ project = { id: 'p1', application: 'opencode' } } = {}) {
  let selected = project, now = 0, serial = 0, connectionState = null
  const state = { error: null, turns: [], recording: null, applicationCapabilities: null, autoScreen: false, screenCapture: 'off' }
  const timers = new Map(), instances = [], events = [], subscriptions = new Set(), writes = []
  const set = (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, due: now + ms }); return id }
  state.setError = value => { state.error = value }
  const store = { getState: () => state, setState: patch => Object.assign(state, patch) }
  class Socket {
    static OPEN = 1; static CLOSED = 3
    readyState = 0; listeners = new Map(); sent = []; deferClose = false
    constructor(url) { this.url = String(url); instances.push(this) }
    addEventListener(type, fn) { const rows = this.listeners.get(type) || new Set(); rows.add(fn); this.listeners.set(type, rows) }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    open() { this.readyState = 1; this.onopen() }
    emit(value) { for (const fn of this.listeners.get('message') || []) fn({ data: JSON.stringify(value) }) }
    ready(id = 'c1') { this.emit({ type: 'ready', servers: [selected?.application || 'opencode'], capabilities: { screenOptIn: true }, conversation: { id, title: 'Synthetic', entries: [], turns: [] } }) }
    close() { this.readyState = this.deferClose ? 2 : 3; if (!this.deferClose) this.finishClose() }
    finishClose() { this.readyState = 3; this.onclose?.(); for (const fn of this.listeners.get('close') || []) fn() }
    fail() { this.onerror(); this.close() }
  }
  const exports = {}, context = {
    exports, URL, Error, WebSocket: Socket, console, store,
    setConnectionState: value => { connectionState = value },
    location: { port: '5173' }, window: { setTimeout: set }, setTimeout: set, clearTimeout: id => timers.delete(id),
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args), removeItem() {} },
    require: id => {
      const deps = { '../store': { useStore: store }, '../config': { BRIDGE_WS_URL: 'ws://synthetic.invalid:8787' },
        './models': { currentModelSelection: async () => ({}) }, './voice-input-mode': { currentVoiceInputMode: () => 'transcript', reportVoiceInput() {} },
        './projects': { selectedProject: () => selected, subscribeProjects: fn => { subscriptions.add(fn); return () => subscriptions.delete(fn) } },
        './timings': timingStub(() => assert.fail('No HTTP allowed')), './utterance-audio': { captureDiagnostics: () => ({ status: 'missing', durationMs: 0 }) } }
      assert.ok(id in deps, 'Unexpected import ' + id); return deps[id]
    },
  }
  vm.runInNewContext(bridgeCode, context)
  vm.runInNewContext(compile(`exports.connectionHandler = ${callback}`), context)
  exports.watchConnection(value => { events.push(value); exports.connectionHandler(value) })
  return { api: exports, state, instances, timers, events, writes,
    get last() { return instances.at(-1) }, get connectionState() { return connectionState },
    async start(noProject = false) { const warming = exports.warmBridge(); this.last.open(); if (noProject) this.last.emit({ type: 'project_required' }); else this.last.ready(); await warming },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        now = next[1].due; timers.delete(next[0]); next[1].fn(); await flush()
      }
      now = target
    },
    setProject(value) { selected = value; subscriptions.forEach(fn => fn()) },
    retryTimers() { return [...timers.values()].filter(t => backoffs.includes(t.ms)) },
  }
}

test('all six bounded reconnect delays survive failed handshakes and then report a truthful terminal state', async () => {
  const f = fixture(); await f.start(); f.last.close()
  assert.equal(f.connectionState, 'lost')
  for (const delay of backoffs) {
    assert.equal(f.retryTimers()[0].ms, delay)
    await f.advance(delay); f.last.fail(); await flush()
  }
  assert.equal(f.instances.length, 7)
  assert.equal(f.connectionState, 'exhausted'); assert.equal(f.retryTimers().length, 0)
  await f.advance(60000); assert.equal(f.instances.length, 7)
  assert.equal(f.state.error, null, 'connection banners never use the global error channel')
})

test('protocol ready resets recovery budget, clears only its notice and retains unrelated errors and privacy resets', async () => {
  const f = fixture(); await f.start()
  f.state.autoScreen = true; f.state.screenCapture = 'attached'; f.state.recording = { active: true, controlVersion: 1 }
  f.state.error = 'Whisper/provider/recording error must remain'
  f.last.close()
  assert.equal(f.state.autoScreen, false); assert.equal(f.state.recording, null); assert.equal(f.state.applicationCapabilities, null)
  await f.advance(500); f.last.fail(); await flush()
  await f.advance(1000); f.last.open(); assert.equal(f.connectionState, 'reconnected')
  f.last.ready('restored')
  assert.equal(f.connectionState, 'ready'); assert.equal(f.state.error, 'Whisper/provider/recording error must remain')
  assert.equal(f.state.autoScreen, false, 'recovery cannot restore sharing consent')
  f.last.close(); assert.equal(f.retryTimers()[0].ms, 500)
})

test('opening a transport without application ready cannot reset the reconnect budget indefinitely', async () => {
  const f = fixture(); await f.start(); f.last.close()
  for (const delay of backoffs) {
    assert.equal(f.retryTimers()[0].ms, delay)
    await f.advance(delay); f.last.open(); f.last.emit({ type: 'session_error', message: 'Synthetic initialization failure' }); f.last.close()
    await flush()
  }
  assert.equal(f.instances.length, 7); assert.equal(f.connectionState, 'exhausted')
  assert.equal(f.api.conversationSnapshot().error, 'Synthetic initialization failure')
})

test('project_required is connected and actionable, preserves unrelated errors and creates no project/chat request', async () => {
  const f = fixture({ project: null }); f.state.error = 'Unrelated user error'; await f.start(true)
  assert.equal(f.api.isConnected(), true); assert.equal(f.connectionState, 'project-required')
  assert.equal(f.api.conversationSnapshot().chat, null); assert.equal(f.state.error, 'Unrelated user error')
  assert.equal(f.state.applicationCapabilities, null); assert.equal(f.state.recording, null)
  assert.equal(new URL(f.last.url).searchParams.has('project'), false)
  assert.deepEqual(f.last.sent, [])
  f.last.close(); await f.advance(500); f.last.open(); f.last.emit({ type: 'project_required' })
  assert.equal(f.connectionState, 'project-required'); assert.equal(f.state.error, 'Unrelated user error')
})

test('initial dial failure exposes explicit recovery; retry uses current destination and continues bounded failed dials', async () => {
  const f = fixture(), first = f.api.warmBridge(); f.last.fail(); await assert.rejects(first)
  assert.equal(f.connectionState, 'lost', 'initial failure must not claim exhausted retries before they run')
  for (const delay of backoffs) { await f.advance(delay); f.last.fail(); await flush() }
  assert.equal(f.connectionState, 'exhausted')
  f.state.error = 'User error'; const retry = f.api.retryBridge(); f.last.fail(); await assert.rejects(retry)
  assert.equal(f.connectionState, 'lost'); assert.equal(f.retryTimers()[0].ms, 500)
  assert.equal(new URL(f.last.url).searchParams.get('project'), 'p1')
  await f.advance(500); f.last.open(); f.last.ready('same-destination')
  assert.equal(f.connectionState, 'ready'); assert.equal(f.state.error, 'User error')
  assert.ok(f.instances.every(ws => ws.sent.length === 0), 'retry cannot submit audio, ask, start history or select a project')
})

test('stale timers and old socket messages cannot reconnect or mutate a new project', async () => {
  const f = fixture(); await f.start(); const old = f.last; old.close()
  const stale = f.retryTimers()[0].fn
  f.setProject({ id: 'p2', application: 'claude' }); await flush(); f.last.open(); f.last.ready('new-chat')
  const count = f.instances.length
  stale(); old.emit({ type: 'ready', capabilities: { screenOptIn: false }, conversation: { id: 'old-chat', turns: [], entries: [] } }); old.finishClose()
  await flush()
  assert.equal(f.instances.length, count); assert.equal(f.api.conversationSnapshot().chat.id, 'new-chat')
  assert.equal(f.state.applicationCapabilities.screenOptIn, true); assert.equal(f.connectionState, 'ready')
  f.last.close(); const currentTimer = f.retryTimers()[0]
  stale(); assert.equal(f.retryTimers()[0], currentTimer, 'an obsolete callback cannot clear the new backoff owner')
  f.setProject({ id: 'p3', application: 'codex' }); await flush(); f.last.fail(); await flush()
  assert.equal(f.connectionState, 'lost', 'a cancelled old timer cannot suppress recovery of the new destination')
  assert.equal(f.retryTimers().length, 1)
})

test('manual chat switching excludes auto-retry and explicit retry until the old socket closes', async () => {
  const f = fixture(); await f.start(); const old = f.last; old.deferClose = true
  const changing = f.api.chooseConversation('new'); await flush()
  assert.equal(f.instances.length, 1)
  await assert.rejects(f.api.retryBridge(), /cambio de conversación/)
  await f.advance(10000); assert.equal(f.instances.length, 1)
  old.finishClose(); await flush(); f.last.open(); f.last.ready('new-chat'); await changing
  assert.equal(f.instances.length, 2); assert.equal(f.connectionState, 'ready')
  assert.equal(f.retryTimers().length, 0)
})

test('a late failure from an obsolete pending dial cannot mark the new destination exhausted', async () => {
  const f = fixture(), initial = f.api.warmBridge(); const failed = assert.rejects(initial), old = f.last
  f.setProject({ id: 'p2', application: 'codex' }); await flush(); f.last.open(); f.last.ready('new-chat')
  old.fail(); await failed; await flush()
  assert.equal(f.connectionState, 'ready'); assert.equal(f.api.conversationSnapshot().chat.id, 'new-chat')
  assert.equal(f.retryTimers().length, 0)
})


test('recovery retires only exact legacy connection-owned notices after a hot update', async () => {
  for (const notice of ['Bridge connection lost — reconnecting.', 'Conexión restablecida; comprobando la conversación.']) {
    const f = fixture(); f.state.error = notice; await f.start()
    assert.equal(f.state.error, null)
  }
})

test('multiple callers sharing a failed dial cannot consume or schedule the next backoff twice', async () => {
  const f = fixture(); await f.start(); f.last.close(); await f.advance(500)
  const joined = f.api.warmBridge(); const failed = assert.rejects(joined)
  f.last.fail(); await failed; await flush()
  assert.equal(f.retryTimers().length, 1); assert.equal(f.retryTimers()[0].ms, 1000)
})
