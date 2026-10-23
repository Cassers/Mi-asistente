import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function pureModule(name) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports })
  return exports
}
function component(file, name) {
  const source = readFileSync(new URL(`../src/ui/${file}.tsx`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require: id => {
    if (id === '../lib/brain') return { replyPermission: () => assert.fail('render must never authorize') }
    if (id === '../store') return {}
    if (id === '../lib/model-search') return pureModule('model-search')
    if (id === './SearchableModelSelect') return { SearchableModelSelect: component('SearchableModelSelect', 'SearchableModelSelect') }
    return require(id)
  } })
  return exports[name]
}
const Card = component('ConversationCard', 'ConversationCard')
const Dialog = component('PermissionPrompt', 'PermissionDialog')
const Response = component('ResponseText', 'ResponseText')
const Picker = component('ModelPicker', 'ModelPicker')
const Searchable = component('SearchableModelSelect', 'SearchableModelSelect')
const { filterModels } = pureModule('model-search')
const Settings = component('AssistantSettings', 'AssistantSettings')
const Listening = component('ListeningControl', 'ListeningControl')
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))
const props = { id: 'one', entries: [{ id: 'one', title: 'Conversación actual', busy: true },
  { id: 'two', title: 'Otra ventana', busy: true }], locked: false, status: 'Chat guardado', error: '',
  onChoose() {}, onRefresh() {}, onDelete() {} }

test('conversation controls have labelled native selection and explicit actions', () => {
  const html = render(Card, props)
  assert.match(html, /aria-label="Conversaciones guardadas"/)
  assert.match(html, /aria-label="Elegir conversación"/)
  assert.match(html, /Nuevo chat/)
  assert.match(html, /Eliminar/)
  assert.match(html, /<option value="two" disabled=""/)
  assert.doesNotMatch(html, /<option value="one" disabled/)
})
test('busy chat disables changing, creating and deleting without removing context', () => {
  const html = render(Card, { ...props, locked: true, status: 'Respuesta en curso' })
  assert.match(html, /aria-busy="true"/)
  assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 2)
  assert.match(html, /<select[^>]*disabled=""/)
  assert.match(html, /Respuesta en curso/)
})
test('connection recovery leaves new-chat available and escapes error text', () => {
  const html = render(Card, { ...props, id: '', entries: [], error: '<script>alert(1)</script>' })
  assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 1)
  assert.match(html, /Sin conexión/)
  assert.match(html, /role="alert"/)
  assert.doesNotMatch(html, /<script>/)
})
test('permission dialog preserves full untrusted command, scope and one-use approval', () => {
  const command = 'printf "<script>untrusted</script>"'
  const html = render(Dialog, { request: { id: 'test', permission: 'bash', patterns: ['printf *'], metadata: { command } }, count: 2 })
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-describedby="permission-description"/)
  assert.match(html, /POR AUTORIZAR/)
  assert.match(html, /Rechazar/)
  assert.match(html, /Autorizar solo esta vez/)
  assert.match(html, /2 solicitudes pendientes/)
  assert.match(html, /printf \*/)
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|Autorizar siempre/)
})

test('responses render paragraphs, headings, lists, emphasis and code without executable HTML', () => {
  const html = render(Response, { text: '# Título\n\nHola **mundo**.\n\n- Uno\n- Dos\n\n1. Paso\n\n---\n\n```js\nalert("<script>")\n```\n\n<script>malicioso</script>\n[seguro](https://example.com)\n[malo](javascript:alert(1))' })
  for (const pattern of [/<h3>Título<\/h3>/, /<strong>mundo<\/strong>/, /<ul><li>Uno/, /<ol><li>Paso/, /<hr\/>/, /<pre><code>/, /rel="noopener noreferrer"/]) assert.match(html, pattern)
  assert.doesNotMatch(html, /<script>|href="javascript:/)
  assert.match(html, /&lt;script&gt;malicioso/)
  assert.doesNotThrow(() => render(Response, { text: '- \n1. \n```' }))
})
test('model picker exposes only declared thinking variants and warns for text-only models', () => {
  const models = [{ id: 'free', name: 'Modelo gratuito', image: false, audio: false, variants: ['low', 'high'] }]
  const html = render(Picker, { models, model: 'free', variant: 'low', loading: false, error: '', locked: false, onChoose() {}, onRefresh() {} })
  assert.match(html, /id="assistant-application" disabled=""/)
  assert.match(html, /value="opencode" selected="">OpenCode/)
  assert.match(html, /Solo texto: no recibirá la captura/)
  assert.match(html, /value="low" selected=""/)
  assert.doesNotMatch(html, /value="max"/)
  const noVariants = render(Picker, { models: [{ ...models[0], variants: [] }], model: 'free', variant: '', locked: false })
  assert.match(noVariants, /no expone niveles ajustables/)
  assert.match(noVariants, /id="assistant-thinking" disabled=""/)
})

test('model selector is an editable labelled combobox, not an unbounded native menu', () => {
  const html = render(Searchable, { models: [{ id: 'a', provider: 'OpenCode', name: 'MiMo Free' }], model: 'a', disabled: false, onChoose() {}, onRefresh() {} })
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-autocomplete="list"/)
  assert.match(html, /value="OpenCode · MiMo Free"/)
  assert.doesNotMatch(html, /<select/)
})

test('model search matches model, provider and ID, ignoring accents/case; all terms must match', () => {
  const models = [{ id: 'opencode/mimo-free', name: 'MiMo V2.6 Flash', provider: 'OpenCode', free: true },
    { id: 'openai/gpt-6', name: 'GPT-6', provider: 'OpenAI', free: false },
    { id: 'google/gemini', name: 'Gémini', provider: 'Google', free: false }]
  assert.equal(filterModels(models, 'MIMO')[0].id, models[0].id)
  assert.equal(filterModels(models, 'opencode flash gratis').length, 1)
  assert.equal(filterModels(models, 'gemini')[0].id, models[2].id)
  assert.equal(filterModels(models, 'OpenAI gpt-6')[0].id, models[1].id)
  assert.equal(filterModels(models, 'no-existe').length, 0)
  assert.equal(filterModels(models, '').length, 3)
})

test('settings expose a bounded voice slider, transient modes and explicit total-mode warning', () => {
  const props = { mode: 'manual', connected: true, pending: false, error: '', autoApproved: 0, rate: 1.2, onMode() {}, onRate() {}, onResetRate() {} }
  const html = render(Settings, props)
  assert.match(html, /type="range" min="0.5" max="2" step="0.05"/)
  assert.match(html, /Velocidad de voz/)
  assert.match(html, /value="manual" selected=""/)
  assert.match(html, /value="total"/)
  assert.match(html, /Al recargar, reconectar o cambiar de chat vuelve a Manual/)
  const total = render(Settings, { ...props, mode: 'total', autoApproved: 2 })
  assert.match(total, /ATENCIÓN: puede ejecutar comandos, modificar o borrar archivos/)
  assert.match(total, /Volver a Manual/)
  assert.match(total, /2 aprobaciones automáticas/)
  const offline = render(Settings, { ...props, connected: false })
  assert.match(offline, /id="assistant-permission-mode" disabled=""/)
})

test('conversation pause is honestly labelled as wake standby, never a hardware mic mute', () => {
  const base = { paused: false, disabled: false, name: 'Diógenes', onPause() {}, onResume() {} }
  const running = render(Listening, base)
  assert.match(running, /Pausar conversación/)
  assert.match(running, /El micrófono sigue activo/)
  const paused = render(Listening, { ...base, paused: true })
  assert.match(paused, /aria-pressed="true"/)
  assert.match(paused, /Reanudar conversación/)
  assert.match(paused, /Solo activación: di “Diógenes” o pulsa Espacio/)
  assert.match(paused, /historial se controla aparte/)
  assert.match(render(Listening, { ...base, disabled: true }), /disabled=""/)
})
