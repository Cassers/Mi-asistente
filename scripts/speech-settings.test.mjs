import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = ts.transpileModule(readFileSync(new URL('../src/lib/speech-settings.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
function load(storage = new Map(), profile = { configured: true, speechRate: 1.3 }) {
  const exports = {}
  vm.runInNewContext(source, { exports, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    require: id => id === 'react' ? { useSyncExternalStore: (_, snapshot) => snapshot() } : id === '../config' ? { SPEECH_RATE: 1.2 } : { currentProfile: () => profile, useProfile: () => profile },
  })
  return exports
}
test('speech rate uses profile by default and persists a valid browser-only override', () => {
  const storage = new Map(), app = load(storage)
  assert.equal(app.currentSpeechRate(), 1.3)
  app.setSpeechRate(1.65)
  assert.equal(app.useSpeechRate(), 1.65)
  const reload = load(storage)
  assert.equal(reload.currentSpeechRate(), 1.65)
  reload.resetSpeechRate()
  assert.equal(reload.currentSpeechRate(), 1.3)
  assert.equal(storage.size, 0)
})
test('voice slider accepts endpoints, ignores invalid values and does not modify profile', () => {
  const profile = { configured: false, speechRate: 1.3 }, app = load(new Map(), profile)
  assert.equal(app.currentSpeechRate(), 1.2)
  for (const value of [0.5, 2]) { app.setSpeechRate(value); assert.equal(app.currentSpeechRate(), value) }
  for (const value of [0, 3, NaN, Infinity, '1.5', null]) app.setSpeechRate(value)
  assert.equal(app.currentSpeechRate(), 2)
  assert.equal(profile.speechRate, 1.3)
  assert.equal(load(new Map([['assistant.speech.rate', 'bad']])).currentSpeechRate(), 1.3)
})
