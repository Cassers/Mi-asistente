import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function clock() {
  let now = 10000, serial = 0
  const timers = new Map()
  const add = (fn, ms = 0, interval = false) => { const id = ++serial; timers.set(id, { fn, at: now + ms, ms, interval }); return id }
  return {
    get now() { return now },
    globals: { Date: class extends Date { static now() { return now } }, performance: { now: () => now },
      setTimeout: (fn, ms) => add(fn, ms), clearTimeout: id => timers.delete(id),
      setInterval: (fn, ms) => add(fn, ms, true), clearInterval: id => timers.delete(id) },
    tick(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, t] = due; now = t.at; timers.delete(id)
        if (t.interval) timers.set(id, { ...t, at: now + t.ms })
        t.fn()
      }
      now = target
    },
  }
}
function load(name, dependencies = {}, globals = {}) {
  if (name === 'microphone') dependencies = {
    './voice-input-mode': { currentVoiceInputMode: () => 'transcript', subscribeVoiceInputMode: () => () => {} },
    './direct-voice': {}, ...dependencies,
  }
  const exports = {}
  vm.runInNewContext(compile(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')), {
    exports, console: { error() {}, warn() {} }, DOMException,
    require: id => { assert.ok(id in dependencies, `Unexpected import ${id} in ${name}`); return dependencies[id] },
    ...globals,
  })
  return exports
}
function collector(c) {
  let sequence = 0
  const rows = []
  const api = {
    newTrace: () => `trace-${++sequence}`,
    startTiming(name, traceId) {
      const row = { name, traceId, start: c.now, ends: 0 }; rows.push(row)
      return { traceId, id: `span-${++sequence}`, end(status = 'ok') { row.ends++; assert.equal(row.ends, 1); row.status = status; row.end = c.now } }
    },
    markTiming(name, traceId) { const span = api.startTiming(name, traceId); span.end() },
  }
  return { api, rows, timing: load('voice-timing', { './timings': api }),
    named: name => rows.filter(row => row.name === name),
    closed: () => { for (const row of rows) assert.equal(row.ends, 1, `${row.name}/${row.traceId} leaked`) } }
}
async function voiceFixture({ premium = false, fetch, greeting = false } = {}) {
  const c = clock(), metrics = collector(c), recognizers = [], heard = [], wakes = []
  let mode = 'command', vad
  const voice = load('voice', {
    '../config': { SPEECH_LANG: 'es-CO', BRIDGE_HTTP_URL: 'http://fixture' },
    './voice-timing': metrics.timing, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, name: 'Jarvis', configured: true }), wakePattern },
    './capabilities': { caps: () => ({ stt: premium }) },
    './vad': { startVad: async h => { vad = h; return { live: () => true, meter: () => ({ speaking: false }), stop() {}, setGuard() {} } } },
  }, { ...c.globals, fetch, window: { SpeechRecognition: class { constructor() { recognizers.push(this) } start() { this.onstart() } abort() {} } } })
  let input
  input = await voice.startVoice({ mode: () => mode, requireGreeting: () => greeting, onPartial() {}, onSpeechStart() {}, onError() {},
    onUtterance: (text, trace) => heard.push({ text, trace }), onWake: (text, trace) => { wakes.push({ text, trace }); input.reset() } })
  return { c, ...metrics, input, heard, wakes, get rec() { return recognizers.at(-1) }, get vad() { return vad }, setMode(value) { mode = value },
    result(text) { this.rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }) } }
}
function speakerFixture({ engine = 'system', synthesis, api } = {}) {
  const c = clock(), metrics = collector(c), utterances = [], audios = []
  const timing = api ? load('voice-timing', { './timings': api }) : metrics.timing
  const tts = load('tts', {
    '../config': { env: {}, TTS_ENGINE: engine, USE_ELEVENLABS: false, BACKEND: 'bridge', SPEECH_LANG: 'es-CO' },
    './voice-timing': timing, './kokoro': { isUnavailable: () => false, speak: synthesis },
    './capabilities': { caps: () => ({ tts: false }) }, './profile': { currentProfile: () => DEFAULT_PROFILE },
    './speech-settings': { currentSpeechRate: () => 1.2 }, './speech-text': load('speech-text'),
  }, { ...c.globals, window: {}, localStorage: { getItem: () => null },
    speechSynthesis: { addEventListener() {}, getVoices: () => [], resume() {}, pause() {}, cancel() {}, speak: u => utterances.push(u) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    Audio: class { constructor(url) { this.url = url; audios.push(this) } play() { return Promise.resolve() } pause() { this.onpause?.() } },
    URL: { revokeObjectURL() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  })
  return { c, ...metrics, ...tts, utterances, audios }
}

test('coordinator retires dispatched inputs, late completions cannot close a new trace, telemetry failures are inert', () => {
  const c = clock(), f = collector(c), owner = f.timing.createVoiceTiming()
  owner.onset(); const oldDone = owner.recognizing(); c.tick(4); owner.assembling()
  const first = owner.dispatch(); owner.cancel()
  owner.onset(); const nextDone = owner.recognizing(); oldDone('error')
  assert.equal(f.named('voice.recognition').at(-1).ends, 0)
  nextDone(); const second = owner.dispatch()
  assert.notEqual(first, second); f.closed()
  const broken = load('voice-timing', { './timings': { newTrace() { throw Error() }, startTiming() { throw Error() }, markTiming() { throw Error() } } })
  assert.doesNotThrow(() => { const owner = broken.createVoiceTiming(); owner.onset(); owner.recognizing()(); owner.endpoint(); owner.assembling(); owner.mark('voice.interruption'); owner.dispatch(); owner.cancel() })
  let calls = 0
  const throwingEnd = load('voice-timing', { './timings': { startTiming: () => ({ end() { calls++; throw Error() } }) } })
  const span = throwingEnd.timingSpan('turn.total', 'trace'); span.end(); span.end('error'); assert.equal(calls, 1)
})

test('browser utterances retain onset/endpoint/assembly correlation and every emitted utterance has its own trace', async () => {
  const f = await voiceFixture()
  for (const text of ['Primera pregunta.', 'Segunda pregunta.']) {
    f.rec.onspeechstart(); f.c.tick(40); f.result(text); f.c.tick(20); f.rec.onspeechend(); f.c.tick(900)
  }
  assert.equal(f.heard.length, 2); assert.notEqual(f.heard[0].trace, f.heard[1].trace)
  for (const { trace } of f.heard) {
    for (const name of ['voice.input', 'voice.recognition', 'voice.endpoint', 'voice.assembly']) assert.ok(f.named(name).some(row => row.traceId === trace && row.status === 'ok'), name)
  }
  f.input.stop(); f.closed()
})

test('complete wake trailing reset retires trace before callback; no-speech, held reset and stop leak nothing', async () => {
  const f = await voiceFixture(); f.setMode('wake')
  f.rec.onspeechstart(); f.result('Jarvis explícame esto')
  assert.equal(f.wakes.length, 0)
  f.rec.onspeechend(); f.c.tick(900)
  assert.equal(f.wakes.length, 1)
  assert.ok(f.wakes[0].trace)
  assert.equal(f.named('voice.input')[0].status, 'ok')
  f.setMode('command'); f.rec.onspeechstart(); f.rec.onerror({ error: 'no-speech' })
  assert.equal(f.named('voice.input').at(-1).status, 'cancelled')
  f.rec.onspeechstart(); f.result('quiero ir to'); f.rec.onspeechend(); f.c.tick(900)
  f.input.reset(); f.c.tick(2000)
  assert.equal(f.heard.length, 0)
  f.rec.onspeechstart(); f.input.stop(); f.closed()
})

test('premium delayed transcription/reset cannot leak or reuse its trace; recognition errors close explicitly', async () => {
  const pending = deferred(); let calls = 0
  const f = await voiceFixture({ premium: true, fetch: () => ++calls === 1 ? pending.promise : Promise.resolve({ ok: true, json: async () => ({ text: 'Pregunta nueva.' }) }) })
  f.vad.onStart(); f.vad.onEnd({ type: 'audio/webm' }); f.input.reset()
  pending.resolve({ ok: true, json: async () => ({ text: 'Pregunta vieja.' }) }); await flush()
  assert.equal(f.heard.length, 0)
  f.vad.onStart(); f.vad.onEnd({ type: 'audio/webm' }); await flush()
  assert.equal(f.heard.length, 1)
  assert.notEqual(f.named('voice.input')[0].traceId, f.heard[0].trace)
  f.input.stop(); f.closed()
  const failed = await voiceFixture({ premium: true, fetch: async () => ({ ok: false, status: 503 }) })
  failed.vad.onStart(); failed.vad.onEnd({}); await flush(); failed.input.stop(); failed.closed()
  assert.equal(failed.named('voice.recognition')[0].status, 'error')
  assert.equal(failed.named('voice.input')[0].status, 'error')
})

test('native first audio measures first pushed text to actual answer onstart; filler never closes it', async () => {
  const f = speakerFixture(); let audible = 0
  const spk = f.createSpeaker('answer', () => audible++)
  spk.say('Relleno.'); spk.push('Respuesta. ')
  assert.equal(f.named('tts.first_audio')[0].ends, 0)
  f.c.tick(100); f.utterances[0].onstart(); assert.equal(audible, 0)
  f.utterances[0].onend(); await flush()
  assert.equal(f.named('tts.first_audio')[0].ends, 0)
  f.c.tick(150); f.utterances[1].onstart(); assert.equal(audible, 1)
  assert.equal(f.named('tts.first_audio')[0].end - f.named('tts.first_audio')[0].start, 250)
  const ending = spk.end(); await flush(); assert.equal(f.named('tts.total')[0].ends, 0)
  f.c.tick(200); f.utterances[1].onend(); await ending; f.closed()
  assert.equal(f.named('tts.playback')[0].end - f.named('tts.playback')[0].start, 200)
  assert.equal(f.named('tts.synthesis').length, 0, 'native API exposes no separate synthesis stage')
})

test('generated audio distinguishes synthesis, element queue and actual playing; callback failures do not affect speech', async () => {
  const pending = deferred(), f = speakerFixture({ engine: 'kokoro', synthesis: () => pending.promise })
  const spk = f.createSpeaker('generated', () => { throw Error('observer') }); spk.push('Respuesta. ')
  f.c.tick(80); assert.equal(f.audios.length, 0); pending.resolve('blob:fake'); await flush()
  assert.equal(f.named('tts.synthesis')[0].end - f.named('tts.synthesis')[0].start, 80)
  assert.equal(f.named('tts.first_audio')[0].ends, 0)
  f.c.tick(20); f.audios[0].onplaying(); const ending = spk.end()
  f.c.tick(300); f.audios[0].onended(); await ending; f.closed()
  assert.equal(f.named('tts.first_audio')[0].end - f.named('tts.first_audio')[0].start, 100)
  assert.equal(f.named('tts.playback')[0].end - f.named('tts.playback')[0].start, 300)
})

test('cancel while synthesis is pending closes once; late results/onstart cannot fabricate first audio or close a newer speaker', async () => {
  const pending = deferred(), f = speakerFixture({ engine: 'kokoro', synthesis: () => pending.promise })
  let audible = 0
  const old = f.createSpeaker('old', () => audible++); old.push('Anterior. ')
  const ending = old.end(); old.cancel(); await ending
  assert.equal(f.named('tts.first_audio')[0].status, 'cancelled'); f.closed()
  pending.resolve('blob:old'); await flush(); assert.equal(f.audios.length, 0); assert.equal(audible, 0)
  const native = speakerFixture(), one = native.createSpeaker('one'), two = native.createSpeaker('two')
  one.push('Uno. '); one.cancel(); two.push('Dos. ')
  native.utterances[0].onstart(); assert.equal(native.named('tts.first_audio')[1].ends, 0)
  native.utterances[1].onstart(); const done = two.end(); native.utterances[1].onend(); await done; native.closed()
})

test('native errors, no-start timeout, synthesis fallback and empty filtered answers have explicit outcomes', async () => {
  const failure = speakerFixture(), broken = failure.createSpeaker('failure'); broken.push('Error. ')
  const failed = broken.end(); failure.utterances[0].onerror({ error: 'synthesis-failed' }); await failed; failure.closed()
  assert.equal(failure.named('tts.first_audio')[0].status, 'error')
  assert.equal(failure.named('tts.total')[0].status, 'error')
  const timeout = speakerFixture(), waiting = timeout.createSpeaker('timeout'); waiting.push('Espera. ')
  const timed = waiting.end(); timeout.c.tick(2200); await timed; timeout.closed()
  assert.equal(timeout.named('tts.first_audio')[0].status, 'timeout')
  const fallback = speakerFixture({ engine: 'kokoro', synthesis: async () => null }), spk = fallback.createSpeaker('fallback')
  spk.push('Alternativa. '); await flush(); fallback.utterances[0].onstart(); const ended = spk.end(); fallback.utterances[0].onend(); await ended
  fallback.closed(); assert.equal(fallback.named('tts.synthesis')[0].status, 'fallback'); assert.equal(fallback.named('tts.total')[0].status, 'fallback')
  const empty = speakerFixture(), filtered = empty.createSpeaker('empty'); filtered.push('```js\nsecret()\n```'); await filtered.end(); empty.closed()
  assert.equal(empty.named('tts.first_audio')[0].status, 'cancelled')
})

// Execute real App handlers, extracted by syntax tree, with fake I/O only.
function appFixture() {
  const f = speakerFixture(), requests = [], state = { phase: 'listening', microphoneActive: true, microphoneStandby: false, microphoneMuted: false, conversationPaused: false }
  const sourceText = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('App.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const wanted = ['respond', 'silence', 'onSpeechStart', 'onWake', 'onUtterance', 'toggleMicrophone', 'pauseHistoryForPrivacy', 'sendTextMessage', 'replayResponse']
  const declarations = []
  function visit(node) { if (ts.isVariableDeclaration(node) && wanted.includes(node.name.getText(ast))) declarations.push(`const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`); ts.forEachChild(node, visit) }
  visit(ast)
  for (const method of ['clearPanels', 'clearBlades', 'pushTurn', 'appendToLastTurn', 'setLevel']) state[method] = () => {}
  for (const [method, key] of [['setPhase','phase'], ['setError','error'], ['setCaption','caption'], ['setConversationPaused','conversationPaused'], ['setMicrophoneMuted','microphoneMuted'], ['setMicrophoneActive','microphoneActive'], ['setMicrophoneStandby','microphoneStandby'], ['setMicrophoneBusy','microphoneBusy'], ['setActiveTool','tool'], ['setScreenCapture','screen']]) state[method] = value => { state[key] = value }
  const context = { currentVoiceInputMode: () => 'transcript', ...f.timing, ...f.c.globals, store: { getState: () => state }, console: { error() {} },
    turn: { current: 0 }, history: { current: [] }, activeTurnTiming: { current: null }, followup: { current: false }, speaker: { current: null },
    voice: { current: { reset() {}, stop() {} } }, takeUtteranceAudio: () => undefined, markUtteranceAudio() {},
    captureDiagnostics: () => ({ status: 'missing', durationMs: 0 }),
    projectMode: () => false, selectedProject: () => null, conversationSnapshot: () => ({ chat: null }), conversationRevision: () => 0, warm: async () => {}, currentProfile: () => DEFAULT_PROFILE, wakePattern, AWAIT_SPEECH_MS: 14000,
    usingBridge: true, refreshProfile: async () => {}, clearIdle() {}, listen() {}, FOLLOW_UP_MS: 11000,
    createSpeaker: f.createSpeaker, newId: () => 'id', music: { duck() {}, working() {} }, sfx: { duck() {}, play() {}, unlockAudio: async () => {} },
    interrupt() {}, setMicBlocked() {}, setRecordingActive: async () => {}, attention: () => 'Hola.', forTool: () => 'Relleno.',
    ask: (said, _history, handlers, clip, trace, options) => { const pending = deferred(); requests.push({ ...pending, handlers, trace, said, clip, options }); return pending.promise },
  }
  vm.runInNewContext(compile(declarations.join('\n') + `\nglobalThis.app = { ${wanted.join(',')} };`), context)
  return { ...f, ...context.app, state, requests, context }
}

test('App turn first audio starts at dispatch, ends at answer audio; turn total waits for own TTS end even with mic off', async () => {
  const f = appFixture(), running = f.respond('Private prompt', undefined, 'turn')
  assert.equal(f.named('turn.total')[0].start, f.c.now)
  assert.equal(f.requests[0].trace, 'turn')
  f.c.tick(40); f.requests[0].handlers.onTool('private tool'); f.utterances[0].onstart(); f.utterances[0].onend(); await flush()
  assert.equal(f.named('turn.first_audio')[0].ends, 0)
  f.c.tick(60); f.requests[0].handlers.onText('Respuesta. ')
  assert.equal(f.named('tts.first_audio')[0].start - f.named('turn.first_audio')[0].start, 100)
  f.c.tick(50); f.utterances[1].onstart()
  assert.equal(f.named('turn.first_audio')[0].end - f.named('turn.first_audio')[0].start, 150)
  f.requests[0].resolve({ text: 'Respuesta.' }); await flush()
  await f.toggleMicrophone()
  assert.equal(f.named('turn.total')[0].ends, 0, 'input OFF cannot cancel the output turn')
  f.c.tick(400); f.utterances[1].onend(); await running; f.closed()
  assert.equal(f.named('turn.total')[0].status, 'ok'); assert.equal(f.named('turn.total')[0].end, f.c.now)
  assert.doesNotMatch(JSON.stringify(f.rows), /Private prompt|private tool|Respuesta/)
})

test('App barge-in cancels old total and first audio; stale turn completion cannot finish replacement', async () => {
  const f = appFixture(), old = f.respond('old', undefined, 'old')
  f.onSpeechStart()
  assert.equal(f.named('turn.total')[0].status, 'cancelled')
  assert.equal(f.named('turn.first_audio')[0].status, 'cancelled')
  const next = f.respond('next', undefined, 'next')
  f.requests[0].resolve({ text: 'old' }); await old
  assert.equal(f.named('turn.total')[1].ends, 0)
  f.requests[1].resolve({ text: '' }); await next; f.closed()
  assert.equal(f.named('turn.first_audio')[1].status, 'cancelled')
})

test('App errors observe already queued audio without flushing buffered prose and close turn after playback', async () => {
  const f = appFixture(), running = f.respond('question', undefined, 'error')
  f.requests[0].handlers.onText('Complete sentence. '); f.utterances[0].onstart()
  f.requests[0].handlers.onText('Incomplete prose')
  f.requests[0].reject(Error('failure')); await running
  assert.equal(f.named('turn.total')[0].ends, 0)
  f.utterances[0].onend(); await flush(); f.closed()
  assert.equal(f.named('turn.total')[0].status, 'error'); assert.equal(f.utterances.length, 1)
})

test('microphone activation spans close on success, failure and mute while startup is pending', async () => {
  const c = clock(), f = collector(c), callbacks = [], pending = [], stopped = []
  const micModule = load('microphone', {
    './voice-timing': f.timing,
    './audio': { setMicBlocked() {}, getMic: async () => ({}), startAnalyser: async () => {} },
    './utterance-audio': { startUtteranceAudio: async () => {}, stopUtteranceAudio() {}, resetUtteranceAudio() {}, markUtteranceAudio() {} },
    './voice': { startVoice: h => { callbacks.push(h); const wait = deferred(); pending.push(wait); return wait.promise } },
  })
  const mic = micModule.createMicrophone({ mode: () => 'command', onError() {} })
  const input = () => ({ stop() { stopped.push(true) }, live: () => true })
  const first = mic.start(); await flush(); c.tick(20); pending[0].resolve(input()); assert.equal(await first, true)
  assert.equal(f.named('voice.activation')[0].status, 'ok')
  const second = mic.start(); await flush(); mic.stop(); pending[1].resolve(input()); assert.equal(await second, false)
  assert.equal(f.named('voice.activation')[1].status, 'cancelled')
  const third = mic.start(); await flush(); callbacks[2].onError('fake failure'); pending[2].resolve(input()); assert.equal(await third, false)
  assert.equal(f.named('voice.activation')[2].status, 'error'); f.closed()
  assert.equal(stopped.length, 3)
})

test('App total and missing first audio reflect an unusable TTS engine', async () => {
  const f = appFixture(), running = f.respond('question', undefined, 'silent')
  f.requests[0].handlers.onText('Una frase. ')
  f.requests[0].resolve({ text: 'Una frase.' }); await flush()
  f.utterances[0].onerror({ error: 'synthesis-failed' }); await running; f.closed()
  assert.equal(f.named('turn.total')[0].status, 'error')
  assert.equal(f.named('turn.first_audio')[0].status, 'error')
})

test('App preserves partial text and playback from a cancelled native result while excluding its total from healthy turns', async () => {
  const f = appFixture(), displayed = []
  f.state.appendToLastTurn = text => displayed.push(text)
  const running = f.respond('question', undefined, 'native-aborted')
  f.requests[0].handlers.onText('Respuesta parcial. ')
  f.requests[0].resolve({ text: 'Respuesta parcial. ', status: 'cancelled' })
  await flush()
  assert.deepEqual(displayed, ['Respuesta parcial. '])
  assert.equal(f.utterances.length, 1)
  assert.equal(f.utterances[0].text, 'Respuesta parcial.')
  assert.equal(f.named('turn.total')[0].ends, 0, 'cancelled result still waits for its existing playback')
  f.utterances[0].onstart(); f.c.tick(150); f.utterances[0].onend()
  await running; f.closed()
  assert.equal(f.named('turn.total')[0].status, 'cancelled')
  assert.equal(f.named('turn.total')[0].end, f.c.now)
  assert.equal(f.named('tts.playback')[0].status, 'ok', 'actual partial audio playback is preserved')
})


test('typing before microphone activation submits text immediately, acknowledges before answer, and never reads captured audio', async () => {
  const f = appFixture()
  f.state.phase = 'offline'; f.state.microphoneActive = false; f.state.microphoneMuted = true
  f.context.takeUtteranceAudio = () => assert.fail('typing must not consume recorded audio')
  f.context.captureDiagnostics = () => assert.fail('typing must not measure a previous audio clip')
  f.context.voice.current.start = () => assert.fail('typing must not activate input')
  f.context.currentVoiceInputMode = () => 'direct'
  const accepted = f.sendTextMessage('  Pregunta escrita  ')
  await flush()
  assert.equal(f.requests.length, 1)
  const request = f.requests[0]
  assert.equal(request.said, 'Pregunta escrita'); assert.equal(request.clip, undefined)
  assert.equal(request.options.audioMode, 'transcript')
  assert.equal(f.state.microphoneMuted, true); assert.equal(f.state.microphoneActive, false)
  request.handlers.onSubmitted()
  assert.equal(await accepted, true, 'composer can clear on receipt before model response')
  request.resolve({ text: '' }); await flush()
  assert.equal(f.state.phase, 'dormant')
})

test('typing retains its draft when connection fails or the project changes while connecting', async () => {
  const failed = appFixture(); failed.context.warm = async () => { throw Error('offline') }
  assert.equal(await failed.sendTextMessage('No perder'), false); assert.equal(failed.requests.length, 0)
  const f = appFixture(), connection = deferred()
  let project = { id: 'one' }; f.context.selectedProject = () => project
  f.context.warm = () => connection.promise
  const sent = f.sendTextMessage('No enviar al otro proyecto')
  project = { id: 'two' }; connection.resolve()
  assert.equal(await sent, false); assert.equal(f.requests.length, 0)
})

test('replaying an old answer uses only TTS and keeps microphone hard off', async () => {
  const f = appFixture()
  f.state.phase = 'dormant'; f.state.microphoneActive = false; f.state.microphoneMuted = true
  f.replayResponse('Respuesta guardada.')
  assert.equal(f.requests.length, 0); assert.equal(f.state.phase, 'speaking')
  assert.equal(f.utterances[0].text, 'Respuesta guardada.')
  f.utterances[0].onstart(); f.utterances[0].onend(); await flush()
  assert.equal(f.state.phase, 'dormant'); assert.equal(f.state.microphoneMuted, true)
  assert.equal(f.state.microphoneActive, false)
})

test('browser wake standby accepts hola-name after classroom speech, but rejects name alone', async () => {
  const f = await voiceFixture({ greeting: true }); f.setMode('wake')
  f.result('conversación con estudiantes'); f.result('Jarvis')
  assert.equal(f.wakes.length, 0)
  f.result('hola Jarvis'); f.c.tick(2000)
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].text, '')
  f.input.stop(); f.closed()
})


test('a pending text send cannot move from an opening chat to a different chat with the same null snapshot', async () => {
  const f = appFixture(), connection = deferred()
  let revision = 7
  f.context.warm = () => connection.promise
  f.context.conversationRevision = () => revision
  const sending = f.sendTextMessage('Conservar en el destino original')
  revision++ // another chat starts opening while both snapshots are null
  connection.resolve()
  assert.equal(await sending, false)
  assert.equal(f.requests.length, 0)
})

test('a cold native chat that has not reached ready cannot consume or dispatch the typed draft', async () => {
  const f = appFixture()
  f.context.projectMode = () => true
  f.context.selectedProject = () => ({ id: 'codex-project' })
  f.context.conversationSnapshot = () => ({ chat: null })
  assert.equal(await f.sendTextMessage('Conservar hasta que cargue el chat'), false)
  assert.equal(f.requests.length, 0)
  assert.match(f.state.error, /se está abriendo/)
})
