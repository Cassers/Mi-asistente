import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'
import { voiceTimingStub } from './timing-fixture.mjs'

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function load(name, dependencies, globals = {}) {
  const exports = {}
  vm.runInNewContext(compile(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')), {
    exports, require: id => { assert.ok(id in dependencies, `Unexpected dependency ${id}`); return dependencies[id] }, ...globals,
  })
  return exports
}
async function directFixture({ mode: initialMode = 'command', browser = true, greeting = false, timing = voiceTimingStub() } = {}) {
  const state = { mode: initialMode }, clips = [], captions = [], notices = [], errors = [], marks = [], recognizers = []
  let vad, options, interrupts = 0, resets = 0, stopped = false, takeCount = 0
  const ready = []
  const driver = load('direct-voice', {
    '../config': { SPEECH_LANG: 'es-CO' },
    './vad': { startVad: async (h, o) => { vad = h; options = o; return { live: () => !stopped, reset() { resets++ }, stop() { stopped = true } } } },
    './voice-timing': timing,
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, name: 'Jarvis' }), wakePattern },
    './voice-input-mode': { reportVoiceInput: message => notices.push(message) },
    './utterance-audio': { markUtteranceAudio: (fresh, localSegment) => marks.push({ fresh, localSegment }), resetUtteranceAudio() { resets++ }, takeUtteranceAudio() { takeCount++; return ready.shift() } },
  }, {
    window: browser ? { SpeechRecognition: class { constructor() { recognizers.push(this) } start() { this.onstart?.() } abort() {} } } : {},
    setTimeout: () => 1, clearTimeout() {}, fetch: () => assert.fail('direct input cannot call a transcription service'),
  })
  const input = await driver.startDirectVoice({
    mode: () => state.mode, requireGreeting: () => greeting,
    onSpeechStart() { if (state.mode === 'guard') interrupts++; state.mode = 'command' },
    onWake() { state.mode = 'command' }, onPartial: text => captions.push(text), onUtterance: () => assert.fail('browser text cannot dispatch a direct question'),
    onClip(clip, trace) { clips.push({ clip, trace, chat: 'same-chat' }); state.mode = 'guard' }, onError: message => errors.push(message),
  })
  return { input, state, clips, marks, captions, notices, errors, options, diagnostics: driver.getDirectVoiceDiagnostics,
    get interrupts() { return interrupts }, get resets() { return resets }, get takeCount() { return takeCount }, get rec() { return recognizers.at(-1) },
    quiet() { vad.onQuiet() }, resume() { vad.onResume() }, boundary(reason) { vad.onBoundary(reason) },
    start() { vad.onStart() }, end(id) { if (id) ready.push({ mime: 'audio/wav', data: id }); vad.onEnd(null, 1000) },
    result(text, final = true) { this.rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] }) } }
}

test('pause sends clip1 immediately; resumed speech interrupts and pause sends clip2 with a new trace in the same chat', async () => {
  const f = await directFixture()
  assert.equal(f.options.pcmOnly, true)
  assert.equal(f.options.maxSegmentMs, 6000)
  f.start(); assert.deepEqual(f.marks[0], { fresh: false, localSegment: true })
  f.result('visual only'); assert.equal(f.clips.length, 0)
  f.end('clip1')
  assert.equal(f.clips.length, 1, 'no transcript/recognizer endpoint is awaited')
  assert.equal(f.options.guard(), true)
  f.start(); assert.equal(f.interrupts, 1)
  f.result('another visual caption'); assert.equal(f.clips.length, 1)
  f.end('clip2')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['clip1', 'clip2'])
  assert.notEqual(f.clips[0].trace, f.clips[1].trace)
  assert.deepEqual(f.clips.map(item => item.chat), ['same-chat', 'same-chat'])
  assert.deepEqual(f.captions, ['visual only', 'another visual caption'])
  f.input.stop()
})

test('wake keeps only the latest bounded segment; a delayed browser wake delivers that clip once, not its text', async () => {
  const f = await directFixture({ mode: 'wake' })
  f.start(); f.end('unaddressed'); assert.equal(f.clips.length, 0)
  f.start(); f.end('wake-and-query'); assert.equal(f.clips.length, 0)
  f.result('Jarvis explícame esto')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['wake-and-query'])
  assert.deepEqual(f.marks, [{ fresh: true, localSegment: true }, { fresh: true, localSegment: true }])
  f.result('Jarvis explícame esto'); assert.equal(f.clips.length, 1)
  f.input.stop()
})

test('wake during a live capture does not reset or prematurely dispatch its audio', async () => {
  const f = await directFixture({ mode: 'wake' })
  f.start(); f.result('Jarvis ayúdame')
  assert.equal(f.resets, 0); assert.equal(f.takeCount, 0); assert.equal(f.clips.length, 0)
  f.end('whole-audio'); assert.equal(f.clips[0].clip.data, 'whole-audio')
  f.input.stop()
})

test('unsupported or failing browser dictation leaves VAD audio usable through explicit activation', async () => {
  const unavailable = await directFixture({ mode: 'wake', browser: false })
  assert.equal(unavailable.input.live(), true); assert.match(unavailable.notices[0], /Espacio/)
  unavailable.state.mode = 'command' // explicit Space activation
  unavailable.start(); unavailable.end('without-browser')
  assert.equal(unavailable.clips.length, 1); assert.deepEqual(unavailable.errors, [])
  unavailable.input.stop()
  const failed = await directFixture()
  failed.rec.onerror({ error: 'network' })
  assert.equal(failed.input.live(), true); failed.start(); failed.end('network-down')
  assert.equal(failed.clips.length, 1); assert.deepEqual(failed.errors, [])
  failed.input.stop()
})

test('reset/mute/stop reject held clips, old browser callbacks and old segment completion', async () => {
  const f = await directFixture({ mode: 'wake' })
  f.start(); f.end('private-held')
  const staleResult = f.rec.onresult
  f.input.reset()
  staleResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Jarvis' }], { isFinal: true })] })
  assert.equal(f.clips.length, 0); assert.equal(f.state.mode, 'wake')
  f.state.mode = 'command'; f.start(); f.input.reset(); f.end()
  assert.equal(f.clips.length, 0)
  f.start(); f.state.mode = 'deaf'; f.end('muted')
  assert.equal(f.clips.length, 0)
  f.input.stop(); f.start(); f.end('stopped'); assert.equal(f.clips.length, 0)
})

test('capture failure never substitutes dictation or disables subsequent direct audio', async () => {
  const f = await directFixture(); f.start(); f.result('do not send this text'); f.end()
  assert.equal(f.clips.length, 0); assert.equal(f.errors.length, 1)
  assert.match(f.errors[0], /no se enviará el dictado/)
  f.start(); f.end('retry'); assert.equal(f.clips[0].clip.data, 'retry')
  f.input.stop()
})

test('changing voice preference restarts only the input owner; stale callbacks cannot send either mode', async () => {
  const listeners = new Set(), direct = [], transcript = [], clips = [], blocks = []
  let mode = 'direct'
  const microphone = load('microphone', {
    './voice-input-mode': { currentVoiceInputMode: () => mode, subscribeVoiceInputMode: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
    './voice-timing': voiceTimingStub(),
    './audio': { getMic: async () => ({}), startAnalyser: async () => {}, setMicBlocked: value => blocks.push(value) },
    './utterance-audio': { startUtteranceAudio: async () => {}, stopUtteranceAudio() {}, resetUtteranceAudio() {}, markUtteranceAudio() {} },
    './direct-voice': { startDirectVoice: async h => { const loop = { h, stopped: false, live: () => true, stop() { this.stopped = true } }; direct.push(loop); return loop } },
    './voice': { startVoice: async h => { const loop = { h, stopped: false, live: () => true, stop() { this.stopped = true } }; transcript.push(loop); return loop } },
  })
  const mic = microphone.createMicrophone({ mode: () => 'command', onClip: clip => clips.push(clip.data), onError: assert.fail, onUtterance: text => clips.push(text) })
  await mic.start(); direct[0].h.onClip({ mime: 'audio/wav', data: 'first' })
  mode = 'transcript'; [...listeners].forEach(fn => fn()); await flush()
  assert.equal(direct[0].stopped, true); assert.equal(transcript.length, 1)
  direct[0].h.onClip({ mime: 'audio/wav', data: 'stale' }); transcript[0].h.onUtterance('dictation')
  mode = 'direct'; [...listeners].forEach(fn => fn()); await flush()
  transcript[0].h.onUtterance('stale dictation'); direct[1].h.onClip({ mime: 'audio/wav', data: 'last' })
  assert.deepEqual(clips, ['first', 'dictation', 'last'])
  mic.stop(); assert.equal(blocks.at(-1), true); assert.equal(listeners.size, 0)
})

test('App direct wake keeps PCM intact, browser captions cannot ask, and clips use the fixed audio prompt', () => {
  const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const wanted = ['onWake', 'onUtterance', 'onClip', 'onSpeechStart'], declarations = []
  function visit(node) { if (ts.isVariableDeclaration(node) && wanted.includes(node.name.getText(ast))) declarations.push(`const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`); ts.forEachChild(node, visit) }
  visit(ast)
  const questions = [], interruptReasons = [], state = { phase: 'dormant', microphoneMuted: false, conversationPaused: true }
  state.setPhase = value => { state.phase = value }; state.setActiveTool = () => {}; state.setScreenCapture = () => {}
  state.setConversationPaused = value => { state.conversationPaused = value }; state.setError = () => {}
  const context = { currentVoiceInputMode: () => 'direct', store: { getState: () => state }, followup: { current: false },
    currentProfile: () => DEFAULT_PROFILE, sfx: { play() {}, duck() {} }, listen: () => { state.phase = 'listening' }, AWAIT_SPEECH_MS: 14000,
    voice: { current: { reset: () => assert.fail('direct wake cannot reset active PCM') } },
    markUtteranceAudio: () => assert.fail('direct wake cannot replace VAD onset'), takeUtteranceAudio: () => assert.fail('wake/caption cannot dispatch'),
    clearIdle() {}, silence() {}, turn: { current: 0 }, music: { working() {}, duck() {} },
    interrupt: reason => interruptReasons.push(reason), timingMark() {}, respond: (...args) => questions.push(args),
  }
  vm.runInNewContext(compile(declarations.join('\n') + '\nglobalThis.app = { onWake, onUtterance, onClip, onSpeechStart }'), context)
  context.app.onWake('this text stays visual'); context.app.onUtterance('never ask this')
  assert.equal(questions.length, 0); assert.equal(state.conversationPaused, false)
  const clip = { mime: 'audio/wav', data: 'audio' }; context.app.onClip(clip, 'trace')
  assert.equal(questions.length, 1); assert.equal(questions[0][0], 'Escucha el audio adjunto y responde a lo que digo.')
  assert.equal(questions[0][1], clip); assert.equal(questions[0][2], 'trace')
  state.phase = 'speaking'; context.app.onSpeechStart(); assert.deepEqual(interruptReasons, ['speech'])
  state.microphoneMuted = true; context.app.onClip(clip); assert.equal(questions.length, 1)
  state.microphoneMuted = false; state.conversationPaused = true; context.app.onClip(clip); assert.equal(questions.length, 1)
})

test('direct diagnostics distinguish PCM liveness, optional captions and segment state without retaining voice content', async () => {
  const f = await directFixture()
  assert.equal(f.diagnostics().running, true); assert.equal(f.diagnostics().captions, 'available')
  assert.equal(f.diagnostics().segment, 'idle')
  const snapshot = f.diagnostics(); snapshot.running = false; assert.equal(f.diagnostics().running, true)
  f.start(); assert.equal(f.diagnostics().segment, 'speaking')
  f.quiet(); assert.equal(f.diagnostics().segment, 'quiet')
  f.resume(); assert.equal(f.diagnostics().segment, 'speaking')
  f.result('private spoken words'); f.end('private encoded audio')
  assert.equal(f.diagnostics().segment, 'idle'); assert.equal(f.diagnostics().sent, 1); assert.equal(f.diagnostics().segments, 1)
  f.rec.onerror({ error: 'network', message: 'private provider detail' })
  assert.equal(f.diagnostics().captions, 'unavailable'); assert.equal(f.diagnostics().running, true)
  assert.doesNotMatch(JSON.stringify(f.diagnostics()), /private|spoken words|encoded|provider detail/)
  f.input.reset(); assert.equal(f.diagnostics().segment, 'idle'); assert.equal(f.diagnostics().running, true)
  f.input.stop(); assert.equal(f.diagnostics().running, false); assert.equal(f.diagnostics().captions, 'stopped')
  const noBrowser = await directFixture({ mode: 'wake', browser: false })
  assert.equal(noBrowser.diagnostics().running, true); assert.equal(noBrowser.diagnostics().captions, 'unavailable')
  noBrowser.start(); noBrowser.end('held')
  assert.equal(noBrowser.diagnostics().segment, 'held'); assert.equal(noBrowser.diagnostics().sent, 0)
  noBrowser.input.stop()
})

test('endpoint spans cancel when speech resumes, succeed at a silence boundary, and close once on reset/stop/limit', async () => {
  let now = 0, sequence = 0
  const spans = []
  const timing = load('voice-timing', { './timings': {
    newTrace: () => `trace-${++sequence}`, markTiming() {},
    startTiming(name, traceId) {
      const span = { name, traceId, at: now, ends: 0 }; spans.push(span)
      return { end(status = 'ok') { span.ends++; span.status = status; span.duration = now - span.at } }
    },
  } })
  const f = await directFixture({ timing })
  const endpoints = () => spans.filter(span => span.name === 'voice.endpoint')
  f.start(); f.quiet(); now += 200; f.resume()
  assert.equal(endpoints()[0].status, 'cancelled'); assert.equal(endpoints()[0].duration, 200)
  f.quiet(); now += 650; f.boundary('silence'); f.end('clip')
  assert.equal(endpoints()[1].status, 'ok'); assert.equal(endpoints()[1].duration, 650)
  assert.equal(endpoints()[0].traceId, endpoints()[1].traceId, 'resumed speech belongs to the same clip')
  f.start(); f.quiet(); now += 75; f.input.reset()
  assert.equal(endpoints()[2].status, 'cancelled')
  f.start(); f.quiet(); now += 50; f.boundary('limit'); f.end('limited')
  assert.equal(endpoints()[3].status, 'cancelled', 'the maximum-duration cut did not complete the silence window')
  f.start(); f.quiet(); f.input.stop()
  assert.equal(endpoints()[4].status, 'cancelled')
  for (const span of spans) assert.equal(span.ends, 1, `${span.name} leaked or ended twice`)
})


test('direct voice standby requires hola plus name after unrelated captions and retains its complete wake-and-query clip', async () => {
  const f = await directFixture({ mode: 'wake', greeting: true })
  f.start(); f.result('hablando con estudiantes'); f.result('Jarvis')
  assert.equal(f.state.mode, 'wake')
  f.result('hola Jarvis explícame esta duda')
  assert.equal(f.state.mode, 'command'); assert.equal(f.resets, 0)
  f.end('full-clip')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['full-clip'])
  f.input.stop()
})


test('an interim greeting cannot reset PCM when the delayed caption omits an already spoken question', async () => {
  const f = await directFixture({ mode: 'wake', greeting: true })
  f.start(); f.result('hola Jarvis', false)
  assert.equal(f.state.mode, 'command'); assert.equal(f.resets, 0)
  f.end('complete-question-including-prefix')
  assert.equal(f.clips.length, 0)
  f.result('hola Jarvis explícame toda la pregunta')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['complete-question-including-prefix'])
  assert.equal(f.resets, 0); f.input.stop()
})

test('a confirmed greeting alone activates input without a model call, and a late question releases the retained whole clip', async () => {
  const f = await directFixture({ mode: 'wake', greeting: true })
  f.start(); f.result('hola Jarvis')
  assert.equal(f.state.mode, 'command'); assert.equal(f.resets, 0)
  f.end('whole-utterance')
  assert.equal(f.clips.length, 0, 'activation alone must preserve the answer')
  f.result('explícame lo que acabo de decir')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['whole-utterance'])
  assert.equal(f.resets, 0); f.input.stop()
})


test('a confirmed greeting with lagging captions preserves the full prefix before continuation across a VAD boundary', async () => {
  const f = await directFixture({ mode: 'wake', greeting: true })
  f.start(); f.result('hola Jarvis', false); f.end('six-second-prefix-with-question')
  assert.equal(f.clips.length, 0)
  f.start()
  assert.deepEqual(f.clips.map(item => item.clip.data), ['six-second-prefix-with-question'])
  f.end('question-tail')
  assert.deepEqual(f.clips.map(item => item.clip.data), ['six-second-prefix-with-question', 'question-tail'])
  assert.equal(f.resets, 0); f.input.stop()
})
