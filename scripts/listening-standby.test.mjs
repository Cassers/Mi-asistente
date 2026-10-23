import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const policy = {}
vm.runInNewContext(compile(readFileSync(new URL('../src/lib/listening-policy.ts', import.meta.url), 'utf8')), { exports: policy })
const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const needed = new Set(['goDormant', 'pauseConversation', 'mode', 'onWake', 'onSpeechStart', 'onUtterance', 'onPartial', 'onKey'])
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && needed.has(node.name.getText(source))) declarations.set(node.name.getText(source), node.initializer.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function harness(configured = true) {
  const events = [], questions = []
  const state = { phase: 'speaking', conversationPaused: false, caption: 'old partial', activeTool: 'read', screenCapture: 'attached' }
  for (const [method, property] of [['setPhase','phase'],['setConversationPaused','conversationPaused'],['setCaption','caption'],['setActiveTool','activeTool'],['setScreenCapture','screenCapture']]) state[method] = value => { state[property] = value }
  state.setError = () => {}
  const profile = { ...DEFAULT_PROFILE, configured, name: 'Diógenes' }
  const context = { store: { getState: () => state }, turn: { current: 10 }, clearIdle: () => events.push('clearIdle'),
    silence: () => events.push('cancelSpeech'), interrupt: () => events.push('interruptBackend'), music: { working() {}, duck() {} },
    sfx: { play() {}, duck() {} }, currentProfile: () => profile, listeningMode: policy.listeningMode, wakePattern,
    respond: said => questions.push(said), listen: () => { state.phase = 'listening' }, AWAIT_SPEECH_MS: 14000,
    speaker: { current: null }, createSpeaker: () => ({ say() {}, end: async () => {} }), attention: () => '',
    voice: { current: { reset: () => events.push('clearRecognition') } },
    powerOn: () => events.push('powerOn'), cycleVoice() {}, hands: {}, currentVoiceName() {}, window: {},
  }
  const code = [...declarations].map(([name, value]) => `const ${name} = ${value};`).join('\n') + `\nglobalThis.handlers = {${[...needed].join(',')}};`
  vm.runInNewContext(compile(code), context)
  return { ...context, ...context.handlers, state, events, questions }
}

test('explicit standby stays wake-only even before first-chat configuration; offline stays deaf', () => {
  for (const configured of [false, true]) {
    for (const phase of ['dormant','listening','speaking','tooling','thinking']) assert.equal(policy.listeningMode(phase, configured, true), 'wake')
    for (const phase of ['offline','boot']) assert.equal(policy.listeningMode(phase, configured, true), 'deaf')
  }
  assert.equal(policy.listeningMode('dormant', false, false), 'command')
  assert.equal(policy.listeningMode('listening', true, false), 'command')
})
test('pause cancels turn and speech; stale speech callbacks cannot start questions or captions', () => {
  const app = harness(false)
  app.pauseConversation()
  assert.equal(app.state.conversationPaused, true)
  assert.equal(app.state.phase, 'dormant')
  assert.equal(app.mode(), 'wake')
  assert.equal(app.turn.current, 11, 'old awaited turn must become stale')
  assert.ok(app.events.includes('interruptBackend'))
  assert.ok(app.events.includes('cancelSpeech'))
  assert.ok(app.events.includes('clearRecognition'))
  app.onSpeechStart(); app.onPartial('stale'); app.onUtterance('no enviar esto')
  assert.equal(app.state.phase, 'dormant'); assert.equal(app.state.caption, '')
  assert.equal(app.questions.length, 0)
  app.onWake('explícame esto')
  assert.equal(app.state.conversationPaused, false)
  assert.deepEqual(app.questions, ['explícame esto'])
})
test('Space resumes standby; text inputs/selects and modified Space do not wake it', () => {
  const app = harness(); app.pauseConversation()
  const key = tagName => ({ target: { tagName }, code: 'Space', key: ' ', preventDefault() {} })
  for (const tag of ['INPUT','TEXTAREA','SELECT','BUTTON']) app.onKey(key(tag))
  app.onKey({ ...key('DIV'), ctrlKey: true })
  app.onKey({ ...key('DIV'), target: { tagName: 'DIV', isContentEditable: true } })
  assert.equal(app.state.conversationPaused, true)
  app.onKey(key('DIV'))
  assert.equal(app.state.conversationPaused, false)
  assert.equal(app.state.phase, 'listening')
})
