import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load() {
  const contexts = []
  class AudioContext {
    sampleRate = 48000
    constructor() { contexts.push(this) }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createScriptProcessor() { return this.processor = { connect() {}, disconnect() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    async resume() {}
    async close() { this.closed = true }
  }
  const exports = {}
  const source = readFileSync(new URL('../src/lib/utterance-audio.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, AudioContext, btoa: binary => Buffer.from(binary, 'binary').toString('base64') })
  const feed = (seconds, value = 0.25) => contexts.at(-1).processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(48000 * seconds).fill(value) } })
  return { ...exports, contexts, feed }
}

test('voice clip WAV is mono PCM16 at 16 kHz with valid lengths and clipped samples', () => {
  const audio = load()
  const wav = Buffer.from(audio.pcmWav(new Float32Array([2, -2, 0]), 16000))
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), 6)
  assert.equal(wav.readInt16LE(44), 32767)
  assert.equal(wav.readInt16LE(46), -32768)
})

test('capture keeps onset and multi-segment speech; taking, reset and stop prevent stale audio', async () => {
  const audio = load()
  await audio.startUtteranceAudio({})
  assert.equal(audio.takeUtteranceAudio(), undefined)
  audio.feed(1)
  audio.markUtteranceAudio()
  audio.feed(1)
  audio.markUtteranceAudio() // A later VAD segment must not truncate the utterance.
  audio.feed(1)
  const clip = audio.takeUtteranceAudio()
  assert.equal(clip.mime, 'audio/wav')
  assert.equal(Buffer.from(clip.data, 'base64').length, 44 + 3 * 32000)
  assert.equal(audio.takeUtteranceAudio(), undefined)
  audio.feed(1)
  audio.markUtteranceAudio()
  assert.equal(Buffer.from(audio.takeUtteranceAudio().data, 'base64').length, 44 + 32000, 'previous turn cannot be resent')
  audio.markUtteranceAudio(); audio.resetUtteranceAudio()
  assert.equal(audio.takeUtteranceAudio(), undefined)
  audio.feed(1); audio.markUtteranceAudio()
  const late = audio.contexts[0].processor.onaudioprocess
  audio.stopUtteranceAudio()
  late({ inputBuffer: { getChannelData: () => new Float32Array(48000) } })
  assert.equal(audio.takeUtteranceAudio(), undefined)
  assert.equal(audio.contexts[0].closed, true)
})

test('capture retains at most sixty seconds even for an unbounded utterance', async () => {
  const audio = load()
  await audio.startUtteranceAudio({})
  audio.markUtteranceAudio()
  for (let i = 0; i < 75; i++) audio.feed(1)
  assert.equal(audio.takeUtteranceAudio(), undefined, 'never send the retained tail as a complete utterance')
  assert.equal(audio.captureDiagnostics().status, 'overflow')
  assert.equal(audio.captureDiagnostics().durationMs, 75000)
  audio.stopUtteranceAudio()
})

const decoded = clip => Buffer.from(clip.data, 'base64')
const sample = (wav, seconds) => wav.readInt16LE(44 + Math.round(seconds * 16000) * 2)
const near = (actual, expected) => assert.ok(Math.abs(actual - Math.round(expected * 32767)) <= 1, `${actual} != ${expected}`)

test('armed capture retains the distinct spoken prefix after an eight-second late onset and repeated segments', async () => {
  const audio = load(); await audio.startUtteranceAudio({})
  audio.armUtteranceAudio()
  for (let i = 0; i < 4; i++) audio.feed(1, 0) // waiting is trimmed, not the spoken prefix
  audio.feed(1, 0.125)
  for (let i = 0; i < 7; i++) audio.feed(1, 0.375)
  audio.markUtteranceAudio() // browser finally delivers its first onset/interim
  for (let i = 0; i < 3; i++) audio.feed(1, 0)
  audio.markUtteranceAudio(); audio.armUtteranceAudio() // neither may move the boundary
  audio.feed(1, 0.75)
  const wav = decoded(audio.takeUtteranceAudio())
  near(sample(wav, 0.3), 0.125)
  near(sample(wav, 1.5), 0.375)
  near(sample(wav, 11.5), 0.75)
  assert.equal(audio.captureDiagnostics().status, 'ready')
  assert.equal(audio.captureDiagnostics().durationMs, 12250)
  audio.stopUtteranceAudio()
})

test('armed capture also works without any browser onset; long quiet waits do not consume the speech limit', async () => {
  const audio = load(); await audio.startUtteranceAudio({}); audio.armUtteranceAudio()
  for (let i = 0; i < 70; i++) audio.feed(1, 0)
  audio.feed(1, 0.125); audio.feed(1, 0.75)
  const wav = decoded(audio.takeUtteranceAudio())
  near(sample(wav, 0.3), 0.125); near(sample(wav, 1.5), 0.75)
  assert.equal(audio.captureDiagnostics().durationMs, 2250)
  audio.stopUtteranceAudio()
})

test('late wake plus trailing speech uses its local PCM onset, then a wake reset cannot resend the clip', async () => {
  const audio = load(); let mode = 'wake'
  await audio.startUtteranceAudio({}, () => mode)
  audio.feed(1, 0.125)
  for (let i = 0; i < 7; i++) audio.feed(1, 0.5)
  audio.markUtteranceAudio(true) // late raw onset must retain eight seconds, not two
  audio.markUtteranceAudio() // App.onWake trailing path
  const clip = audio.takeUtteranceAudio(), wav = decoded(clip)
  near(sample(wav, 0.1), 0.125); near(sample(wav, 7.5), 0.5)
  audio.resetUtteranceAudio()
  assert.equal(audio.captureDiagnostics().status, 'ready', 'wake reset preserves content-free extraction evidence')
  mode = 'command'; audio.armUtteranceAudio(); audio.feed(1, 0.75)
  const next = decoded(audio.takeUtteranceAudio())
  near(sample(next, 0.1), 0.75)
  assert.equal(next.length, 44 + 32000)
  audio.stopUtteranceAudio()
})

test('new wake onset discards an earlier unaddressed snippet but keeps already-buffered new speech', async () => {
  const audio = load(); await audio.startUtteranceAudio({}, () => 'wake')
  audio.feed(1, 0.125); audio.markUtteranceAudio(true)
  for (let i = 0; i < 3; i++) audio.feed(1, 0)
  audio.feed(1, 0.75); audio.markUtteranceAudio(true)
  const wav = decoded(audio.takeUtteranceAudio())
  assert.equal(audio.captureDiagnostics().durationMs, 1250)
  near(sample(wav, 0.3), 0.75)
  audio.stopUtteranceAudio()
})

test('unmarked ambiguous wake history falls back instead of claiming the latest speech run is complete', async () => {
  const audio = load(); await audio.startUtteranceAudio({}, () => 'wake')
  audio.feed(1, 0.125)
  for (let i = 0; i < 3; i++) audio.feed(1, 0)
  audio.feed(1, 0.75); audio.markUtteranceAudio()
  assert.equal(audio.takeUtteranceAudio(), undefined)
  assert.equal(audio.captureDiagnostics().status, 'missing')
  audio.stopUtteranceAudio()
})

test('exactly sixty seconds and a lost prefix both fall back; dispatch floor excludes retained old audio afterward', async () => {
  for (const seconds of [60, 75]) {
    const audio = load(); await audio.startUtteranceAudio({}); audio.armUtteranceAudio()
    audio.feed(1, 0.125)
    for (let i = 1; i < seconds; i++) audio.feed(1, 0.5)
    audio.markUtteranceAudio()
    assert.equal(audio.takeUtteranceAudio(), undefined)
    assert.equal(audio.captureDiagnostics().status, 'overflow')
    assert.equal(audio.captureDiagnostics().durationMs, seconds * 1000)
    audio.feed(1, 0.75); audio.markUtteranceAudio()
    const wav = decoded(audio.takeUtteranceAudio())
    assert.equal(wav.length, 44 + 32000); near(sample(wav, 0.1), 0.75)
    audio.stopUtteranceAudio()
  }
})

test('deaf PCM, reset and off/on keep previous-turn samples private', async () => {
  const audio = load(); let mode = 'command'
  await audio.startUtteranceAudio({}, () => mode)
  audio.armUtteranceAudio(); audio.feed(1, 0.125)
  mode = 'deaf'; audio.feed(1, 0.5)
  mode = 'command'; audio.armUtteranceAudio(); audio.feed(1, 0.75)
  const wav = decoded(audio.takeUtteranceAudio()); assert.equal(wav.length, 44 + 32000); near(sample(wav, 0.1), 0.75)
  const stale = audio.contexts[0].processor.onaudioprocess
  audio.stopUtteranceAudio(); await audio.startUtteranceAudio({}, () => mode)
  stale({ inputBuffer: { getChannelData: () => new Float32Array(48000).fill(0.125) } })
  audio.armUtteranceAudio(); audio.feed(1, 0.5)
  near(sample(decoded(audio.takeUtteranceAudio()), 0.1), 0.5)
  audio.stopUtteranceAudio()
})

test('local VAD onset after minutes of continuous room noise selects only current speech with pre-roll', async () => {
  const audio = load(); await audio.startUtteranceAudio({}, () => 'wake')
  for (let i=0; i<75; i++) audio.feed(1, 0.001) // nonzero ambient PCM never creates a passive gap
  audio.feed(0.15, 0.125) // first phonemes before local VAD confirms its 110ms gate
  audio.markUtteranceAudio(true, true)
  audio.markUtteranceAudio() // microphone callback cannot move the frozen onset
  audio.feed(1, 0.75)
  let wav = decoded(audio.takeUtteranceAudio())
  assert.equal(audio.captureDiagnostics().status, 'ready')
  assert.equal(audio.captureDiagnostics().durationMs, 1250)
  near(sample(wav, 0.12), 0.125); near(sample(wav, 0.8), 0.75)
  for (let i=0; i<75; i++) audio.feed(1, 0.002)
  audio.feed(0.15, 0.25); audio.markUtteranceAudio(false, true); audio.feed(1, 0.5)
  wav = decoded(audio.takeUtteranceAudio())
  assert.equal(audio.captureDiagnostics().durationMs, 1250)
  near(sample(wav, 0.12), 0.25); near(sample(wav, 0.8), 0.5)
  audio.stopUtteranceAudio()
})
