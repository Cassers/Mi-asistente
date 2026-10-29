import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { timingStub } from './timing-fixture.mjs'

async function setup(captureStatus = 'missing', select = async () => ({ model: 'opencode-go/muse-spark-1.2-contributor', variant: 'high' })) {
  let mode = 'clip'
  const state = { autoScreen: false }
  const statuses = [], instances = []
  class Socket {
    static OPEN = 1
    readyState = 0; listeners = new Map(); sent = []
    constructor() { instances.push(this) }
    addEventListener(type, listener) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set) }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    emit(data) { this.listeners.get('message')?.forEach(fn => fn({ data: JSON.stringify(data) })) }
    open() { this.readyState = 1; this.onopen() }
  }
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, URL, WebSocket: Socket, console, location: { port: '5173' }, window: { setTimeout: () => 0 }, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    require: id => id === './utterance-audio' ? { captureDiagnostics: () => ({ status: captureStatus, durationMs: 0 }) }
      : id === './timings' ? timingStub() : id === './voice-input-mode' ? { currentVoiceInputMode: () => mode, reportVoiceInput: text => statuses.push(text) }
      : id === './models' ? { currentModelSelection: select }
      : id === './projects' ? { selectedProject: () => null, subscribeProjects: () => () => {} }
      : id === '../config' ? { BRIDGE_WS_URL: 'ws://127.0.0.1:8787' } : { useStore: { setState: patch => Object.assign(state, patch), getState: () => state } },
  })
  const warming = exports.warmBridge(), ws = instances[0]
  ws.open(); ws.emit({ type: 'ready', servers: ['opencode'], capabilities: { screenOptIn: true } }); await warming
  ws.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } })
  return { app: exports, ws, statuses, state, setMode: value => { mode = value } }
}

test('transcript selection strips captured audio before WebSocket serialization', async () => {
  const f = await setup(); f.setMode('transcript')
  const running = f.app.ask('Texto dictado', { onText() {}, onTool() {} }, { mime: 'audio/wav', data: 'private-clip' })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  const sent = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(sent.audioMode, 'transcript')
  assert.equal(sent.audio, undefined)
  assert.equal(sent.variant, 'high')
  assert.doesNotMatch(JSON.stringify(f.ws.sent), /private-clip/)
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Respuesta' }); await running
})

test('submission acknowledgement reaches only its own transcript request before the model has answered', async () => {
  const f = await setup(); f.setMode('transcript')
  let accepted = 0, text = ''
  const running = f.app.ask('Hola', { onSubmitted() { accepted++ }, onText(delta) { text += delta }, onTool() {} })
  for (let i=0; i<12; i++) await Promise.resolve()
  const sent = f.ws.sent.find(message => message.type === 'ask')
  f.ws.emit({ type: 'submitted', ask: 'other-turn' }); assert.equal(accepted, 0)
  f.ws.emit({ type: 'submitted', ask: sent.id }); assert.equal(accepted, 1); assert.equal(text, '')
  f.ws.emit({ type: 'text', ask: sent.id, delta: 'Hola' })
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Hola' }); await running
  f.ws.emit({ type: 'submitted', ask: sent.id }); assert.equal(accepted, 1)
})

test('direct replacement waits for the matching native stop acknowledgement while the old partial reply stays cancelled', async () => {
  const f = await setup(); f.setMode('direct')
  const handlers = { onText() {}, onTool() {} }, clip = { mime: 'audio/wav', data: 'actual-audio' }
  const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve() }
  const first = f.app.ask('Fixed audio instruction', handlers, clip)
  await flush()
  const firstSent = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(firstSent.audioMode, 'direct'); assert.equal(firstSent.audio.data, clip.data)
  f.ws.emit({ type: 'text', ask: firstSent.id, delta: 'Partial answer' })
  f.app.interrupt('speech')
  const old = await first
  assert.equal(old.status, 'cancelled'); assert.equal(old.text, 'Partial answer')
  const stop = f.ws.sent.find(message => message.type === 'interrupt')
  assert.equal(stop.reason, 'speech'); assert.ok(stop.requestID)
  const next = f.app.ask('Fixed second audio instruction', handlers, clip)
  await flush()
  assert.equal(f.ws.sent.filter(message => message.type === 'ask').length, 1)
  f.ws.emit({ type: 'interrupted', requestID: 'wrong-stop', status: 'ok' }); await flush()
  assert.equal(f.ws.sent.filter(message => message.type === 'ask').length, 1)
  f.ws.emit({ type: 'interrupted', requestID: stop.requestID, status: 'ok' }); await flush()
  const sent = f.ws.sent.filter(message => message.type === 'ask').at(-1)
  assert.notEqual(sent.id, firstSent.id)
  f.ws.emit({ type: 'done', ask: firstSent.id, text: 'Late old reply' })
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Next answer' })
  assert.equal((await next).text, 'Next answer')
})

test('speech during model selection preserves the older clip before dispatching the replacement', async () => {
  const selections = []
  const f = await setup('ready', () => new Promise(resolve => selections.push(resolve)))
  f.setMode('direct')
  const handlers = { onText() {}, onTool() {} }, clip = { mime: 'audio/wav', data: 'fixture' }
  const flush = async () => { for (let i=0;i<40;i++) await Promise.resolve() }
  const first = f.app.ask('one', handlers, clip); await flush()
  const second = f.app.ask('two', handlers, clip); await flush()
  assert.equal((await first).status, 'cancelled')
  assert.equal(selections.length, 2)
  selections[1]({}); await flush()
  assert.equal(f.ws.sent.filter(message => message.type === 'ask').length, 0)
  selections[0]({}); await flush()
  const old = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(old.preserveOnly, true)
  f.ws.emit({ type: 'done', ask: old.id, status: 'cancelled' }); await flush()
  const replacement = f.ws.sent.filter(message => message.type === 'ask')[1]
  assert.equal(replacement.preserveOnly, undefined)
  f.ws.emit({ type: 'done', ask: old.id, text: 'stale' })
  f.ws.emit({ type: 'done', ask: replacement.id, text: 'replacement' })
  assert.equal((await second).text, 'replacement')
})

test('failed native stop acknowledgement rejects the next direct clip instead of sending it early', async () => {
  const f = await setup(); f.setMode('direct')
  f.app.interrupt('speech')
  const stop = f.ws.sent.find(message => message.type === 'interrupt')
  const next = f.app.ask('fixed', { onText() {}, onTool() {} }, { mime: 'audio/wav', data: 'fixture' })
  for (let i=0;i<12;i++) await Promise.resolve()
  f.ws.emit({ type: 'interrupted', requestID: stop.requestID, status: 'error' })
  await assert.rejects(next, /detención/)
  assert.equal(f.ws.sent.filter(message => message.type === 'ask').length, 0)
})

test('clip preference is snapshotted per turn; provider fallback remains visible and scoped to ask', async () => {
  const f = await setup(), notifications = []
  const running = f.app.ask('Respaldo', { onText() {}, onTool() {}, onAudio: (...args) => notifications.push(args) }, { mime: 'audio/wav', data: 'synthetic-clip' })
  f.setMode('transcript')
  for (let i = 0; i < 12; i++) await Promise.resolve()
  const sent = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(sent.audioMode, 'clip')
  assert.equal(sent.audio.data, 'synthetic-clip')
  f.ws.emit({ type: 'audio', ask: 'foreign', state: 'fallback', message: 'Foreign' })
  f.ws.emit({ type: 'audio', ask: sent.id, state: 'fallback', message: 'No se pudo interpretar; se usó el dictado.' })
  assert.equal(notifications.length, 1)
  assert.match(f.statuses.at(-1), /se usó el dictado/)
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Respuesta' }); await running
})
test('capture overflow sends full browser dictation once and explains why no partial audio is sent', async () => {
  const f = await setup('overflow')
  const text = 'Conserva el principio y también el final de toda mi intervención.'
  const running = f.app.ask(text, { onText() {}, onTool() {} })
  for (let i=0;i<12;i++) await Promise.resolve()
  const sent = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(sent.text, text); assert.equal(sent.audio, undefined)
  assert.match(f.statuses.at(-1), /60 s.*dictado completo.*audio recortado/)
  assert.equal(f.ws.sent.filter(m => m.type === 'ask').length, 1)
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Recibido' }); await running
})


test('typed messages force text serialization even when voice preference is direct, without changing that preference', async () => {
  const f = await setup(); f.setMode('direct')
  const running = f.app.ask('Mensaje escrito', { onText() {}, onTool() {} }, undefined, 'typed-trace', { audioMode: 'transcript' })
  for (let i=0; i<20; i++) await Promise.resolve()
  const sent = f.ws.sent.find(message => message.type === 'ask')
  assert.equal(sent.text, 'Mensaje escrito')
  assert.equal(sent.audioMode, 'transcript'); assert.equal(sent.audio, undefined)
  f.ws.emit({ type: 'done', ask: sent.id, text: 'Respuesta' }); await running
  const audio = f.app.ask('Continuación de voz', { onText() {}, onTool() {} }, { mime: 'audio/wav', data: 'next-clip' })
  for (let i=0; i<20; i++) await Promise.resolve()
  const next = f.ws.sent.filter(message => message.type === 'ask').at(-1)
  assert.equal(next.audioMode, 'direct'); assert.equal(next.audio.data, 'next-clip')
  f.ws.emit({ type: 'done', ask: next.id, text: 'Respuesta' }); await audio
})


test('actual ask frames carry explicit per-turn screen choice independently of transcript mode', async () => {
  const f = await setup(); f.setMode('transcript')
  for (const enabled of [false, true, false]) {
    f.state.autoScreen = enabled
    const pending = f.app.ask('Mira mi pantalla', { onText() {}, onTool() {} })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const sent = f.ws.sent.filter(frame => frame.type === 'ask').at(-1)
    assert.equal(sent.screen, enabled); assert.equal(sent.audioMode, 'transcript'); assert.equal(sent.audio, undefined)
    f.ws.emit({ type: 'done', ask: sent.id, text: 'fixture' }); await pending
  }
})


test('requested sharing rejects an old backend before sending a text-only ask', async () => {
  const f = await setup(); f.setMode('transcript'); f.state.autoScreen = true
  f.ws.emit({ type: 'recording', recording: { active: false } })
  await assert.rejects(f.app.ask('Mira', { onText() {}, onTool() {} }), /Reinicia el puente/)
  assert.equal(f.ws.sent.some(frame => frame.type === 'ask'), false)
})

test('Whisper is serialized as transcript-only for every native application, never as original audio', async () => {
  for (const application of ['opencode', 'codex', 'claude', 'antigravity']) {
    const f = await setup(); f.setMode('whisper')
    f.ws.emit({ type: 'ready', servers: [application], capabilities: { screenOptIn: true } })
    const running = f.app.ask('Texto reconocido por Whisper local', { onText() {}, onTool() {} }, { mime: 'audio/wav', data: 'never-send-raw-whisper-clip' })
    for (let i = 0; i < 24; i++) await Promise.resolve()
    const sent = f.ws.sent.find(message => message.type === 'ask')
    assert.ok(sent, application); assert.equal(sent.audioMode, 'transcript')
    assert.equal(sent.audio, undefined); assert.equal(sent.text, 'Texto reconocido por Whisper local')
    assert.doesNotMatch(JSON.stringify(f.ws.sent), /never-send-raw-whisper-clip/)
    f.ws.emit({ type: 'done', ask: sent.id, text: 'Respuesta sintética' }); await running
  }
})
