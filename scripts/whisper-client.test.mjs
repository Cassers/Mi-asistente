import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'
import { voiceTimingStub } from './timing-fixture.mjs'

const compile = name => ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
function load(name, dependencies, globals = {}) {
  const exports = {}
  vm.runInNewContext(compile(name), { exports, Blob, Error, DOMException, AbortController, AbortSignal, console,
    require: id => { assert.ok(id in dependencies, 'unexpected import ' + id); return dependencies[id] }, ...globals })
  return exports
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const caps = { engine: 'whisper', available: true, model: 'synthetic-large', maxBytes: 4096, maxSeconds: 120, formats: ['audio/wav','audio/webm','audio/mpeg','audio/mp4','audio/ogg'] }
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
function client(fetch) {
  return load('whisper', { react: { useEffect() {}, useSyncExternalStore: (_, read) => read() },
    '../config': { BACKEND: 'bridge', BRIDGE_HTTP_URL: 'http://synthetic.local' } }, { fetch })
}

test('Whisper discovers its own capabilities, sends original Blob to its unique local endpoint and returns complete text', async () => {
  const calls = [], transcript = 'Transcripción sintética completa. '.repeat(70)
  const c = client(async (url, options) => { calls.push([url, options]); return response(url.endsWith('/whisper') ? caps : { engine: 'whisper', text: transcript }) })
  const audio = new Blob(['synthetic encoded audio'], { type: 'audio/webm;codecs=opus' })
  const first = c.refreshWhisper(), second = c.refreshWhisper()
  assert.equal(first, second); await first
  assert.equal(c.useWhisperCapabilities().state, 'ready')
  assert.equal(await c.transcribeWhisper(audio), transcript.trim())
  assert.equal(calls.length, 2)
  const [url, options] = calls[1]
  assert.equal(url, 'http://synthetic.local/whisper/transcribe?language=auto')
  assert.equal(options.method, 'POST'); assert.equal(options.body, audio)
  assert.equal(options.headers['content-type'], 'audio/webm;codecs=opus')
  assert.equal(options.redirect, 'error')
  assert.ok(calls.every(([url]) => !url.includes('/stt')))
})

test('unavailable, rejected, empty and malformed Whisper results fail explicitly without fallback', async () => {
  for (const failure of [response({ error: 'Synthetic hard error' }, 503), response({ engine: 'whisper', text: '' }), response({ text: 'Wrong engine' })]) {
    const calls = []
    const c = client(async url => { calls.push(url); return url.endsWith('/whisper') ? response(caps) : failure })
    await assert.rejects(c.transcribeWhisper(new Blob(['fixture'], { type: 'audio/wav' })))
    assert.equal(calls.length, 2); assert.ok(calls.every(url => url.includes('/whisper')))
  }
  const calls = [], c = client(async url => { calls.push(url); return response({ ...caps, available: false, reason: 'Synthetic model missing' }) })
  await assert.rejects(c.transcribeWhisper(new Blob(['fixture'], { type: 'audio/wav' })), /Synthetic model missing/)
  assert.equal(calls.length, 1)
})

test('file validation uses service limits/formats and MIME; invalid inputs never start a transcription', async () => {
  const c = client(() => assert.fail('validation must not fetch'))
  assert.equal(c.validateWhisperAudio(new Blob(['x']), caps, 'example.wav'), 'audio/wav')
  assert.equal(c.validateWhisperAudio(new Blob(['x'], { type: 'audio/wav' }), caps, 'name.txt'), 'audio/wav')
  assert.throws(() => c.validateWhisperAudio(new Blob([]), caps, 'empty.wav'), /vacío/)
  assert.throws(() => c.validateWhisperAudio(new Blob(['x'.repeat(4097)], { type: 'audio/wav' }), caps), /límite/)
  assert.throws(() => c.validateWhisperAudio(new Blob(['text'], { type: 'text/plain' }), caps, 'fake.wav'), /Formato/)
  await assert.rejects(c.transcribeWhisper(new Blob(['x'], { type: 'audio/wav' }), { capabilities: caps, language: '../bad' }), /Idioma/)
})

test('scope invalidation aborts pending audio and rejects a late response even when fetch ignores AbortSignal', async () => {
  const pending = deferred(); let signal
  const c = client(async (url, options) => {
    if (url.endsWith('/whisper')) return response(caps)
    signal = options.signal; return pending.promise
  })
  const result = c.transcribeWhisper(new Blob(['x'], { type: 'audio/wav' }))
  const rejection = assert.rejects(result, error => error.name === 'AbortError')
  await flush(); c.invalidateWhisper()
  assert.equal(signal.aborted, true)
  pending.resolve(response({ engine: 'whisper', text: 'stale transcript must not appear' }))
  await rejection
})

test('synchronous project/chat/mode/disconnect boundaries cancel clips; initial chat readiness is not a destination change', () => {
  const c = client(() => assert.fail('scope tests must not fetch'))
  let state = { destination: 'project:claude:0:whisper', chat: undefined, connected: false }, cancelled = 0
  const listeners = new Set()
  const stop = c.bindWhisperScope(() => state, [fn => { listeners.add(fn); return () => listeners.delete(fn) }], () => cancelled++)
  const update = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
  update({ chat: 'first', connected: true }); assert.equal(cancelled, 0)
  for (const patch of [{ destination: 'project:claude:1:whisper', chat: undefined }, { chat: 'second' },
    { chat: 'third' }, { destination: 'project:claude:1:transcript' }, { connected: false },
    { destination: 'other:antigravity:2:whisper', chat: undefined }]) update(patch)
  assert.equal(cancelled, 5)
  stop(); assert.equal(listeners.size, 0)
})

async function liveFixture(initial = 'command') {
  const requests = [], utterances = [], wakes = [], errors = [], timers = new Map()
  let mode = initial, callbacks, speaking = false, stopped = false, time = 10000, serial = 0, greeting = false
  const v = load('voice', {
    '../config': { SPEECH_LANG: 'es-CO', BRIDGE_HTTP_URL: 'http://forbidden' }, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 }, './capabilities': { caps: () => ({ stt: true }) },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, configured: true, name: 'Diógenes' }), wakePattern },
    './voice-timing': voiceTimingStub(),
    './vad': { startVad: async h => { callbacks = h; return { live: () => !stopped, stop() { stopped = true }, reset() { speaking = false }, setGuard() {}, meter: () => ({ speaking }) } } },
  }, { window: {}, Date: class extends Date { static now() { return time } }, performance: { now: () => time },
    fetch: () => assert.fail('Whisper must not use browser/cloud STT'),
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, due: time + ms }); return id }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval() {},
  })
  const input = await v.startVoice({ mode: () => mode, requireGreeting: () => greeting,
    onWake: text => { wakes.push(text); mode = 'command' }, onSpeechStart() { mode = 'command' }, onAudioStart() {},
    onPartial() {}, onUtterance: text => utterances.push(text), onError: text => errors.push(text),
  }, { localTranscribe: (blob, signal) => { const job = { ...deferred(), blob, signal }; requests.push(job); return job.promise } })
  return { input, requests, utterances, wakes, errors, engine: () => v.diag.engine,
    segment(label = 'segment') { speaking = true; callbacks.onStart(); speaking = false; callbacks.onEnd(new Blob([label], { type: 'audio/webm' }), 1000) },
    mode(value) { mode = value }, greeting(value) { greeting = value },
    tick(ms) { time += ms; for (const [id, t] of [...timers]) if (t.due <= time) { timers.delete(id); t.fn() } },
  }
}

test('local VAD preserves ordered queued speech and assembles the complete utterance rather than a prefix', async () => {
  const f = await liveFixture()
  assert.equal(f.engine(), 'whisper')
  f.segment('first'); f.segment('second')
  assert.equal(f.requests.length, 1, 'single-flight local transcription')
  f.requests[0].resolve('Primera parte.'); await flush()
  assert.equal(f.requests.length, 2); assert.deepEqual(f.utterances, [])
  assert.equal(await f.requests[1].blob.text(), 'second')
  f.requests[1].resolve('Segunda parte.'); await flush()
  assert.deepEqual(f.utterances, ['Primera parte. Segunda parte.'])
  f.input.stop()
})

test('local reset/stop abort old work without letting an ignored abort block or contaminate a new generation', async () => {
  const f = await liveFixture()
  f.segment('private-old'); f.input.reset()
  assert.equal(f.requests[0].signal.aborted, true)
  f.segment('fresh'); assert.equal(f.requests.length, 2)
  f.requests[1].resolve('Pregunta fresca.'); await flush()
  f.requests[0].resolve('Texto privado anterior.'); await flush()
  assert.deepEqual(f.utterances, ['Pregunta fresca.'])
  f.segment('cancelled'); f.input.stop()
  assert.equal(f.requests[2].signal.aborted, true)
  f.requests[2].resolve('Nunca enviar.'); await flush()
  assert.deepEqual(f.utterances, ['Pregunta fresca.'])
})

test('Whisper handles wake/greeting locally; no browser subtitle or failed transcription becomes a question', async () => {
  const f = await liveFixture('wake'); f.greeting(true)
  f.segment(); f.requests[0].resolve('Diógenes, charla privada.'); await flush(); assert.deepEqual(f.wakes, [])
  f.segment(); f.requests[1].resolve('Hola, Diógenes, explica esta función.'); await flush()
  assert.deepEqual(f.wakes, ['explica esta función.'])
  f.segment(); f.requests[2].reject(new Error('Synthetic local failure')); await flush()
  assert.deepEqual(f.utterances, []); assert.match(f.errors[0], /Whisper local.*Synthetic local failure/)
  f.mode('deaf'); f.segment(); await flush(); assert.equal(f.requests.length, 3)
  f.input.stop()
})

test('local microphone selection while inactive never opens capture, and unavailable local service cannot fall back', async () => {
  let mode = 'transcript', captures = 0, available = false, selectedOptions
  const watchers = new Set(), errors = []
  const mic = load('microphone', {
    './audio': { getMic: async () => { captures++; return {} }, setMicBlocked() {}, startAnalyser: async () => {} },
    './utterance-audio': { startUtteranceAudio: () => assert.fail('Whisper should not open a duplicate PCM recorder'), stopUtteranceAudio() {}, resetUtteranceAudio() {}, markUtteranceAudio() {} },
    './voice-input-mode': { currentVoiceInputMode: () => mode, subscribeVoiceInputMode: fn => { watchers.add(fn); return () => watchers.delete(fn) }, reportVoiceInput() {} },
    './voice-timing': voiceTimingStub(), './direct-voice': { startDirectVoice: () => assert.fail('never use direct audio') },
    './whisper': { refreshWhisper: async () => ({ ...caps, available, reason: 'Synthetic unavailable' }), transcribeWhisper: async () => 'Authoritative local text' },
    './voice': { startVoice: async (_h, options) => { selectedOptions = options; return { stop() {}, live: () => true } } },
  })
  const owner = mic.createMicrophone({ mode: () => 'command', onError: text => errors.push(text) })
  mode = 'whisper'; watchers.forEach(fn => fn())
  assert.equal(captures, 0)
  assert.equal(await owner.start(), false); assert.equal(captures, 0); assert.match(errors[0], /Synthetic unavailable/)
  available = true; assert.equal(await owner.start(), true); assert.equal(captures, 1)
  assert.equal(await selectedOptions.localTranscribe(new Blob(['x']), new AbortController().signal), 'Authoritative local text')
  owner.stop()
})
