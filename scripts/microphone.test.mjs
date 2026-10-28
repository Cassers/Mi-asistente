import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { voiceTimingStub } from './timing-fixture.mjs'

function load(name, dependencies = {}, globals = {}) {
  dependencies = {
    './voice-input-mode': { currentVoiceInputMode: () => 'transcript', subscribeVoiceInputMode: () => () => {} },
    './direct-voice': { startDirectVoice: () => assert.fail('transcript fixtures cannot start direct capture') },
    './utterance-audio': { startUtteranceAudio: async () => {}, stopUtteranceAudio() {}, resetUtteranceAudio() {}, markUtteranceAudio() {} }, ...dependencies }
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, { exports, require: name => name === './voice-timing' ? voiceTimingStub() : dependencies[name], ...globals })
  return exports
}

test('muting closes tracks/analyser and rejects late permission results; unmute opens fresh capture', async () => {
  const requests = [], tracks = [], contexts = []
  let disconnected = 0
  const audio = load('audio', {}, {
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => requests.push(resolve)) } },
    AudioContext: class {
      constructor() { contexts.push(this); this.closed = false }
      createMediaStreamSource() { return { connect() {} } }
      createAnalyser() { return { frequencyBinCount: 32, disconnect() { disconnected++ } } }
      async close() { this.closed = true }
    },
  })
  const makeStream = () => {
    const track = { stopped: false, stop() { this.stopped = true } }
    tracks.push(track)
    return { getTracks: () => [track] }
  }
  const first = audio.getMic(), same = audio.getMic()
  assert.equal(requests.length, 1, 'concurrent consumers share one request')
  const late = makeStream()
  audio.setMicBlocked(true)
  requests.shift()(late)
  await assert.rejects(first, /apagado/); await assert.rejects(same, /apagado/)
  assert.equal(tracks[0].stopped, true)
  await assert.rejects(audio.getMic(), /apagado/)
  audio.setMicBlocked(false)
  const analyser = audio.startAnalyser()
  requests.shift()(makeStream())
  await analyser
  audio.setMicBlocked(true)
  assert.equal(tracks[1].stopped, true)
  assert.equal(contexts[0].closed, true)
  assert.equal(disconnected, 1)
  assert.equal(audio.micLevel(), 0)
})

test('capture stop kills recognizer; stale callbacks and pending starts cannot survive off/on', async () => {
  const loops = [], heard = [], blocks = [], traces = []
  let finish
  const { createMicrophone } = load('microphone', {
    './audio': { getMic: async () => ({}), setMicBlocked: value => blocks.push(value), startAnalyser: async () => {} },
    './voice': { startVoice: handlers => new Promise(resolve => {
      const input = { stopped: false, live: () => true, stop() { this.stopped = true } }
      loops.push({ handlers, input }); finish = () => resolve(input)
    }) },
  })
  const mic = createMicrophone({ mode: () => 'command', onWake: text => heard.push(text),
    onSpeechStart() {}, onPartial: text => heard.push(text), onUtterance: (text, traceId) => { heard.push(text); traces.push(traceId) },
    onError: text => heard.push(text) })
  const starting = mic.start()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  mic.stop(); finish()
  assert.equal(await starting, false)
  assert.equal(loops[0].input.stopped, true)
  for (const name of ['onWake', 'onPartial', 'onUtterance', 'onError']) loops[0].handlers[name]('student audio')
  assert.equal(loops[0].handlers.mode(), 'deaf')
  assert.deepEqual(heard, [])
  const restarted = mic.start()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  finish(); assert.equal(await restarted, true)
  loops[0].handlers.onUtterance('old audio')
  loops[1].handlers.onUtterance('new question', 'utterance-trace')
  assert.deepEqual(heard, ['new question'])
  assert.deepEqual(traces, ['utterance-trace'], 'only the live generation forwards its trace to App')
  mic.stop()
  assert.equal(loops[1].input.stopped, true)
  assert.equal(blocks.at(-1), true)
})

test('capture startup failure stays stopped and reports the error', async () => {
  const errors = [], blocks = []
  const { createMicrophone } = load('microphone', {
    './audio': { getMic: async () => ({}), setMicBlocked: value => blocks.push(value), startAnalyser: async () => {} },
    './voice': { startVoice: async handlers => {
      handlers.onError('permission denied')
      return { stop() {}, live: () => false }
    } },
  })
  const mic = createMicrophone({ onError: message => errors.push(message) })
  assert.equal(await mic.start(), false)
  assert.deepEqual(errors, ['permission denied'])
  assert.equal(mic.live(), false)
  assert.equal(blocks.at(-1), true)
})

test('mute policy overrides every phase, including configured wake mode', () => {
  const policy = load('listening-policy')
  for (const phase of ['offline', 'boot', 'dormant', 'waking', 'listening', 'speaking', 'thinking', 'tooling']) {
    for (const configured of [true, false]) assert.equal(policy.listeningMode(phase, configured, false, true), 'deaf')
  }
})

test('capture receives live mode and distinguishes fresh wake onset from a pending continuation across off/on', async () => {
  const loops = [], marks = [], modeReaders = [], resets = []
  let mode = 'wake'
  const { createMicrophone } = load('microphone', {
    './audio': { getMic: async () => ({}), setMicBlocked() {}, startAnalyser: async () => {} },
    './utterance-audio': {
      startUtteranceAudio: async (_stream, readMode) => modeReaders.push(readMode),
      stopUtteranceAudio() {}, resetUtteranceAudio: () => resets.push('pcm'),
      markUtteranceAudio: newWake => marks.push(newWake === true),
    },
    './voice': { startVoice: async handlers => {
      loops.push(handlers)
      return { live: () => true, stop() {}, reset: () => resets.push('voice') }
    } },
  })
  const mic = createMicrophone({ mode: () => mode, onSpeechStart() {}, onError: assert.fail })
  assert.equal(await mic.start(), true)
  assert.equal(modeReaders[0](), 'wake')
  loops[0].onAudioStart(); loops[0].onAudioStart(true)
  mode = 'command'; loops[0].onAudioStart(); loops[0].onSpeechStart()
  assert.deepEqual(marks, [true, false, false, false])
  mic.reset(); assert.deepEqual(resets, ['pcm', 'voice'])
  mic.stop(); assert.equal(modeReaders[0](), 'deaf')
  loops[0].onAudioStart(); assert.equal(marks.length, 4)
  mode = 'wake'; assert.equal(await mic.start(), true)
  assert.equal(modeReaders[0](), 'deaf'); assert.equal(modeReaders[1](), 'wake')
  loops[1].onAudioStart(); assert.deepEqual(marks, [true, false, false, false, true])
  mic.stop()
})

test('commit forwards only to the active input generation in command/guard and stays inert during startup, wake, mute and off/on', async () => {
  const loops = [], commits = []
  let mode = 'command', finish
  const { createMicrophone } = load('microphone', {
    './audio': { getMic: async () => ({}), setMicBlocked() {}, startAnalyser: async () => {} },
    './voice': { startVoice: h => new Promise(resolve => {
      const id = loops.length
      loops.push(h); finish = () => resolve({ live: () => true, stop() {}, commit() { commits.push(id); return true } })
    }) },
  })
  const mic = createMicrophone({ mode: () => mode, onError: assert.fail })
  assert.equal(mic.commit(), false)
  const starting = mic.start(); for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(mic.commit(), false); finish(); await starting
  assert.equal(mic.commit(), true)
  mode = 'wake'; assert.equal(mic.commit(), false)
  mode = 'deaf'; assert.equal(mic.commit(), false)
  mode = 'guard'; assert.equal(mic.commit(), true)
  mic.stop(); assert.equal(mic.commit(), false)
  const restarted = mic.start(); for (let i = 0; i < 20; i++) await Promise.resolve()
  finish(); await restarted; assert.equal(mic.commit(), true)
  assert.deepEqual(commits, [0, 0, 1]); mic.stop()
})

test('explicit transcript owner requests browserOnly even if a cloud recognizer is configured', async () => {
  const options = []
  const { createMicrophone } = load('microphone', {
    './audio': { getMic: async () => ({}), setMicBlocked() {}, startAnalyser: async () => {} },
    './voice': { startVoice: async (_handlers, option) => { options.push(option); return { stop() {}, live: () => true, commit: () => true } } },
  })
  const mic = createMicrophone({ mode: () => 'command', onError: assert.fail })
  assert.equal(await mic.start(), true); assert.equal(options[0].browserOnly, true)
  assert.equal(mic.commit(), true); mic.stop()
})

test('effective Codex application mode restarts live capture, blocks stale clips and restores OpenCode direct input', async () => {
  let application = 'opencode'
  const watchers = new Set(), loops = [], heard = [], clips = [], storage = new Map()
  const modes = load('voice-input-mode', {
    react: { useSyncExternalStore: (_, read) => read() },
    './projects': { selectedProject: () => ({ application }), subscribeProjects: fn => { watchers.add(fn); return () => watchers.delete(fn) } },
  }, { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } })
  const driver = (kind, h, options) => {
    const loop = { kind, h, options, stopped: false, live: () => true, stop() { this.stopped = true } }
    loops.push(loop); return loop
  }
  const { createMicrophone } = load('microphone', {
    './voice-input-mode': modes,
    './audio': { getMic: async () => ({}), startAnalyser: async () => {}, setMicBlocked() {} },
    './direct-voice': { startDirectVoice: async h => driver('direct', h) },
    './voice': { startVoice: async (h, options) => driver('transcript', h, options) },
  })
  const mic = createMicrophone({ mode: () => 'command', onUtterance: text => heard.push(text), onClip: clip => clips.push(clip), onError: assert.fail })
  assert.equal(await mic.start(), true); assert.equal(loops[0].kind, 'direct')
  application = 'codex'; for (const fn of watchers) fn()
  loops[0].h.onClip({ data: 'late prefix' }); loops[0].h.onUtterance('old caption')
  for (let i = 0; i < 24; i++) await Promise.resolve()
  assert.equal(loops[0].stopped, true); assert.equal(loops[1].kind, 'transcript'); assert.equal(loops[1].options.browserOnly, true)
  loops[1].h.onUtterance('Fresh browser dictation'); assert.deepEqual(heard, ['Fresh browser dictation']); assert.deepEqual(clips, [])
  application = 'opencode'; for (const fn of watchers) fn()
  for (let i = 0; i < 24; i++) await Promise.resolve()
  assert.equal(loops[1].stopped, true); assert.equal(loops[2].kind, 'direct')
  mic.stop()
})

test('Codex switch during pending direct startup invalidates the driver immediately and forwards restart success', async () => {
  let application = 'opencode', finishDirect
  const watchers = new Set(), clips = [], modes = load('voice-input-mode', {
    react: { useSyncExternalStore: (_, read) => read() },
    './projects': { selectedProject: () => ({ application }), subscribeProjects: fn => { watchers.add(fn); return () => watchers.delete(fn) } },
  }, { localStorage: { getItem: () => 'direct', setItem() {} } })
  let old, browserOnly
  const { createMicrophone } = load('microphone', {
    './voice-input-mode': modes,
    './audio': { getMic: async () => ({}), startAnalyser: async () => {}, setMicBlocked() {} },
    './direct-voice': { startDirectVoice: h => new Promise(resolve => {
      old = { h, stopped: false, live: () => true, stop() { this.stopped = true } }; finishDirect = () => resolve(old)
    }) },
    './voice': { startVoice: async (_h, options) => { browserOnly = options.browserOnly; return { live: () => true, stop() {} } } },
  })
  const mic = createMicrophone({ mode: () => 'command', onClip: x => clips.push(x), onError: assert.fail })
  const starting = mic.start(); for (let i = 0; i < 20; i++) await Promise.resolve()
  application = 'codex'; for (const fn of watchers) fn()
  old.h.onClip({ data: 'stale' }); assert.equal(old.h.mode(), 'deaf')
  finishDirect(); assert.equal(await starting, true)
  assert.equal(old.stopped, true); assert.equal(browserOnly, true); assert.deepEqual(clips, [])
  mic.stop()
})
