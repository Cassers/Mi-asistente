import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(storage = new Map(), application = 'opencode') {
  let selected = { application }
  const watchers = new Set()
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/voice-input-mode.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require: id => id === './projects' ? { selectedProject: () => selected, subscribeProjects: fn => { watchers.add(fn); return () => watchers.delete(fn) } } : ({ useSyncExternalStore: (_subscribe, read) => read() }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  })
  return { ...exports, select(application) { selected = { application }; for (const fn of watchers) fn() } }
}

test('voice choice defaults to direct audio; only valid enum persists, never audio or transcript content', () => {
  const storage = new Map(), input = load(storage)
  assert.equal(input.currentVoiceInputMode(), 'direct')
  input.setVoiceInputMode('transcript')
  assert.equal(load(storage).currentVoiceInputMode(), 'transcript')
  input.setVoiceInputMode('audio-secret'); input.reportVoiceInput('No se pudo interpretar el MP3.')
  assert.equal(storage.size, 1)
  assert.equal([...storage.values()][0], 'transcript')
  assert.equal(input.useVoiceInputStatus(), 'No se pudo interpretar el MP3.')
  input.setVoiceInputMode('clip')
  assert.equal(input.useVoiceInputStatus(), '')
  assert.equal(load(storage).currentVoiceInputMode(), 'direct')
})


test('legacy clip preference migrates to direct audio; transcript remains explicit', () => {
  const storage = new Map([['assistant.voice.input-mode', 'clip']])
  const input = load(storage)
  assert.equal(input.currentVoiceInputMode(), 'direct')
  assert.equal(storage.get('assistant.voice.input-mode'), 'direct')
  input.setVoiceInputMode('transcript')
  assert.equal(load(storage).currentVoiceInputMode(), 'transcript')
  input.setVoiceInputMode('direct')
  assert.equal(load(storage).currentVoiceInputMode(), 'direct')
})

test('Codex overrides stored direct and legacy settings without changing OpenCode preference across switch/reload', () => {
  for (const saved of ['direct', 'clip', 'transcript']) {
    const storage = new Map([['assistant.voice.input-mode', saved]]), app = load(storage, 'codex')
    assert.equal(app.currentVoiceInputMode(), 'transcript')
    app.setVoiceInputMode('direct'); app.setVoiceInputMode('clip'); app.setVoiceInputMode('transcript')
    assert.equal(app.currentVoiceInputMode(), 'transcript')
    assert.equal(load(storage, 'codex').currentVoiceInputMode(), 'transcript')
    app.select('opencode')
    assert.equal(app.currentVoiceInputMode(), saved === 'transcript' ? 'transcript' : 'direct')
    app.select('codex'); assert.equal(app.currentVoiceInputMode(), 'transcript')
  }
})

test('application changes notify capture listeners immediately; Codex cannot mutate the OpenCode saved choice', () => {
  const storage = new Map([['assistant.voice.input-mode', 'direct']]), app = load(storage), observed = []
  app.subscribeVoiceInputMode(() => observed.push(app.currentVoiceInputMode()))
  app.select('codex'); assert.deepEqual(observed, ['transcript'])
  app.setVoiceInputMode('direct'); app.setVoiceInputMode('transcript'); assert.equal(storage.get('assistant.voice.input-mode'), 'direct')
  app.select('opencode'); assert.deepEqual(observed, ['transcript', 'direct'])
})
