import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'

function load(name, dependencies, globals) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    require: id => { assert.ok(id in dependencies, `unexpected import: ${id}`); return dependencies[id] },
    console: { error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    ...globals,
  })
  return exports
}

test('browser recognition network errors reach the visible error handler', async () => {
  let recogniser
  const errors = []
  const voice = load('voice', {
    '../config': { SPEECH_LANG: 'es-ES' },
    './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 },
    './vad': {}, './capabilities': { caps: () => ({ stt: false }) },
    './profile': { currentProfile: () => DEFAULT_PROFILE, wakePattern },
  }, {
    window: { SpeechRecognition: class {
      constructor() { recogniser = this }
      start() { this.onstart() }
      abort() {}
    } },
  })
  const input = await voice.startVoice({ mode: () => 'wake', onError: message => errors.push(message) })
  recogniser.onerror({ error: 'network' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /network.*localhost:5173.*Google Chrome/)
  assert.equal(voice.diag.lastError, 'network')
  recogniser.onerror({ error: 'not-allowed' })
  assert.match(errors[1], /refused/)
  input.stop()
})

test('failed native speech never calls an unconfigured cloud fallback', async () => {
  let requests = 0
  const speech = load('speech-text', {}, {})
  const output = load('tts', {
    './speech-settings': { currentSpeechRate: () => DEFAULT_PROFILE.speechRate },
    './speech-text': speech,
    '../config': { env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge',
      TTS_ENGINE: 'browser', SPEECH_LANG: 'es-ES', LANG_PREFIX: 'es', SPEECH_RATE: 1.2 },
    './kokoro': {}, './capabilities': { caps: () => ({ tts: false }) },
    './profile': { currentProfile: () => DEFAULT_PROFILE },
  }, {
    window: {},
    speechSynthesis: {
      addEventListener() {}, getVoices: () => [], resume() {},
      speak: utterance => utterance.onerror({ error: 'synthesis-failed' }),
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: async () => { requests++; return { ok: false } },
  })
  for (const text of ['Hola, señor.', 'Segunda frase.']) {
    const speaker = output.createSpeaker()
    speaker.say(text)
    await speaker.end()
  }
  assert.equal(output.diag.failures, 2)
  assert.equal(output.diag.lastError, 'synthesis-failed')
  assert.equal(output.diag.engine, 'system')
  assert.equal(output.diag.rescued, 0)
  assert.equal(requests, 0)
})

test('streamed unknown-speaker labels never reach native speech, at any token boundary', async () => {
  const spoken = []
  const output = load('tts', {
    './speech-settings': { currentSpeechRate: () => DEFAULT_PROFILE.speechRate },
    './speech-text': load('speech-text', {}, {}),
    '../config': { env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge', TTS_ENGINE: 'system', SPEECH_LANG: 'es-CO' },
    './kokoro': {}, './capabilities': { caps: () => ({ tts: false }) },
    './profile': { currentProfile: () => DEFAULT_PROFILE },
  }, {
    window: {}, localStorage: { getItem: () => null },
    speechSynthesis: { addEventListener() {}, getVoices: () => [], resume() {},
      speak: utterance => { spoken.push(utterance.text); utterance.onstart?.(); utterance.onend?.() } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: () => assert.fail('must not call a voice provider'),
  })
  const input = '**???**: "It is over!"\n\n???: "Please help us."\n\n¿Quién habla?'
  for (let cut = 0; cut <= input.length; cut++) {
    const speaker = output.createSpeaker()
    speaker.push(input.slice(0, cut)); speaker.push(input.slice(cut))
    await speaker.end()
  }
  assert.ok(spoken.length > 0)
  assert.ok(spoken.some(text => text.includes('¿Quién habla?')))
  assert.ok(spoken.every(text => !text.includes('??')))
})

test('recognition follows the chosen wake name and changes without reloading', async () => {
  let recogniser
  let now = 10000
  let profile = { ...DEFAULT_PROFILE, configured: true, name: 'Atenea' }
  const heard = []
  const voice = load('voice', {
    '../config': { SPEECH_LANG: 'es-CO' }, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 },
    './vad': {}, './capabilities': { caps: () => ({ stt: false }) },
    './profile': { currentProfile: () => profile, wakePattern },
  }, {
    Date: class extends Date { static now() { return now } },
    window: { SpeechRecognition: class {
      constructor() { recogniser = this }
      start() { this.onstart() }
      abort() {}
    } },
  })
  const input = await voice.startVoice({ mode: () => 'wake', onWake: text => heard.push(text), onError: assert.fail })
  const result = text => recogniser.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] })
  result('Hola, Atenea, explícame esto')
  assert.deepEqual(heard, ['explícame esto'])
  profile = { ...profile, name: 'Lúa Azul' }
  now += 2000
  result('Hola, Lúa Azul, otra pregunta')
  assert.deepEqual(heard, ['explícame esto', 'otra pregunta'])
  assert.equal(recogniser.lang, 'es-CO')
  input.stop()
})

test('native speech uses the speed selected during configuration', async () => {
  const rates = []
  let rate = 1.4
  const output = load('tts', {
    './speech-settings': { currentSpeechRate: () => rate },
    './speech-text': load('speech-text', {}, {}),
    '../config': { env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge',
      TTS_ENGINE: 'system', SPEECH_LANG: 'es-CO', SPEECH_RATE: 1.2 },
    './kokoro': {}, './capabilities': { caps: () => ({ tts: false }) },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, configured: true, speechRate: 1.4 }) },
  }, {
    window: {},
    speechSynthesis: { addEventListener() {}, getVoices: () => [], resume() {},
      speak: u => { rates.push(u.rate); u.onstart(); u.onend() } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  })
  const speaker = output.createSpeaker()
  speaker.say('Velocidad elegida.')
  await speaker.end()
  assert.deepEqual(rates, [1.4])
  assert.equal(output.diag.started, 1)
  rate = 1.7
  const next = output.createSpeaker()
  next.say('Nueva velocidad.'); await next.end()
  assert.deepEqual(rates, [1.4, 1.7])
})

test('audio playback uses browser speed while preserving pitch, without remote calls', async () => {
  const played = []
  const output = load('tts', {
    './speech-settings': { currentSpeechRate: () => 1.6 },
    './speech-text': load('speech-text', {}, {}),
    '../config': { env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge', TTS_ENGINE: 'kokoro', SPEECH_LANG: 'es-CO' },
    './kokoro': { isUnavailable: () => false, speak: async () => 'blob:synthetic' },
    './capabilities': { caps: () => ({ tts: false }) }, './profile': { currentProfile: () => DEFAULT_PROFILE },
  }, {
    window: {}, URL: { revokeObjectURL() {} },
    Audio: class { play() { played.push([this.playbackRate, this.preservesPitch]); this.onplaying(); this.onended(); return Promise.resolve() } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: () => assert.fail('speed test must never use a remote service'),
  })
  const speaker = output.createSpeaker(); speaker.say('Audio ficticio.'); await speaker.end()
  assert.deepEqual(played, [[1.6, true]])
})

test('streamed speech strips arrows and rules, skips code, and begins before end()', async () => {
  const utterances = []
  const output = load('tts', {
    './speech-settings': { currentSpeechRate: () => DEFAULT_PROFILE.speechRate },
    './speech-text': load('speech-text', {}, {}),
    '../config': { env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge', TTS_ENGINE: 'system', SPEECH_LANG: 'es-CO', SPEECH_RATE: 1.2 },
    './kokoro': {}, './capabilities': { caps: () => ({ tts: false }) },
    './profile': { currentProfile: () => DEFAULT_PROFILE },
  }, {
    window: {},
    speechSynthesis: { addEventListener() {}, getVoices: () => [], resume() {},
      speak: u => { utterances.push(u.text); u.onstart(); u.onend() } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  })
  const speaker = output.createSpeaker()
  speaker.push('**Hola** → mundo. ')
  assert.equal(utterances[0], 'Hola , mundo.', 'do not wait for complete response')
  for (const char of '\n---\n```js\nconsole.log("Secreto. ");\n```\n- Después -> final. ') speaker.push(char)
  await speaker.end()
  assert.equal(utterances.join(' '), 'Hola , mundo. Después , final.')
})

test('standby reset discards queued browser transcripts and creates a fresh wake recognizer', async () => {
  const instances = [], timers = new Map(), wakes = [], heard = []
  let mode = 'command', sequence = 0
  const voice = load('voice', {
    '../config': { SPEECH_LANG: 'es-CO' }, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 }, './vad': {}, './capabilities': { caps: () => ({ stt: false }) },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, configured: true, name: 'Diógenes' }), wakePattern },
  }, {
    window: { SpeechRecognition: class { constructor() { instances.push(this) } start() { this.onstart() } abort() {} } },
    setTimeout: fn => { timers.set(++sequence, fn); return sequence }, clearTimeout: id => timers.delete(id),
  })
  const input = await voice.startVoice({ mode: () => mode, onWake: text => wakes.push(text), onUtterance: text => heard.push(text), onSpeechStart() {}, onPartial() {}, onError: assert.fail })
  const result = (recognizer, text) => recognizer.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] })
  const old = instances[0]
  result(old, 'texto que no debe enviarse')
  assert.ok(timers.size)
  mode = 'wake'; input.reset()
  assert.equal(old.onresult, null)
  assert.equal(timers.size, 0)
  const current = instances.at(-1)
  assert.notEqual(current, old)
  result(current, 'una charla cualquiera')
  assert.equal(wakes.length, 0); assert.equal(heard.length, 0)
  result(current, 'hola Diógenes explícame esto')
  assert.deepEqual(wakes, ['explícame esto'])
  input.stop()
})

test('standby reset also ignores a delayed premium transcription captured before the pause', async () => {
  let vad, finishOld, calls = 0
  const wakes = []
  const voice = load('voice', {
    '../config': { SPEECH_LANG: 'es-CO', BRIDGE_HTTP_URL: 'http://fake' }, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 },
    './vad': { startVad: async callbacks => { vad = callbacks; return { live: () => true, stop() {}, meter: () => ({ speaking: false }) } } },
    './capabilities': { caps: () => ({ stt: true }) },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, configured: true, name: 'Diógenes' }), wakePattern },
  }, { window: {}, performance: { now: () => 1 }, fetch: () => {
    calls++
    if(calls===1) return new Promise(resolve => { finishOld = resolve })
    return Promise.resolve({ ok: true, json: async () => ({ text: 'Diógenes pregunta nueva' }) })
  } })
  const input = await voice.startVoice({ mode: () => 'wake', onWake: text => wakes.push(text), onSpeechStart() {}, onPartial() {}, onUtterance() {}, onError: assert.fail })
  vad.onStart(); vad.onEnd({ type: 'audio/webm' })
  input.reset()
  finishOld({ ok: true, json: async () => ({ text: 'Diógenes pregunta vieja' }) })
  await new Promise(setImmediate)
  assert.equal(wakes.length, 0)
  vad.onStart(); vad.onEnd({ type: 'audio/webm' })
  await new Promise(setImmediate)
  assert.deepEqual(wakes, ['pregunta nueva'])
  input.stop()
})
