import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const noop = () => {}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)]
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
const byClass = (tree, name) => nodes(tree).find(node => node.props?.className?.split(' ').includes(name))
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))

// Actual UI, fake store/bridge and inert effects. Never opens devices or sockets.
export function fixture(patch = {}, configured = true, application = 'opencode') {
  const events = [], slots = []
  let cursor = 0, historyResult = Promise.resolve()
  const state = { phase: 'dormant', microphoneActive: true, microphoneMuted: false, microphoneBusy: false,
    microphoneStandby: false, conversationPaused: false, caption: '', turns: [], activeTool: null,
    error: null, bootNote: '', gestures: false, looking: null, screenCapture: 'off', autoScreen: false,
    applicationCapabilities: { screenOptIn: true }, recording: { active: false, audio: ['mic', 'system'], controlVersion: 1 },
    ui: { chrome: { brand: true, transcript: true, toolBadge: false, suggestions: false } }, ...patch }
  state.setAutoScreen = enabled => events.push(['screen', enabled])
  state.setError = error => events.push(['error', error])
  const useStore = Object.assign(selector => selector(state), { getState: () => state })
  const hooks = { ...React, useEffect: noop, useLayoutEffect: noop, useRef: initial => ({ current: initial }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] } }
  const inert = () => null
  const mocks = {
    react: hooks,
    '../store': { useStore, accentFor: () => '#67e8e3' },
    '../lib/profile': { useProfile: () => ({ name: 'Demo', configured }), displayName: () => 'Demo', wakeWord: () => 'Demo' },
    '../lib/whisper': { useWhisperCapabilities: () => ({ state: 'unavailable', capabilities: null, error: 'Whisper no configurado en este fixture.' }),
      refreshWhisper: async () => { throw Error('fixture unavailable') }, subscribeWhisperInvalidation: () => () => {}, whisperAccept: () => '', transcribeWhisper: () => assert.fail('fixture must never transcribe') },
    '../lib/voice-input-mode': { useVoiceInputMode: () => 'transcript', useVoiceInputStatus: () => '' },
    '../lib/projects': { useProjects: () => ({ selected: { application } }) },
    '../lib/brain': { setRecordingActive: enabled => { events.push(['history', enabled]); return historyResult } },
    'framer-motion': { AnimatePresence: ({ children }) => children, motion: { div: ({ children }) => React.createElement('div', null, children) } },
    './Blades': { Blades: inert, BladeSweep: inert }, './Effects': { Effects: inert }, './Pointer': { Pointer: inert },
    './GestureGuide': { GestureGuide: inert }, './Suggestions': { Suggestions: inert },
    './ResponseText': { ResponseText: ({ text }) => React.createElement('p', null, text) },
  }
  const cache = {}
  function load(name) {
    if (cache[name]) return cache[name]
    const exports = {}
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/ui/${name}.tsx`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, Error, require: id => mocks[id] || (id.startsWith('./') ? load(id.slice(2)) : require(id)) })
    return cache[name] = exports
  }
  const callbacks = { onPause: () => events.push(['pause']), onResume: () => events.push(['resume']),
    onToggleMicrophone: () => events.push(['microphone']), onToggleStandby: () => events.push(['standby']), onSendMessage: noop }
  return { state, events, load, historyResult(value) { historyResult = value },
    render(name = 'Hud', props = {}) { cursor = 0; return load(name === 'HistoryControl' || name === 'ScreenControl' ? 'CaptureControls' : name)[name]({ ...callbacks, ...props }) },
    html() { cursor = 0; return renderToStaticMarkup(React.createElement(load('Hud').Hud, callbacks)) } }
}

test('header and microphone agree across phases, configuration and all mute/pause combinations', () => {
  let cases = 0
  for (const configured of [false, true]) for (const phase of ['offline','boot','dormant','waking','listening','thinking','tooling','speaking'])
    for (const microphoneActive of [false,true]) for (const microphoneMuted of [false,true])
      for (const microphoneStandby of [false,true]) for (const conversationPaused of [false,true]) {
        const f = fixture({ phase, microphoneActive, microphoneMuted, microphoneStandby, conversationPaused }, configured)
        const tree = f.render(), status = byClass(tree, 'status')
        const mic = nodes(tree).find(node => node.type === f.load('MicrophoneControl').MicrophoneControl)
        const expected = microphoneMuted || !microphoneActive || ['offline','boot'].includes(phase) ? 'off'
          : microphoneStandby || conversationPaused || phase === 'dormant' && configured ? 'wake' : 'active'
        const label = { off: 'MICRÓFONO APAGADO', wake: 'SOLO ACTIVACIÓN', active: 'ESCUCHA ACTIVA' }[expected]
        assert.equal(status.props['data-input'], expected)
        assert.ok(text(status).startsWith(label))
        const lower = f.load('MicrophoneControl').MicrophoneControl(mic.props)
        assert.equal(text(byClass(lower, 'control-state')), label)
        if (expected === 'off') assert.doesNotMatch(text(lower), /Escucha activa|Di «|Silenciar conversación/)
        if (['thinking','tooling','speaking'].includes(phase)) assert.match(text(status), /PROCESSING|ACCESSING SYSTEMS|RESPONDING/)
        cases++
      }
  assert.equal(cases, 256)
})

test('derived wake-only state changes the label without changing soft/hard/stop/resume actions', () => {
  const f = fixture()
  let tree = f.render()
  const micNode = nodes(tree).find(node => node.type === f.load('MicrophoneControl').MicrophoneControl)
  tree = f.load('MicrophoneControl').MicrophoneControl(micNode.props)
  button(tree, 'Exigir saludo').props.onClick()
  button(tree, 'Apagar por completo').props.onClick()
  assert.deepEqual(f.events, [['standby'], ['microphone']])
  tree = f.render('ListeningControl', { paused: true, disabled: false, muted: false, standby: false, name: 'Demo' })
  button(tree, 'Reanudar conversación').props.onClick()
  tree = f.render('ListeningControl', { paused: true, disabled: false, muted: true, standby: false, name: 'Demo' })
  button(tree, 'Detener respuesta').props.onClick()
  assert.deepEqual(f.events.slice(2), [['resume'], ['pause']])
})

test('permission/startup stays off and disabled; unknown history is never reported as active', () => {
  const f = fixture({ phase: 'boot', bootNote: 'Preparando voz…', microphoneActive: false, microphoneBusy: true, recording: null })
  assert.match(f.html(), /MICRÓFONO APAGADO · Preparando voz…/)
  assert.match(f.html(), /Sin confirmar/)
  const tree = f.render()
  const mic = nodes(tree).find(node => node.type === f.load('MicrophoneControl').MicrophoneControl)
  const lower = f.load('MicrophoneControl').MicrophoneControl(mic.props)
  assert.equal(button(lower, 'Activando micrófono').props.disabled, true)
  assert.doesNotMatch(text(lower), /escuchando|Escucha activa|Historial activo/)
  const disconnected = fixture({ applicationCapabilities: null })
  assert.match(disconnected.html(), /espera la confirmación de compatibilidad/)
  assert.doesNotMatch(disconnected.html(), /Antigravity CLI/)
  const textOnly = fixture({ phase: 'offline', microphoneActive: false, applicationCapabilities: { screenOptIn: true } })
  assert.match(textOnly.html(), /MICRÓFONO APAGADO · SOLO TEXTO/)
  assert.doesNotMatch(textOnly.html(), /SIN CONEXIÓN/)
  assert.deepEqual(f.events, [])
})

test('sharing reports opt-in, pending, attached, failed and unavailable separately from history', () => {
  for (const [captureStatus, expected] of [['off','Activada · próxima pregunta'], ['capturing','Capturando monitor…'],
    ['attached','Captura adjunta al último envío'], ['failed','Falló la captura del último envío']]) {
    const f = fixture({ autoScreen: true, screenCapture: captureStatus, microphoneMuted: true })
    const html = f.html()
    assert.ok(html.includes(expected))
    assert.match(html, /Historial pausado/)
    assert.deepEqual(f.events, [], 'rendering cannot activate input, history or sharing')
  }
  for (const capabilities of [null, {}, { screenOptIn: false }]) {
    const f = fixture({ applicationCapabilities: capabilities }, true, 'antigravity')
    const tree = f.render(), screen = nodes(tree).find(node => node.type === f.load('CaptureControls').ScreenControl)
    const control = f.load('CaptureControls').ScreenControl(screen.props)
    const toggle = button(control, 'Compartir pantalla')
    assert.equal(toggle.props.disabled, true)
    toggle.props.onClick()
    assert.deepEqual(f.events, [])
    assert.match(f.html(), /Antigravity CLI solo admite texto/)
    const enabled = f.load('CaptureControls').ScreenControl({ ...screen.props, enabled: true })
    button(enabled, 'Desactivar').props.onClick()
    assert.deepEqual(f.events, [['screen', false]], 'unavailable sharing can still be disabled')
  }
})

test('history pending/error confirmation preserves scope and never toggles sharing', async () => {
  const f = fixture({ microphoneMuted: true })
  let reject
  f.historyResult(new Promise((_, fail) => { reject = fail }))
  const props = { recording: { active: false, audio: ['system'], controlVersion: 1 }, muted: true }
  let tree = f.render('HistoryControl', props)
  button(tree, 'Reanudar sin micrófono').props.onClick()
  tree = f.render('HistoryControl', props)
  assert.equal(button(tree, 'Confirmando').props.disabled, true)
  assert.equal(button(tree, 'Confirmando').props['aria-busy'], true)
  reject(new Error('Synthetic confirmation failed')); await new Promise(setImmediate)
  tree = f.render('HistoryControl', props)
  assert.match(text(tree), /Synthetic confirmation failed · Puedes reintentar/)
  assert.equal(button(tree, 'Reanudar').props.disabled, false)
  assert.deepEqual(f.events, [['history', true], ['error', 'Synthetic confirmation failed']])
})
