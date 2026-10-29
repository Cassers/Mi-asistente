import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { timingStub } from './timing-fixture.mjs'
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

async function fixture({ select, connected = true, application = 'opencode' } = {}) {
  let project = { id: 'p1', application }, mode = 'direct', model = 'native/default', timer = 0
  const state = { autoScreen: false }
  const watchers = new Set(), sockets = [], statuses = [], text = [], queueSpans = [], storage = new Map()
  class Socket {
    static OPEN = 1; static CLOSED = 3
    readyState = 0; listeners = new Map(); sent = []
    constructor(url) { this.url = String(url); sockets.push(this) }
    addEventListener(type, fn) { const set = this.listeners.get(type) || new Set(); set.add(fn); this.listeners.set(type, set) }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    emit(message) { for (const fn of [...(this.listeners.get('message') || [])]) fn({ data: JSON.stringify(message) }) }
    open(chat = 'c1') { this.readyState = 1; this.onopen(); this.emit({ type: 'ready', servers: [project.application], conversation: { id: chat, turns: [], entries: [], title: 'fixture' } }); this.emit({ type: 'recording', recording: { active: false, controlVersion: 1 } }) }
    close() { this.readyState = 3; this.onclose?.(); for (const fn of [...(this.listeners.get('close') || [])]) fn({}) }
  }
  const timings = timingStub()
  const exports = {}
  const dependencies = {
    '../config': { BRIDGE_WS_URL: 'ws://localhost:8787' },
    '../store': { useStore: { setState: patch => Object.assign(state, patch), getState: () => state } },
    './projects': { selectedProject: () => project, subscribeProjects: fn => { watchers.add(fn); return () => watchers.delete(fn) } },
    './models': { currentModelSelection: () => select ? select() : Promise.resolve(model === 'native/default' ? {} : { model, variant: 'high' }) },
    './voice-input-mode': { currentVoiceInputMode: () => project.application === 'codex' ? 'transcript' : mode, reportVoiceInput: value => statuses.push(value) },
    './utterance-audio': { captureDiagnostics: () => ({ status: 'ready', durationMs: 6000 }) },
    './timings': { ...timings, startTiming(name, traceId) { const span = timings.startTiming(name, traceId); if (name !== 'audio.queue') return span
      const row = { traceId }; queueSpans.push(row); return { ...span, end(status = 'ok') { row.status ??= status } } } },
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, URL, WebSocket: Socket, console, location: { port: '5173' },
    setTimeout: () => ++timer, clearTimeout() {}, window: { setTimeout: () => ++timer },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    require: id => { assert.ok(id in dependencies, `Unexpected import ${id}`); return dependencies[id] },
  })
  if (connected) { const warming = exports.warmBridge(); sockets[0].open(); await warming }
  const ask = (id, audio = { mime: 'audio/wav', data: id }) => exports.ask('fixed direct instruction', { onText: delta => text.push({ id, delta }), onTool() {} }, audio, `trace-${id}`)
  return { app: exports, state, sockets, statuses, text, queueSpans, ask,
    get ws() { return sockets.at(-1) }, frames: (ws = sockets.at(-1)) => ws.sent.filter(frame => frame.type === 'ask'),
    ack(ws = sockets.at(-1)) { const stop = ws.sent.filter(frame => frame.type === 'interrupt').at(-1); assert.ok(stop); ws.emit({ type: 'interrupted', requestID: stop.requestID, status: 'ok' }); return stop },
    done(frame, ws = sockets.at(-1)) { ws.emit({ type: 'done', ask: frame.id, text: frame.preserveOnly ? '' : 'answer', status: frame.preserveOnly ? 'cancelled' : 'ok' }) },
    setMode(value) { mode = value }, setModel(value) { model = value },
    setProject(id, application = project.application) { project = { id, application }; for (const fn of watchers) fn() },
  }
}

test('three captured clips survive held selection, preserve intermediates and deliver every audio once in capture order', async () => {
  const selections = [], f = await fixture({ select: () => { const wait = deferred(); selections.push(wait); return wait.promise } })
  const one = f.ask('one'); await flush()
  f.app.interrupt('speech')
  const two = f.ask('two'); await flush()
  f.app.interrupt('speech')
  const three = f.ask('three'); await flush()
  assert.equal((await one).status, 'cancelled'); assert.equal((await two).status, 'cancelled')
  assert.equal(f.frames().length, 0); assert.equal(selections.length, 3)
  selections[2].resolve({ model: 'third' }); selections[1].resolve({ model: 'second' }); await flush()
  assert.equal(f.frames().length, 0, 'a later selection cannot overtake the first clip')
  selections[0].resolve({ model: 'first' }); await flush()
  const first = f.frames()[0]; assert.equal(first.audio.data, 'one'); assert.equal(first.preserveOnly, true)
  f.ws.emit({ type: 'text', ask: first.id, delta: 'stale TTS must stay silent' })
  f.done(first); await flush()
  const second = f.frames()[1]; assert.equal(second.audio.data, 'two'); assert.equal(second.preserveOnly, true)
  f.done(second); await flush()
  const third = f.frames()[2]; assert.equal(third.audio.data, 'three'); assert.equal(third.preserveOnly, undefined)
  assert.deepEqual(f.frames().map(frame => frame.model), ['first', 'second', 'third'])
  f.ws.emit({ type: 'text', ask: first.id, delta: 'late old answer' }); f.ws.emit({ type: 'text', ask: third.id, delta: 'latest' })
  f.done(third); assert.equal((await three).text, 'latest')
  assert.deepEqual(f.frames().map(frame => frame.audio.data), ['one', 'two', 'three'])
  assert.deepEqual(f.text, [{ id: 'three', delta: 'latest' }])
  assert.deepEqual(f.queueSpans.map(span => span.status), ['ok', 'ok', 'ok'])
})

test('clips queued behind an active native stop stay ordered; a stale done cannot settle a replacement slot', async () => {
  const f = await fixture(), one = f.ask('one'); await flush(); const first = f.frames()[0]
  f.ws.emit({ type: 'text', ask: first.id, delta: 'partial' }); f.app.interrupt('speech')
  assert.equal((await one).text, 'partial')
  const two = f.ask('two'); await flush(); f.app.interrupt('speech'); const three = f.ask('three'); await flush()
  assert.equal(f.frames().length, 1)
  const stop = f.ws.sent.find(frame => frame.type === 'interrupt')
  f.ws.emit({ type: 'interrupted', requestID: 'foreign', status: 'ok' }); await flush(); assert.equal(f.frames().length, 1)
  f.ws.emit({ type: 'interrupted', requestID: stop.requestID, status: 'ok' }); await flush()
  const second = f.frames()[1]; assert.equal(second.audio.data, 'two'); assert.equal(second.preserveOnly, true)
  f.ws.emit({ type: 'done', ask: first.id, text: 'late reply' }); await flush(); assert.equal(f.frames().length, 2)
  f.done(second); await flush(); const third = f.frames()[2]
  f.ws.emit({ type: 'done', ask: second.id, text: 'late preserved reply', status: 'cancelled' })
  f.ws.emit({ type: 'text', ask: third.id, delta: 'third reply' }); f.done(third)
  assert.equal((await two).status, 'cancelled'); assert.equal((await three).text, 'third reply')
  assert.deepEqual(f.frames().map(frame => frame.audio.data), ['one', 'two', 'three'])
})

test('speech during initial connection preserves queued clips instead of discarding them', async () => {
  const f = await fixture({ connected: false }), one = f.ask('one'); await flush()
  f.app.interrupt('speech'); const two = f.ask('two'); await flush()
  f.ws.open(); await flush(); const first = f.frames()[0]
  assert.equal(first.audio.data, 'one'); assert.equal(first.preserveOnly, true)
  f.done(first); await flush(); const second = f.frames()[1]; f.done(second)
  assert.equal((await one).status, 'cancelled'); assert.equal((await two).status, 'ok')
})

test('manual stop drops unsent audio; a new capture is independent of abandoned model selection', async () => {
  const selections = [], f = await fixture({ select: () => { const wait = deferred(); selections.push(wait); return wait.promise } })
  const one = f.ask('one'); await flush(); f.app.interrupt('speech'); const two = f.ask('two'); await flush()
  f.app.cancel('manual'); assert.equal((await one).status, 'cancelled'); assert.equal((await two).status, 'cancelled')
  const three = f.ask('three'); await flush(); f.ack(); selections[2].resolve({ model: 'new' }); await flush()
  const frame = f.frames()[0]; assert.equal(frame.audio.data, 'three'); f.done(frame); await three
  selections[0].resolve({}); selections[1].resolve({}); await flush()
  assert.deepEqual(f.frames().map(frame => frame.audio.data), ['three'])
  assert.equal(f.queueSpans[1].status, 'cancelled')
})

test('project switch detaches old queued/preparing clips and cannot send their audio to the new scope', async () => {
  const selections = [], f = await fixture({ select: () => { const wait = deferred(); selections.push(wait); return wait.promise } })
  const one = f.ask('one'); await flush(); f.app.interrupt('speech'); const two = f.ask('two'); await flush()
  const old = f.ws; f.setProject('p2'); await flush(); f.ws.open('c2'); await flush()
  assert.equal((await two).status, 'detached'); assert.equal(f.queueSpans[1].status, 'detached')
  const three = f.ask('three'); await flush(); selections[2].resolve({ model: 'p2-model' }); await flush()
  const frame = f.frames()[0]; assert.equal(frame.audio.data, 'three'); assert.match(f.ws.url, /project=p2/)
  f.done(frame); await three; selections[0].resolve({ model: 'p1-model' }); selections[1].resolve({ model: 'p1-model' }); await flush()
  await one; assert.equal(f.frames(old).length, 0); assert.deepEqual(f.frames().map(value => value.audio.data), ['three'])
})

test('chat switch drops unsent clips and snapshots mode, audio object and model choice for later captures', async () => {
  const selections = [], f = await fixture({ select: () => { const wait = deferred(); selections.push(wait); return wait.promise } })
  const one = f.ask('old'); await flush()
  const switching = f.app.chooseConversation('c2'); await flush(); f.ws.open('c2'); await switching
  assert.equal((await one).status, 'detached')
  const body = { mime: 'audio/wav', data: 'original' }, two = f.ask('new', body)
  f.setMode('transcript'); body.data = 'mutated'; selections[1].resolve({ model: 'snapshotted' }); await flush()
  const frame = f.frames()[0]; assert.equal(frame.audioMode, 'direct'); assert.equal(frame.audio.data, 'original'); assert.match(f.ws.url, /session=c2/)
  f.done(frame); await two; selections[0].resolve({}); await flush(); assert.equal(f.frames().length, 1)
})

test('scope detachment during a native stop barrier cannot poison or redirect the new project queue', async () => {
  const f = await fixture(), one = f.ask('one'); await flush(); const old = f.ws
  f.app.interrupt('speech'); const two = f.ask('two'); await flush()
  f.setProject('p2'); await flush(); f.ws.open('c2'); await flush()
  const three = f.ask('three'); await flush(); const sent = f.frames()[0]
  assert.equal(sent.audio.data, 'three'); f.done(sent)
  assert.equal((await three).status, 'ok'); assert.equal((await two).status, 'detached'); await one
  assert.deepEqual(f.frames(old).map(frame => frame.audio.data), ['one'])
  assert.ok(!f.statuses.some(message => message.startsWith('No se confirmó la entrega ordenada')))
})

test('three clips also preserve a held second selection after the first native stop ack', async () => {
  const selections = [], f = await fixture({ select: () => { const wait = deferred(); selections.push(wait); return wait.promise } })
  const one = f.ask('one'); selections[0].resolve({}); await flush(); const first = f.frames()[0]
  f.app.interrupt('speech'); const two = f.ask('two'); await flush()
  f.app.interrupt('speech'); const three = f.ask('three'); await flush()
  selections[2].resolve({ model: 'third-model' }); f.ack(); await flush()
  assert.equal(f.frames().length, 1, 'stop ack cannot bypass the second captured clip/model snapshot')
  selections[1].resolve({ model: 'second-model' }); await flush(); const second = f.frames()[1]
  assert.equal(second.audio.data, 'two'); assert.equal(second.preserveOnly, true)
  f.ws.emit({ type: 'done', ask: first.id, text: 'stale' }); f.done(second); await flush()
  const third = f.frames()[2]; assert.equal(third.audio.data, 'three'); assert.equal(third.preserveOnly, undefined)
  f.done(third); assert.equal((await one).status, 'cancelled'); assert.equal((await two).status, 'cancelled'); assert.equal((await three).status, 'ok')
  assert.deepEqual(f.frames().map(frame => frame.audio.data), ['one', 'two', 'three'])
})

test('Codex client rejects old direct clips and explicit audio overrides without sending their captions', async () => {
  const f = await fixture({ application: 'codex' })
  await assert.rejects(f.ask('old-audio-caption'), /solo dictado/)
  await assert.rejects(f.app.ask('old-audio-caption', { onText() {}, onTool() {} }, undefined, 'trace', { audioMode: 'direct' }), /solo dictado/)
  assert.equal(f.frames().length, 0)
  const text = f.app.ask('Fresh browser dictation', { onText() {}, onTool() {} }); await flush()
  assert.equal(f.frames()[0].audioMode, 'transcript'); assert.equal(f.frames()[0].audio, undefined)
  assert.equal(f.frames()[0].text, 'Fresh browser dictation'); f.done(f.frames()[0]); await text
})

test('switching to Codex detaches unsent OpenCode audio and sends only fresh dictation', async () => {
  const choice = deferred(), f = await fixture({ select: () => choice.promise })
  const old = f.ask('old-prefix'); await flush()
  f.setProject('codex-project', 'codex'); await flush(); f.ws.open('codex-chat'); await flush()
  choice.resolve({}); await flush(); assert.equal((await old).status, 'detached')
  assert.equal(f.frames().length, 0)
  const text = f.app.ask('New dictated words', { onText() {}, onTool() {} }); await flush()
  assert.equal(f.frames().length, 1); assert.equal(f.frames()[0].text, 'New dictated words')
  assert.equal(f.frames()[0].audioMode, 'transcript'); assert.equal(f.frames()[0].audio, undefined)
  f.done(f.frames()[0]); await text
})


test('screen sharing consent is revoked on every project and chat destination change', async () => {
  const f = await fixture(); f.setMode('transcript'); f.state.autoScreen = true
  const one = f.app.ask('A', { onText() {}, onTool() {} }); await flush()
  assert.equal(f.frames().at(-1).screen, true); f.done(f.frames().at(-1)); await one
  f.setProject('p2'); await flush(); f.ws.open('c2'); await flush()
  assert.equal(f.state.autoScreen, false)
  const two = f.app.ask('B', { onText() {}, onTool() {} }); await flush()
  assert.equal(f.frames().at(-1).screen, false); f.done(f.frames().at(-1)); await two
  f.state.autoScreen = true
  const change = f.app.chooseConversation('c3'); await flush(); f.ws.open('c3'); await change
  assert.equal(f.state.autoScreen, false)
  const three = f.app.ask('C', { onText() {}, onTool() {} }); await flush()
  assert.equal(f.frames().at(-1).screen, false); f.done(f.frames().at(-1)); await three
})
