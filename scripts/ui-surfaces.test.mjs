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
  }).outputText, { exports, require: id => id === './projects' ? { selectedProject: () => null, subscribeProjects: () => () => {} } : require(id) })
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
    if (id === '../lib/native-input') return pureModule('native-input')
    if (id === '../lib/model-search') return pureModule('model-search')
    if (id === '../lib/voice-input-mode') return pureModule('voice-input-mode')
    if (id === './NativeInputPrompt') return { NativeInputPrompt: component('NativeInputPrompt', 'NativeInputPrompt') }
    if (id === './VoiceInputControl') return { VoiceInputControl: component('VoiceInputControl', 'VoiceInputControl') }
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
const Microphone = component('MicrophoneControl', 'MicrophoneControl')
const VoiceInput = component('VoiceInputControl', 'VoiceInputControl')
const History = component('CaptureControls', 'HistoryControl')
const Screen = component('CaptureControls', 'ScreenControl')
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))

test('voice input choice is labelled, defaults to direct audio, explains interruption and exposes status', () => {
  const html = render(VoiceInput, {})
  assert.match(html, /Cómo enviar mi voz/)
  assert.match(html, /<label for="([^"]+)"/)
  assert.match(html, /value="direct" selected=""/)
  assert.match(html, /Audio directo · responde en cada pausa/)
  assert.match(html, /Solo transcripción/)
  assert.match(html, /aria-describedby=/)
  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(render(VoiceInput, { disabled: true }), /<select[^>]*disabled=""/)
})
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

test('native clients may observe and leave busy conversations without enabling deletion', () => {
  const html = render(Card, { ...props, observeBusy: true, deleteLocked: true, onStop() {} })
  assert.doesNotMatch(html, /<option value="two" disabled/)
  assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 1)
  assert.doesNotMatch(html, /<select[^>]*disabled/)
  assert.match(html, /Detener respuesta/)
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
test('Markdown tables render real columns, formatting and accessible horizontal scrolling', () => {
  const html = render(Response, { text: 'Resumen\n| Pregunta | Cavalry | Flier |\n| :--- | :---: | ---: |\n| Enemy raids | **Retreat** | *Counterattack* |\n| Life | Charity | Glory |\n\nDespués.' })
  for (const pattern of [/role="region"/, /aria-label="Tabla de la respuesta"/, /tabindex="0"/,
    /<table>/, /<thead>/, /<th scope="col" style="text-align:left">Pregunta/,
    /text-align:center/, /text-align:right/, /<strong>Retreat<\/strong>/, /<em>Counterattack<\/em>/,
    /<p>Resumen<\/p>/, /<p>Después\.<\/p>/]) assert.match(html, pattern)
  assert.equal((html.match(/<th scope=/g) || []).length, 3)
  assert.equal((html.match(/<td /g) || []).length, 6)
  assert.doesNotMatch(html, /\||:---/)
})

test('table parsing handles optional borders, escaped and code pipes, and incomplete streamed rows', () => {
  const html = render(Response, { text: 'A | B | C\n--- | --- | ---\nuno \\| dos | `x|y` | tres\nparcial | dato' })
  assert.match(html, /uno \| dos/)
  assert.match(html, /<code>x\|y<\/code>/)
  assert.equal((html.match(/<td /g) || []).length, 6)
  assert.match(html, /<td style="text-align:left"><\/td>/)
  for (const text of ['A | B\n--- | todavía', 'A | B\n---', 'A | B\n--- | --- | ---', 'a | b']) {
    assert.doesNotMatch(render(Response, { text }), /<table>/)
  }
  const overfull = render(Response, { text: 'A | B\n--- | ---\n1 | 2 | NO PERDER' })
  assert.match(overfull, /NO PERDER/)
})

test('tables escape untrusted content; fenced tables remain code; prose after a table is preserved', () => {
  const html = render(Response, { text: '| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [malo](javascript:alert(1)) |\nFinal.\n\n```\nA | B\n--- | ---\n1 | 2\n```' })
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img|href="javascript:/)
  assert.match(html, /<p>Final\.<\/p>/)
  assert.match(html, /<pre><code>A \| B/)
  assert.equal((html.match(/<table>/g) || []).length, 1)
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

test('microphone control clearly separates hard capture stop from wake standby', () => {
  const props = { muted: false, busy: false, historyActive: false, onToggle() {} }
  const active = render(Microphone, props)
  assert.match(active, /Apagar micrófono/)
  assert.match(active, /aria-pressed="true"/)
  const muted = render(Microphone, { ...props, muted: true })
  assert.match(muted, /Activar micrófono/)
  assert.match(muted, /no escucha ni su nombre/)
  assert.match(muted, /La respuesta continúa/)
  assert.match(muted, /Historial pausado/)
  assert.match(muted, /aria-pressed="false"/)
  assert.match(render(Microphone, { ...props, muted: true, historyActive: true }), /esperando confirmación de pausa/)
  assert.match(render(Microphone, { ...props, muted: true, historyActive: true, historyMicrophone: false }), /Historial activo sin micrófono/)
  assert.match(render(Microphone, { ...props, busy: true }), /disabled=""/)
})

test('stopping output is a separate visible action even when input is muted', () => {
  const muted = render(Listening, { muted: true, paused: false, disabled: false,
    name: 'Asistente', onPause() {}, onResume() {} })
  assert.match(muted, /Detener respuesta/)
  assert.match(muted, /sin activar el micrófono/)
  assert.doesNotMatch(muted, /El micrófono sigue activo|Reanudar conversación/)
})

test('Codex exposes its application, account, native reasoning and recoverable archive labels', () => {
  const model = { id: 'native-codex', name: 'Native Codex model', provider: 'Codex', free: false, variants: ['low', 'xhigh'], image: true, audio: false }
  const html = render(Picker, { application: 'codex', onApplication() {}, models: [model], model: model.id, variant: 'xhigh', locked: false, loading: false, error: '', onChoose() {}, onRefresh() {} })
  assert.match(html, /Codex · Native Codex model · Muy alto/)
  assert.match(html, /value="codex" selected=""/)
  assert.match(html, /cuenta configurada en Codex/)
  assert.doesNotMatch(html, /única aplicación|cuenta configurada en OpenCode/)
  const archived = render(Card, { id: 'codex-thread', entries: [], locked: false, status: 'Historial nativo de Codex', error: '', onChoose() {}, onRefresh() {}, onDelete() {}, removeLabel: 'Archivar' })
  assert.match(archived, /Archivar/); assert.doesNotMatch(archived, />Eliminar</)
})

test('native Codex questions render escaped prompts, secret password fields and explicit response actions', () => {
  const Input = component('NativeInputPrompt', 'NativeInputPrompt')
  const html = render(Input, { request: { id: 'codex:number:1', permission: 'user_input', patterns: [], metadata: { questions: [
    { id: 'secret', question: '<script>clave</script>', isSecret: true, options: null },
    { id: 'choice', question: 'Elige una opción', isOther: true, options: [{ label: 'Uno', description: 'Primera' }] },
  ] } } })
  assert.match(html, /Codex necesita tu respuesta/)
  assert.match(html, /type="password"/)
  assert.match(html, /&lt;script&gt;clave&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|Autorizar solo esta vez/)
  assert.match(html, /Cancelar solicitud/); assert.match(html, /Enviar respuestas/)
  assert.match(html, /Escribir otra respuesta/)
})

test('Codex voice selector forces browser transcription and disables direct without changing OpenCode', () => {
  const html = render(VoiceInput, { application: 'codex' })
  assert.match(html, /<option value="direct" disabled=""/)
  assert.match(html, /value="transcript" selected=""/)
  assert.match(html, /Codex usa solo el dictado del navegador/)
  assert.match(html, /elección de OpenCode se conserva/)
  const open = render(VoiceInput, { application: 'opencode' })
  assert.match(open, /value="direct" selected=""/)
  assert.doesNotMatch(open, /<option value="direct" disabled/)
})

test('Codex voice policy stays transcription-only for compatible, unsupported and native-default models', () => {
  const props = { application: 'codex', variant: '', locked: false, loading: false, error: '', onChoose() {}, onRefresh() {} }
  for (const option of [
    { id: 'audio', audio: true }, { id: 'text', audio: false }, { id: 'native/default', audio: false },
  ]) {
    const model = { ...option, name: 'Fixture', provider: 'Codex', image: true, variants: [] }
    const html = render(Picker, { ...props, models: [model], model: model.id })
    assert.match(html, /Codex usa solo el dictado del navegador/)
    assert.match(html, /Audio directo deshabilitado/)
    assert.doesNotMatch(html, /Audio directo: cada pausa/)
  }
})


test('history resumes in standby or without microphone after hard off; old bridge stays safely blocked', () => {
  const recording = { active: false, fps: 0, root: '/fixture', controlVersion: 1 }
  const standby = render(History, { recording, muted: false })
  assert.match(standby, /Historial pausado · Reanudar/)
  assert.doesNotMatch(standby, /disabled=""/)
  const muted = render(History, { recording, muted: true })
  assert.doesNotMatch(muted, /disabled=""/)
  assert.match(muted, /Reanudar sin micrófono/)
  assert.match(muted, /pantalla y sonido del PC, sin micrófono/)
  const legacy = render(History, { recording: { ...recording, controlVersion: undefined }, muted: true })
  assert.match(legacy, /disabled=""/); assert.match(legacy, /Reinicia el puente/)
  assert.doesNotMatch(render(History, { recording: { ...recording, active: true }, muted: true }), /disabled=""/)
  assert.match(render(History, { recording: { ...recording, error: 'Captura denegada' }, muted: false }), /role="alert".*Captura denegada/)
})
test('per-turn screen control exposes explicit opt-in, privacy scope and disable action', () => {
  const off = render(Screen, { enabled: false, onChange() {} })
  assert.match(off, /aria-pressed="false"/); assert.match(off, /Compartir pantalla apagado · Activar/)
  assert.match(off, /No inicia el historial ni el micrófono/)
  assert.match(off, /Envía una captura del monitor principal con cada pregunta/)
  assert.match(render(Screen, { enabled: true, onChange() {} }), /Compartir pantalla activo · Desactivar/)
})
