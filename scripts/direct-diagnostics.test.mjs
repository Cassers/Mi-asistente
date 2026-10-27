import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

function render(mode, direct, legacy = undefined) {
  const exports = {}, globals = { __tts: { started: 1 } }
  Object.defineProperty(globals, '__voice', { get() {
    if (mode === 'direct') throw Error('direct mode must not access stale legacy recognition data')
    return legacy
  } })
  const deps = {
    react: { useEffect() {}, useState: initial => [typeof initial === 'boolean' ? true : initial, () => {}] },
    'react/jsx-runtime': jsx,
    '../store': { useStore: selector => selector({ phase: 'listening' }) },
    '../lib/voice-input-mode': { useVoiceInputMode: () => mode },
    '../lib/direct-voice': { getDirectVoiceDiagnostics: () => direct },
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/ui/Diagnostics.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, window: globals, require: id => { assert.ok(id in deps, `Unexpected dependency ${id}`); return deps[id] } })
  return renderToStaticMarkup(React.createElement(exports.Diagnostics))
}
const active = { running: true, captions: 'available', segment: 'speaking', segments: 2, sent: 1, wakes: 1, mode: 'command', error: null }

test('direct diagnostics renders live PCM before any accepted clip and does not read legacy voice content', () => {
  const html = render('direct', { ...active, segments: 0, sent: 0 })
  assert.match(html, /PCM capture active/)
  assert.match(html, /direct PCM \/ VAD/)
  assert.match(html, /available/)
  assert.doesNotMatch(html, /not hearing you|STOPPED|last heard|recogniser/)
})

test('unavailable captions do not imply stopped PCM; quiet/held/stopped segment states remain visible', () => {
  for (const segment of ['quiet', 'held']) {
    const html = render('direct', { ...active, captions: 'unavailable', segment })
    assert.match(html, /PCM capture active/)
    assert.match(html, /unavailable · use Space to activate/)
    assert.ok(html.includes(`>${segment}<`))
    assert.doesNotMatch(html, /STOPPED|not hearing you/)
  }
  const stopped = render('direct', { ...active, running: false, segment: 'idle', captions: 'stopped', mode: 'deaf' })
  assert.match(stopped, /PCM capture stopped/); assert.match(stopped, /STOPPED/)
})

test('transcript diagnostics still uses its existing recognizer and safely handles missing legacy stats', () => {
  const legacy = render('transcript', active, { running: true, accepted: 1, sessions: 1, mode: 'command' })
  assert.match(legacy, /● hearing you/); assert.match(legacy, /recogniser/)
  assert.doesNotMatch(legacy, /direct PCM/)
  assert.match(render('transcript', active), /STOPPED/)
})
