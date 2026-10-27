import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'
import { voiceTimingStub } from './timing-fixture.mjs'

async function fixture(initialMode = 'command', premiumResponses, voiceOptions = {}) {
  const timers = new Map(), utterances = [], wakes = [], traces = [], partials = []
  let now = 10000, serial = 0, rec, vad, mode = initialMode, onsets = 0, spoken = '', fetches = 0
  const set = (fn, ms, interval = false) => { const id = ++serial; timers.set(id, { fn, due: now + ms, ms, interval }); return id }
  const tick = ms => {
    const target = now + ms
    for (;;) {
      const next = [...timers].filter(([,t]) => t.due <= target).sort((a,b) => a[1].due-b[1].due)[0]
      if (!next) break
      const [id,t] = next; now = t.due; timers.delete(id)
      if (t.interval) timers.set(id, { ...t, due: now + t.ms })
      t.fn()
    }
    now = target
  }
  const dependencies = { '../config': { SPEECH_LANG: 'es-CO' }, './audio': { getMic: async () => ({}) }, './tts': { speakingNow: () => spoken, speakingSince: () => 0 },
    './vad': { startVad: async handlers => { vad = handlers; return { live: () => true, meter: () => ({ speaking: false }), setGuard() {}, stop() {} } } },
    './capabilities': { caps: () => ({ stt: !!premiumResponses }) }, './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, name: 'Jarvis', configured: true }), wakePattern }, './voice-timing': voiceTimingStub() }
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: id => dependencies[id], Date: class extends Date { static now() { return now } }, performance: { now: () => now },
    fetch: async () => { fetches++; const reply = premiumResponses.shift(); return { ok: reply.ok !== false, status: reply.ok === false ? 503 : 200, json: async () => reply } },
    setTimeout: (fn, ms) => set(fn, ms), clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => set(fn, ms, true), clearInterval: id => timers.delete(id),
    window: { SpeechRecognition: class { constructor() { rec = this } start() { this.onstart() } abort() {} } },
  })
  const input = await exports.startVoice({ mode: () => mode, onAudioStart: () => onsets++, onSpeechStart: () => { mode = 'command' },
    onWake: text => { wakes.push(text); mode = 'command' }, onUtterance: (text, trace) => { utterances.push(text); traces.push(trace) }, onPartial: text => partials.push(text), onError: assert.fail }, voiceOptions)
  const result = (text, isFinal = false) => { const row = [{ transcript: text }]; row.isFinal = isFinal; rec.onresult({ resultIndex: 0, results: [row] }) }
  return { input, tick, result, utterances, wakes, traces, partials, vad, get rec() { return rec }, get fetches() { return fetches }, setMode(value) { mode = value }, setSpoken(value) { spoken = value }, onset: () => rec.onspeechstart(), end: () => rec.onspeechend(), onsets: () => onsets }
}
test('wake plus question waits for its complete endpoint rather than sending first partial', async () => {
  const f = await fixture('wake')
  f.onset(); assert.equal(f.onsets(), 1, 'wake capture begins before recognition')
  f.result('jarvis quiero que')
  f.tick(500)
  assert.deepEqual(f.wakes, [])
  f.result('jarvis quiero que conserves toda esta frase desde el principio.', true)
  f.end(); f.tick(900)
  assert.deepEqual(f.wakes, ['quiero que conserves toda esta frase desde el principio.'])
  assert.deepEqual(f.utterances, [])
  f.input.stop()
})
test('a resumed clause cancels the held dispatch, including more than six seconds of active speech', async () => {
  const f = await fixture()
  f.onset(); f.result('De todos esos nombres', true); f.end(); f.tick(900)
  f.tick(100); f.onset()
  f.tick(7000)
  assert.deepEqual(f.utterances, [], 'no in-flight speech may be dispatched by a held-text timer')
  f.result('el que más me gusta es Narya.', true); f.end(); f.tick(900)
  assert.deepEqual(f.utterances, ['De todos esos nombres el que más me gusta es Narya.'])
  f.input.stop()
})
test('Spanish unfinished clause stays together when speaker resumes after a thinking pause', async () => {
  const f = await fixture()
  f.onset(); f.result('Quiero que', true); f.end(); f.tick(900)
  f.tick(800)
  assert.deepEqual(f.utterances, [])
  f.onset(); f.result('uses el nombre Narya.', true); f.end(); f.tick(900)
  assert.deepEqual(f.utterances, ['Quiero que uses el nombre Narya.'])
  f.input.stop()
})
test('a gap between recognition updates does not send a prefix while speech is still active', async () => {
  const f = await fixture()
  f.onset(); f.result('Quiero que conserves el principio')
  f.tick(2500)
  assert.deepEqual(f.utterances, [])
  f.result('Quiero que conserves el principio y también el final.', true)
  f.end(); f.tick(900)
  assert.deepEqual(f.utterances, ['Quiero que conserves el principio y también el final.'])
  f.input.stop()
})
for (const reply of [{ text: '' }, { ok: false }]) {
  test(`a rejected premium continuation cannot strand an accepted clause (${reply.ok === false ? 'HTTP error' : 'empty'})`, async () => {
    const f = await fixture('command', [{ text: 'Quiero que' }, reply])
    const flush = async () => { for (let i=0;i<25;i++) await Promise.resolve() }
    f.vad.onStart(); f.vad.onEnd({ type: 'audio/webm' }); await flush()
    f.tick(1000); f.vad.onStart()
    f.tick(2000); assert.deepEqual(f.utterances, [])
    f.vad.onEnd({ type: 'audio/webm' }); await flush(); f.tick(1600)
    assert.deepEqual(f.utterances, ['Quiero que'])
    f.tick(10000); assert.equal(f.utterances.length, 1)
    f.input.stop()
  })
}

for (const isFinal of [false, true]) {
  test(`a stable ${isFinal ? 'final' : 'interim'} Hola dispatches by 1200ms without onspeechend`, async () => {
    const f = await fixture()
    f.onset(); f.result('Hola', isFinal)
    f.tick(899); assert.deepEqual(f.utterances, [])
    f.tick(301); assert.deepEqual(f.utterances, ['Hola'])
    assert.equal(f.traces.length, 1); assert.ok(f.traces[0])
    f.tick(10000); assert.equal(f.utterances.length, 1)
    f.input.stop()
  })
}

test('repeated identical interim greetings cannot postpone the stable-text deadline', async () => {
  const f = await fixture(); f.onset(); f.result('Hola')
  for (let i = 0; i < 10; i++) { f.tick(100); f.result('Hola') }
  f.tick(200); assert.deepEqual(f.utterances, ['Hola'])
  f.input.stop()
})

test('an interim greeting that grows into an ongoing phrase never dispatches the greeting prefix', async () => {
  const f = await fixture(); f.onset(); f.result('Hola'); f.tick(700)
  f.result('Hola quiero que conserves el principio'); f.tick(2500)
  assert.deepEqual(f.utterances, [])
  f.result('Hola quiero que conserves el principio y también el final.', true)
  f.tick(1200); assert.deepEqual(f.utterances, ['Hola quiero que conserves el principio y también el final.'])
  f.input.stop()
})

test('manual commit sends an interim once, ignores late finals from its old recognizer, and accepts the next real utterance', async () => {
  const f = await fixture(); f.onset(); f.result('Este texto aún es parcial')
  const oldResult = f.rec.onresult, oldEnd = f.rec.onend
  assert.equal(f.input.commit(), true)
  assert.deepEqual(f.utterances, ['Este texto aún es parcial'])
  assert.equal(f.input.commit(), false)
  oldResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Este texto aún es parcial.' }], { isFinal: true })] })
  oldEnd(); f.tick(5000); assert.equal(f.utterances.length, 1)
  f.onset(); f.result('Otro mensaje.', true); f.tick(1200)
  assert.deepEqual(f.utterances, ['Este texto aún es parcial', 'Otro mensaje.'])
  assert.notEqual(f.traces[0], f.traces[1])
  f.input.stop()
})

test('manual commit merges held assembler text with a resumed interim and bypasses the paused assembler', async () => {
  const f = await fixture(); f.onset(); f.result('Quiero que', true); f.end(); f.tick(900)
  f.onset(); f.result('uses este nombre'); f.tick(2500)
  assert.deepEqual(f.utterances, [])
  assert.equal(f.input.commit(), true)
  assert.deepEqual(f.utterances, ['Quiero que uses este nombre'])
  f.tick(10000); assert.equal(f.utterances.length, 1); f.input.stop()
})

test('commit does not turn statuses, echoes, wake-only text, muted text or reset/stopped callbacks into questions', async () => {
  const f = await fixture()
  f.partials.push('Escuchando…')
  assert.equal(f.input.commit(), false)
  f.onset(); f.result('mensaje privado'); const oldResult = f.rec.onresult
  f.setMode('deaf'); assert.equal(f.input.commit(), false)
  f.input.reset(); f.setMode('command'); assert.equal(f.input.commit(), false)
  oldResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'late private result' }], { isFinal: true })] })
  f.tick(3000); assert.deepEqual(f.utterances, [])
  f.setMode('wake'); f.onset(); f.result('charla cualquiera'); assert.equal(f.input.commit(), false)
  f.input.reset(); f.setMode('command')
  f.onset(); f.result('palabras distintivas del altavoz')
  f.setSpoken('palabras distintivas del altavoz'); assert.equal(f.input.commit(), false)
  f.input.stop(); assert.equal(f.input.commit(), false); assert.equal(f.input.live(), false)
  f.tick(3000); assert.deepEqual(f.utterances, [])
})

test('duplicate final events do not repeat text or cancel a stable final deadline', async () => {
  const f = await fixture(); f.onset(); f.result('Hola', true); f.tick(100)
  f.result('Hola', true); f.tick(1100)
  assert.deepEqual(f.utterances, ['Hola'])
  f.input.stop()
})

for (const text of ['Hola cómo vas', 'Hola cómo estás', 'Hola, ¿cómo estás?']) {
  test(`strict complete interim greeting ${text} closes without final/speechend`, async () => {
    const f = await fixture(); f.onset(); f.result(text); f.tick(1200)
    assert.deepEqual(f.utterances, [text]); f.input.stop()
  })
}

test('a final update for the same provisional greeting preserves its original stable deadline', async () => {
  const f = await fixture(); f.onset(); f.result('Hola'); f.tick(1000)
  f.result('Hola', true); f.tick(200)
  assert.deepEqual(f.utterances, ['Hola']); f.input.stop()
})

test('explicit browser-only dictation ignores configured premium STT and retains manual commit', async () => {
  const f = await fixture('command', [{ text: 'remote speech must not run' }], { browserOnly: true })
  assert.ok(f.rec); assert.equal(f.vad, undefined)
  f.onset(); f.result('texto provisional')
  assert.equal(f.input.commit(), true)
  assert.deepEqual(f.utterances, ['texto provisional'])
  f.tick(3000); assert.equal(f.fetches, 0)
  f.input.stop()
})

test('multiple final indices join with word separators in a single result event', async () => {
  const f = await fixture(); f.onset()
  const row = text => Object.assign([{ transcript: text }], { isFinal: true })
  f.rec.onresult({ resultIndex: 0, results: [row('Quiero conservar el'), row('principio y el final.')] })
  f.tick(1200)
  assert.deepEqual(f.utterances, ['Quiero conservar el principio y el final.'])
  f.input.stop()
})

test('separate final updates join settled and fresh words without dropping or repeating either segment', async () => {
  const f = await fixture(); f.onset()
  const first = Object.assign([{ transcript: 'Quiero conservar el' }], { isFinal: true })
  const second = Object.assign([{ transcript: 'principio y el final.' }], { isFinal: true })
  f.rec.onresult({ resultIndex: 0, results: [first] }); f.tick(200)
  f.rec.onresult({ resultIndex: 1, results: [first, second] }); f.tick(1200)
  assert.deepEqual(f.utterances, ['Quiero conservar el principio y el final.'])
  f.input.stop()
})
