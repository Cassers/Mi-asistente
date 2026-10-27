import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = file => ts.transpileModule(readFileSync(new URL(`../src/ui/${file}.tsx`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const turns = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, role: i % 2 ? 'jarvis' : 'user', text: `${prefix} mensaje ${i}` }))
const noop = () => {}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}
const byClass = (tree, name) => nodes(tree).find(node => node.props?.className?.split(' ').includes(name))
const text = tree => nodes(tree).flatMap(node => React.Children.toArray(node.props?.children).filter(child => typeof child === 'string')).join(' ')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))

// Commit the actual component's hook effects against deterministic layout metrics.
// No browser, capture, bridge connection or model is created by this harness.
function harness() {
  const slots = []
  let cursor = 0, effects = [], tree, resize, renderAgain = false
  const state = { phase: 'speaking', conversationPaused: false, microphoneMuted: false, microphoneStandby: false,
    microphoneActive: true, microphoneBusy: false, caption: '', turns: turns('session', 12), activeTool: null, error: null,
    bootNote: '', gestures: false, looking: null, screenCapture: 'off', recording: null,
    ui: { background: null, chrome: { brand: true, transcript: true, suggestions: false, toolBadge: true } } }
  let height = 1200, top = 0
  const viewport = { clientHeight: 300, get scrollHeight() { return height },
    get scrollTop() { return top }, set scrollTop(value) { top = Math.max(0, Math.min(value, height - this.clientHeight)) } }
  const dialog = { open: false, showModal() { this.open = true }, close() {
    this.open = false; byClass(tree, 'settings-drawer').props.onClose()
  } }
  let focused = false, observed = [], disconnected = false
  const trigger = { focus() { focused = true } }
  function effect(callback, deps) {
    const index = cursor++
    const old = slots[index]
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
      effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: callback() } })
    }
  }
  const hooks = {
    ...React,
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value
        if (!Object.is(next, slots[i])) { slots[i] = next; renderAgain = true } }] },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
  }
  const panel = name => props => React.createElement('div', { 'data-panel': name }, props.children)
  const mocks = {
    react: hooks,
    'framer-motion': { AnimatePresence: ({ children }) => children,
      motion: { div: ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }) => React.createElement('div', props) } },
    '../store': { useStore: selector => selector(state), accentFor: () => '#67e8e3' },
    '../lib/profile': { useProfile: () => ({ configured: true, name: 'Diógenes' }), displayName: () => 'Diógenes', wakeWord: () => 'Diógenes' },
    '../lib/voice-input-mode': { useVoiceInputMode: () => 'transcript' },
    '../lib/brain': { setRecordingActive: () => assert.fail('must not record'), usingBridge: true },
    '../lib/projects': { useProjects: () => ({ available: true }) },
    '../lib/models': { useModels: () => ({ models: [], model: '', variant: '' }), chooseModel: noop, refreshModels: noop },
    '../lib/speech-settings': { useSpeechRate: () => 1, setSpeechRate: noop, resetSpeechRate: noop },
    '../lib/bridge': { permissionModeSnapshot: () => ({ mode: 'manual', connected: true }), subscribePermissionMode: noop,
      setPermissionMode: noop, conversationSnapshot: () => ({ chat: { id: 'one', entries: [] }, error: '' }),
      subscribeConversation: noop, chooseConversation: noop, deleteConversation: noop, refreshConversations: noop },
    './Suggestions': { Suggestions: () => null }, './Blades': { Blades: () => null, BladeSweep: () => null },
    './Effects': { Effects: () => null }, './Pointer': { Pointer: () => null }, './GestureGuide': { GestureGuide: () => null },
  }
  for (const name of ['ModelPicker', 'AssistantSettings', 'ConversationCard', 'ProjectPicker', 'TimingsPanel']) mocks[`./${name}`] = { [name]: panel(name) }
  const cache = {}
  function load(name) {
    if (cache[name]) return cache[name]
    const exports = {}
    vm.runInNewContext(compile(name), { exports,
      document: { documentElement: { style: { setProperty: noop, removeProperty: noop } } },
      ResizeObserver: class { constructor(callback) { resize = callback } observe(el) { observed.push(el) } disconnect() { disconnected = true } },
      require: id => mocks[id] || (id.startsWith('./') ? { [id.slice(2)]: load(id.slice(2)) } : require(id)),
    })
    return cache[name] = exports[name]
  }
  return {
    state, viewport, dialog, load,
    render(name = 'Hud', props = {}) {
      cursor = 0; effects = []; renderAgain = false
      tree = load(name)({ onPause: noop, onResume: noop, onToggleMicrophone: noop, ...props })
      for (const node of nodes(tree)) {
        if (!node.props?.ref) continue
        const targets = { log: viewport, 'log-content': {}, 'settings-drawer': dialog, 'settings-trigger': trigger }
        const target = node.props.className?.split(' ').map(name => targets[name]).find(Boolean)
        if (target) node.props.ref.current = target
      }
      for (const run of effects) run()
      if (renderAgain) return this.render(name, props)
      return tree
    },
    grow(by) { height += by }, resize() { resize() },
    scroll(value) { viewport.scrollTop = value; byClass(tree, 'log').props.onScroll() },
    get observed() { return observed }, get focused() { return focused },
    unmount() { for (const slot of slots) slot?.cleanup?.() }, get disconnected() { return disconnected },
  }
}

test('HUD renders every session turn, readable markup and wake standby without decorative rails', () => {
  const h = harness()
  h.state.turns = turns('full', 70)
  const html = renderToStaticMarkup(h.render())
  assert.equal((html.match(/<article /g) || []).length, 70)
  assert.match(html, /full mensaje 0/)
  assert.match(html, /full mensaje 69/)
  assert.match(html, /aria-label="Mensajes de la conversación"/)
  assert.doesNotMatch(html, /SYSTEMS|SIGNAL|class="hint"/)
  h.state.microphoneStandby = true
  assert.match(renderToStaticMarkup(h.render(undefined, { onToggleStandby: noop })), /SOLO ACTIVACIÓN · RESPONDING/)
  h.state.microphoneMuted = true
  const off = renderToStaticMarkup(h.render(undefined, { onToggleStandby: noop }))
  assert.match(off, /MICRÓFONO APAGADO/)
  assert.doesNotMatch(off, /hola, Diógenes|SOLO ACTIVACIÓN/)
})

test('scroll follows streamed answers near bottom; scrolling up holds position until explicit jump', () => {
  const h = harness()
  h.render()
  assert.equal(h.viewport.scrollTop, 900)
  assert.equal(h.observed.length, 2)
  h.scroll(850) // 50 px from bottom is within the 56 px threshold.
  h.grow(240)
  h.state.turns = [...h.state.turns.slice(0, -1), { ...h.state.turns.at(-1), text: 'respuesta ampliada' }]
  h.render()
  assert.equal(h.viewport.scrollTop, 1140)
  h.scroll(200)
  h.grow(400)
  h.state.turns = [...h.state.turns, { id: 'new-answer', role: 'jarvis', text: 'otra respuesta' }]
  let tree = h.render()
  assert.equal(h.viewport.scrollTop, 200)
  assert.ok(button(tree, 'Ir al último mensaje'))
  h.resize()
  assert.equal(h.viewport.scrollTop, 200, 'resize must not drag a reader back down')
  button(tree, 'Ir al último mensaje').props.onClick()
  tree = h.render()
  assert.equal(h.viewport.scrollTop, 1540)
  assert.equal(button(tree, 'Ir al último mensaje'), undefined)
  h.grow(120); h.resize()
  assert.equal(h.viewport.scrollTop, 1660, 'resized content follows again after jump')
  h.unmount(); assert.equal(h.disconnected, true)
})

test('returning near bottom resumes follow; crossing threshold keeps streamed content stationary', () => {
  const h = harness(); h.render()
  h.scroll(843) // 57 px from bottom.
  h.grow(100); h.state.turns = [...h.state.turns]; h.render()
  assert.equal(h.viewport.scrollTop, 843)
  h.scroll(960) // 40 px from new bottom.
  h.grow(100); h.state.turns = [...h.state.turns]; h.render()
  assert.equal(h.viewport.scrollTop, 1100)
})

test('conversation replacement or chatId change resets follow, while history trimming preserves reading', () => {
  const h = harness(); h.render(undefined, { chatId: 'a' }); h.scroll(100)
  h.state.turns = h.state.turns.slice(2)
  h.render(undefined, { chatId: 'a' })
  assert.equal(h.viewport.scrollTop, 100)
  h.state.turns = turns('replacement', 6)
  let tree = h.render(undefined, { chatId: 'a' })
  assert.equal(h.viewport.scrollTop, 900)
  assert.equal(button(tree, 'Ir al último mensaje'), undefined)
  h.scroll(100)
  h.render(undefined, { chatId: 'b' })
  assert.equal(h.viewport.scrollTop, 900, 'explicit session change works even with shared turn IDs')
  h.scroll(100); h.state.turns = []; h.render(undefined, { chatId: 'b' })
  h.state.turns = turns('after-empty', 4); tree = h.render(undefined, { chatId: 'b' })
  assert.equal(h.viewport.scrollTop, 900)
  assert.equal(button(tree, 'Ir al último mensaje'), undefined)
})

test('standby routes to soft action, hardoff stays separate, and hardoff/inactive never promise voice wake', () => {
  const h = harness(), Mic = h.load('MicrophoneControl')
  let soft = 0, hard = 0
  const props = { muted: false, busy: false, historyActive: false, name: 'Diógenes', onStandby: () => soft++, onToggle: () => hard++ }
  const active = Mic(props)
  button(active, 'Silenciar conversación').props.onClick()
  button(active, 'Apagar por completo').props.onClick()
  assert.equal(soft, 1); assert.equal(hard, 1)
  assert.match(renderToStaticMarkup(active), /impide reactivar por voz/)
  const standby = Mic({ ...props, standby: true })
  button(standby, 'Reactivar escucha').props.onClick()
  assert.equal(soft, 2)
  assert.match(renderToStaticMarkup(standby), /Di «hola, Diógenes» para reactivar\. El micrófono sigue escuchando la activación; la respuesta continúa\./)
  for (const mode of [{ muted: true }, { inactive: true }]) {
    const off = Mic({ ...props, standby: true, ...mode })
    button(off, 'Activar micrófono').props.onClick()
    assert.doesNotMatch(renderToStaticMarkup(off), /hola,|Reactivar escucha|Silenciar conversación/)
    assert.equal(button(off, 'Apagar por completo'), undefined)
  }
  assert.equal(hard, 3)
  const busy = Mic({ ...props, busy: true, standby: true })
  assert.equal(nodes(busy).filter(node => node.type === 'button' && node.props.disabled).length, 2)
})

test('standby stop cancels output without resuming capture, including previously paused conversation', () => {
  const h = harness(), Listening = h.load('ListeningControl')
  let stopped = 0
  for (const paused of [false, true]) {
    const tree = Listening({ standby: true, paused, muted: false, disabled: false, name: 'Diógenes',
      onPause: () => stopped++, onResume: () => assert.fail('stop must not resume') })
    button(tree, 'Detener respuesta').props.onClick()
    assert.match(renderToStaticMarkup(tree), /sin reactivar la escucha/)
  }
  assert.equal(stopped, 2)
})

test('settings start closed, retain panels and actions, and close/Escape/backdrop restore trigger focus', () => {
  const h = harness()
  let tree = h.render('ConversationsPanel')
  const html = renderToStaticMarkup(tree)
  assert.match(html, /Configuración/)
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/)
  assert.match(html, /<dialog[^>]*aria-labelledby="assistant-settings-title"/)
  assert.doesNotMatch(html, /<dialog[^>]*\sopen=/)
  for (const name of ['ProjectPicker', 'TimingsPanel', 'ConversationCard', 'ModelPicker', 'AssistantSettings']) {
    assert.match(html, new RegExp(`data-panel="${name}"`))
  }
  const card = nodes(tree).find(node => node.props?.onChoose)
  assert.equal(typeof card.props.onDelete, 'function')
  assert.equal(typeof card.props.onRefresh, 'function')
  const settings = nodes(tree).find(node => node.props?.onMode)
  assert.equal(typeof settings.props.onRate, 'function')
  assert.equal(typeof settings.props.onResetRate, 'function')
  for (const action of ['close', 'escape', 'backdrop']) {
    button(tree, 'Configuración').props.onClick()
    tree = h.render('ConversationsPanel')
    assert.equal(h.dialog.open, true)
    assert.equal(byClass(tree, 'settings-trigger').props['aria-expanded'], true)
    const drawer = byClass(tree, 'settings-drawer')
    let stopped = false
    drawer.props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped = true } })
    assert.equal(stopped, true, 'modal keys must not reach App voice shortcuts')
    if (action === 'close') button(tree, 'Cerrar').props.onClick()
    if (action === 'escape') {
      let prevented = false
      drawer.props.onCancel({ preventDefault: () => { prevented = true } })
      assert.equal(prevented, true)
    }
    if (action === 'backdrop') {
      const backdrop = {}
      drawer.props.onClick({ target: {}, currentTarget: backdrop })
      assert.equal(h.dialog.open, true, 'clicking panel contents must keep drawer open')
      drawer.props.onClick({ target: backdrop, currentTarget: backdrop })
    }
    tree = h.render('ConversationsPanel')
    assert.equal(h.dialog.open, false)
    assert.equal(byClass(tree, 'settings-trigger').props['aria-expanded'], false)
    assert.equal(h.focused, true)
  }
})

test('typed composer sends trimmed text on Enter, keeps failed drafts and preserves multiline/IME input', async () => {
  const h = harness()
  const sent = []
  let accepted = false, prevented = 0
  const props = { onSendMessage: message => { sent.push(message); return accepted } }
  let tree = h.render('MessageComposer', props)
  const textarea = () => nodes(tree).find(node => node.type === 'textarea')
  const key = extra => ({ key: 'Enter', repeat: false, shiftKey: false, nativeEvent: {},
    stopPropagation: noop, preventDefault: () => prevented++, ...extra })
  assert.equal(textarea().props['aria-label'], 'Escribe un mensaje')
  assert.equal(button(tree, 'Enviar').props.disabled, true)
  tree.props.onSubmit({ preventDefault: noop })
  assert.equal(sent.length, 0)
  textarea().props.onChange({ target: { value: '  mensaje\nsegunda línea  ' } })
  tree = h.render('MessageComposer', props)
  textarea().props.onKeyDown(key({ shiftKey: true }))
  textarea().props.onKeyDown(key({ repeat: true }))
  textarea().props.onKeyDown(key({ nativeEvent: { isComposing: true } }))
  textarea().props.onKeyDown(key({ nativeEvent: { keyCode: 229 } }))
  textarea().props.onCompositionStart()
  textarea().props.onKeyDown(key())
  assert.equal(sent.length, 0)
  assert.equal(prevented, 0, 'Shift+Enter and composition must retain their native behavior')
  textarea().props.onCompositionEnd()
  textarea().props.onKeyDown(key())
  await new Promise(setImmediate)
  tree = h.render('MessageComposer', props)
  assert.deepEqual(sent, ['mensaje\nsegunda línea'])
  assert.equal(textarea().props.value, '  mensaje\nsegunda línea  ', 'a rejected send retains the exact draft')
  accepted = true
  tree.props.onSubmit({ preventDefault: noop })
  await new Promise(setImmediate)
  tree = h.render('MessageComposer', props)
  assert.equal(textarea().props.value, '')
  assert.deepEqual(sent, ['mensaje\nsegunda línea', 'mensaje\nsegunda línea'])
})

test('typed input remains available offline with hard mute; pending recognized text keeps its separate action', () => {
  const h = harness()
  h.state.phase = 'offline'; h.state.microphoneMuted = true
  let tree = h.render(undefined, { onSendMessage: () => true })
  let html = renderToStaticMarkup(tree)
  assert.match(html, /aria-label="Escribe un mensaje"/)
  assert.doesNotMatch(html, /<textarea[^>]*disabled=/)
  h.state.phase = 'listening'; h.state.microphoneMuted = false; h.state.caption = 'pendiente reconocido'
  tree = h.render(undefined, { onSendMessage: () => true, onSubmitTranscript: noop })
  html = renderToStaticMarkup(tree)
  assert.match(html, /pendiente reconocido/)
  assert.match(html, /Enviar texto/)
  assert.match(html, /Escribe un mensaje/)
})

test('assistant replay uses the exact answer callback and stays disabled while output is busy', () => {
  const h = harness()
  h.state.turns = [
    { id: 'u', role: 'user', text: 'pregunta' },
    { id: 'a', role: 'jarvis', text: '**Respuesta** completa\ncon segunda línea' },
    { id: 'empty', role: 'jarvis', text: '  ' },
  ]
  let replayed = ''
  const props = { onReplay: answer => { replayed = answer } }
  for (const phase of ['thinking', 'tooling', 'speaking']) {
    h.state.phase = phase
    const tree = h.render(undefined, props)
    assert.equal(button(tree, 'Volver a leer').props.disabled, true)
  }
  h.state.phase = 'dormant'
  const tree = h.render(undefined, props)
  const actions = nodes(tree).filter(node => node.type === 'button' && node.props['aria-label'] === 'Volver a leer')
  assert.equal(actions.length, 1, 'user messages and empty assistant placeholders have no replay')
  assert.equal(actions[0].props.disabled, false)
  actions[0].props.onClick()
  assert.equal(replayed, h.state.turns[1].text)
})

test('minimizing preserves DOM, draft, history, reading position and controls without calling App actions', () => {
  const h = harness()
  const original = h.state.turns
  const props = { onSendMessage: () => true, onPause: () => assert.fail('must not pause'),
    onToggleMicrophone: () => assert.fail('must not toggle capture'), onToggleStandby: () => assert.fail('must not toggle standby') }
  let focused = 0
  let tree = h.render(undefined, props)
  h.scroll(123)
  button(tree, 'Minimizar chat').props.onClick({ currentTarget: { focus: () => focused++ } })
  tree = h.render(undefined, props)
  assert.equal(byClass(tree, 'conversation-content').props.hidden, true)
  assert.equal(byClass(tree, 'chat-visibility-toggle').props['aria-expanded'], false)
  assert.ok(nodes(tree).some(node => node.type === h.load('MessageComposer')), 'composer remains mounted with its draft')
  assert.ok(nodes(tree).some(node => node.type === h.load('MicrophoneControl')), 'essential voice controls stay outside hidden content')
  const html = renderToStaticMarkup(tree)
  assert.match(html, /id="assistant-chat" hidden=""/)
  assert.match(html, /session mensaje 0/)
  assert.equal(h.state.turns, original)
  h.scroll(0) // Hidden layout scroll events must not overwrite reading/follow state.
  h.grow(240); h.state.turns = [...h.state.turns]
  tree = h.render(undefined, props)
  button(tree, 'Mostrar chat').props.onClick({ currentTarget: { focus: () => focused++ } })
  tree = h.render(undefined, props)
  assert.equal(byClass(tree, 'conversation-content').props.hidden, false)
  assert.equal(h.viewport.scrollTop, 123)
  assert.equal(focused, 2)
})

test('async acceptance retains the draft until ack, blocks duplicates and preserves edits or failed dispatch', async () => {
  const h = harness()
  let resolve, calls = 0
  const ack = new Promise(done => { resolve = done })
  let outcome = () => ack
  const props = { onSendMessage: () => { calls++; return outcome() } }
  let tree = h.render('MessageComposer', props)
  const textarea = () => nodes(tree).find(node => node.type === 'textarea')
  textarea().props.onChange({ target: { value: 'primer mensaje' } })
  tree = h.render('MessageComposer', props)
  tree.props.onSubmit({ preventDefault: noop })
  tree = h.render('MessageComposer', props)
  assert.equal(tree.props['aria-busy'], true)
  assert.equal(textarea().props.value, 'primer mensaje')
  assert.equal(button(tree, 'Enviando…').props.disabled, true)
  tree.props.onSubmit({ preventDefault: noop })
  assert.equal(calls, 1, 'a second event cannot dispatch while acceptance is pending')
  textarea().props.onChange({ target: { value: 'nuevo borrador durante el envío' } })
  tree = h.render('MessageComposer', props)
  resolve(true); await new Promise(setImmediate)
  tree = h.render('MessageComposer', props)
  assert.equal(textarea().props.value, 'nuevo borrador durante el envío')
  assert.equal(tree.props['aria-busy'], false)
  for (const failed of [() => Promise.resolve(false), () => Promise.reject(new Error('dispatch failed'))]) {
    outcome = failed
    tree.props.onSubmit({ preventDefault: noop })
    await new Promise(setImmediate)
    tree = h.render('MessageComposer', props)
    assert.equal(textarea().props.value, 'nuevo borrador durante el envío')
    assert.equal(tree.props['aria-busy'], false)
  }
  outcome = () => Promise.resolve(true)
  tree.props.onSubmit({ preventDefault: noop })
  await new Promise(setImmediate)
  tree = h.render('MessageComposer', props)
  assert.equal(textarea().props.value, '')
})

test('microphone lifecycle shows text-only idle without masking typed response progress or promising wake', () => {
  const h = harness()
  h.state.microphoneActive = false
  h.state.microphoneMuted = false
  h.state.ui.chrome.suggestions = true
  for (const phase of ['offline', 'dormant']) {
    h.state.phase = phase
    const tree = h.render(undefined, { onToggleStandby: noop, onSendMessage: () => true })
    const html = renderToStaticMarkup(tree)
    assert.equal(nodes(tree).some(node => node.type?.name === 'Suggestions'), false, 'inactive capture must not advertise a wake prompt')
    assert.match(html, /SOLO TEXTO/)
    assert.match(html, /Activar micrófono/)
    assert.match(html, /Escribe un mensaje/)
    assert.doesNotMatch(html, /hola,|Silenciar conversación/)
  }
  for (const [phase, status] of [['thinking', 'PROCESSING'], ['tooling', 'ACCESSING SYSTEMS'], ['speaking', 'RESPONDING']]) {
    h.state.phase = phase
    const html = renderToStaticMarkup(h.render(undefined, { onToggleStandby: noop }))
    assert.match(html, new RegExp(status))
    assert.doesNotMatch(html, /SOLO TEXTO/)
    assert.match(html, /Detener respuesta/)
  }
})

test('composer keeps its pending draft on initial chat readiness but isolates drafts after a manual scope switch', async () => {
  const hud = harness()
  let accept, child, sends = 0
  const acceptance = new Promise(resolve => { accept = resolve })
  const onSendMessage = () => { sends++; return acceptance }
  // React preserves hook state for the same component type/key and remounts
  // when the key changes. Reconcile the actual HUD child against that boundary.
  const renderComposer = (chatId, composerScope) => {
    const tree = hud.render(undefined, { chatId, composerScope, onSendMessage })
    const node = nodes(tree).find(item => item.type === hud.load('MessageComposer'))
    assert.ok(node)
    if (!child || child.type !== node.type || child.key !== node.key) {
      child = { type: node.type, key: node.key, runtime: harness() }
    }
    return child.runtime.render('MessageComposer', node.props)
  }
  const textarea = tree => nodes(tree).find(node => node.type === 'textarea')
  let tree = renderComposer(undefined, 0)
  textarea(tree).props.onChange({ target: { value: 'mensaje pendiente antes de ready' } })
  tree = renderComposer(undefined, 0)
  tree.props.onSubmit({ preventDefault: noop })
  const openingInstance = child
  tree = renderComposer('chat-a', 0)
  assert.equal(child, openingInstance, 'server ready must not remount the composer')
  assert.equal(textarea(tree).props.value, 'mensaje pendiente antes de ready')
  assert.equal(tree.props['aria-busy'], true)
  assert.equal(sends, 1)

  tree = renderComposer(undefined, 1)
  assert.notEqual(child, openingInstance, 'manual destination change must create an independent composer')
  assert.equal(textarea(tree).props.value, '')
  assert.equal(tree.props['aria-busy'], false)
  textarea(tree).props.onChange({ target: { value: 'borrador del nuevo chat' } })
  const switchedInstance = child
  accept(true)
  await new Promise(setImmediate)
  tree = renderComposer('chat-b', 1)
  assert.equal(child, switchedInstance)
  assert.equal(textarea(tree).props.value, 'borrador del nuevo chat', 'old acceptance cannot clear the new destination draft')
  assert.equal(tree.props['aria-busy'], false)
})
