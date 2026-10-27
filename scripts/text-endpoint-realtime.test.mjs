import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { setTimeout as pause } from 'node:timers/promises'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'
import { voiceTimingStub } from './timing-fixture.mjs'

/** Real event-loop timers, real input controller; recognition events are fake.
 * This never opens a microphone, browser, provider or network connection. */
async function fixture(t) {
  const exports = {}, recognizers = [], sent = []
  const dependencies = {
    '../config': { SPEECH_LANG: 'es-CO' }, './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => '', speakingSince: () => 0 },
    './vad': { startVad: async () => assert.fail('browser-only path cannot request another detector') },
    './capabilities': { caps: () => ({ stt: false }) },
    './profile': { currentProfile: () => ({ ...DEFAULT_PROFILE, name: 'Narya' }), wakePattern },
    './voice-timing': voiceTimingStub(),
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => { assert.ok(name in dependencies); return dependencies[name] },
    setTimeout, clearTimeout, setInterval, clearInterval, performance, DOMException,
    fetch: () => assert.fail('dictation dispatch must never call a provider'),
    window: { SpeechRecognition: class { constructor() { recognizers.push(this) } start() { this.onstart?.() } abort() {} } },
  })
  const input = await exports.startVoice({ mode: () => 'command', onWake: assert.fail, onSpeechStart() {}, onPartial() {}, onError: assert.fail,
    onUtterance(text) { sent.push({ text, at: performance.now() }) } })
  t.after(() => input.stop())
  return { input, sent, get rec() { return recognizers.at(-1) },
    result(text, final = false) { const row = [{ transcript: text }]; row.isFinal = final; this.rec.onresult({ resultIndex: 0, results: [row] }) } }
}

for (const [text, final] of [['Hola', true], ['Hola cómo vas', false]]) {
  test(`missing speechend does not strand ${final ? 'final' : 'provisional greeting'} text: ${text}`, { timeout: 4000 }, async t => {
    const f = await fixture(t), start = performance.now()
    f.rec.onspeechstart(); f.result(text, final)
    for (let i=0; i<64 && !f.sent.length; i++) await pause(25)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].text, text)
    assert.ok(f.sent[0].at - start < 1400, 'dispatch should take roughly 900ms quiet + 250ms settle, not tens of seconds')
  })
}

test('manual provisional commit is immediate and a saved late final callback cannot send it again', { timeout: 4000 }, async t => {
  const f = await fixture(t), text = 'Quiero que conserves todo este texto provisional'
  f.rec.onspeechstart(); f.result(text)
  const late = f.rec.onresult, start = performance.now()
  assert.equal(f.input.commit(), true)
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, text)
  assert.ok(f.sent[0].at - start < 100)
  const row = [{ transcript: text }]; row.isFinal = true
  late({ resultIndex: 0, results: [row] })
  await pause(1300)
  assert.equal(f.sent.length, 1)
})
