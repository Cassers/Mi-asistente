import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_PROFILE, wakePattern } from '../shared/profile.mjs'
import { voiceTimingStub } from './timing-fixture.mjs'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const policy = {}
vm.runInNewContext(compile(readFileSync(new URL('../src/lib/listening-policy.ts', import.meta.url), 'utf8')), { exports: policy })
const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const needed = new Set(['goDormant', 'pauseConversation', 'pauseHistoryForPrivacy', 'toggleMicrophone', 'toggleStandby', 'startCapture', 'mode', 'onWake', 'onSpeechStart', 'onUtterance', 'onPartial', 'sendTranscript', 'onKey'])
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && needed.has(node.name.getText(source))) declarations.set(node.name.getText(source), node.initializer.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function harness(configured = true, capturedClip) {
  const responseInputs = []
  let consumed = 0
  const events = [], questions = []
  const state = { phase: 'speaking', conversationPaused: false, microphoneMuted: false, microphoneActive: true, microphoneStandby: false, microphoneBusy: false, caption: 'old partial', activeTool: 'read', screenCapture: 'attached' }
  for (const [method, property] of [['setPhase','phase'],['setConversationPaused','conversationPaused'],['setCaption','caption'],['setActiveTool','activeTool'],['setScreenCapture','screenCapture'],['setMicrophoneMuted','microphoneMuted'],['setMicrophoneActive','microphoneActive'],['setMicrophoneStandby','microphoneStandby'],['setMicrophoneBusy','microphoneBusy'],['setLevel','level']]) state[method] = value => { state[property] = value }
  state.setError = () => {}
  const profile = { ...DEFAULT_PROFILE, configured, name: 'Diógenes' }
  const context = { currentVoiceInputMode: () => state.inputMode || 'transcript', followup: { current: false }, activeTurnTiming: { current: null }, ...voiceTimingStub(), store: { getState: () => state }, turn: { current: 10 }, clearIdle: () => events.push('clearIdle'),
    silence: () => events.push('cancelSpeech'), interrupt: () => events.push('interruptBackend'), music: { working() {}, duck() {} },
    sfx: { play() {}, duck() {} }, currentProfile: () => profile, listeningMode: policy.listeningMode, wakePattern,
    respond: (...args) => { responseInputs.push(args); questions.push(args[0]) }, listen: () => { state.phase = 'listening' }, AWAIT_SPEECH_MS: 14000,
    markUtteranceAudio: () => events.push('markVoiceClip'), takeUtteranceAudio: () => { consumed++; return capturedClip },
    resetUtteranceAudio: () => events.push('discardVoiceClip'),
    speaker: { current: null }, createSpeaker: () => ({ say() {}, end: async () => {} }), attention: () => '',
    voice: { current: { commit: () => { events.push('commitPending'); return true }, reset: () => events.push('clearRecognition'), stop: () => events.push('stopCapture'), start: async () => { events.push('startCapture'); return true } } },
    setMicBlocked: blocked => events.push(blocked ? 'blockMic' : 'allowMic'),
    setRecordingActive: async active => events.push(active ? 'resumeHistory' : 'pauseHistory'),
    powerOn: () => events.push('powerOn'), cycleVoice() {}, hands: {}, currentVoiceName() {}, window: {},
  }
  const code = [...declarations].map(([name, value]) => `const ${name} = ${value};`).join('\n') + `\nglobalThis.handlers = {${[...needed].join(',')}};`
  vm.runInNewContext(compile(code), context)
  return { ...context, ...context.handlers, state, events, questions, responseInputs, consumed: () => consumed }
}

test('explicit standby stays wake-only even before first-chat configuration; offline stays deaf', () => {
  for (const configured of [false, true]) {
    for (const phase of ['dormant','listening','speaking','tooling','thinking']) assert.equal(policy.listeningMode(phase, configured, true), 'wake')
    for (const phase of ['offline','boot']) assert.equal(policy.listeningMode(phase, configured, true), 'deaf')
  }
  assert.equal(policy.listeningMode('dormant', false, false), 'command')
  assert.equal(policy.listeningMode('listening', true, false), 'command')
})

test('manual text send commits pending recognition only; mute, pause and direct mode cannot send a caption', () => {
  const app = harness()
  app.state.phase = 'listening'; app.state.caption = 'status text must never be submitted'
  assert.equal(app.sendTranscript(), true)
  assert.deepEqual(app.questions, [], 'App delegates to recognizer pending text instead of submitting its displayed caption')
  app.events.length = 0
  for (const patch of [{ microphoneMuted: true }, { conversationPaused: true }, { inputMode: 'direct' }, { phase: 'thinking' }]) {
    const before = { ...app.state }; Object.assign(app.state, patch)
    assert.equal(app.sendTranscript(), false)
    Object.assign(app.state, before)
  }
  assert.deepEqual(app.events, [])
})

test('Enter commits one pending transcript without hijacking input fields, repeated keys or normal buttons', () => {
  const app = harness(); app.state.phase = 'listening'
  let prevented = 0
  const key = { key: 'Enter', code: 'Enter', repeat: false, target: { tagName: 'DIV' }, preventDefault: () => prevented++ }
  app.onKey(key)
  for (const tagName of ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT']) app.onKey({ ...key, target: { tagName } })
  app.onKey({ ...key, repeat: true }); app.onKey({ ...key, ctrlKey: true })
  assert.equal(app.events.filter(event => event === 'commitPending').length, 1)
  assert.equal(prevented, 1)
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

test('microphone button stops input/history but preserves the answer, turn and speaker', async () => {
  const app = harness()
  await app.toggleMicrophone()
  assert.equal(app.state.microphoneMuted, true)
  assert.equal(app.mode(), 'deaf')
  assert.equal(app.turn.current, 10, 'the active answer must not become stale')
  for (const event of ['stopCapture', 'blockMic', 'pauseHistory']) assert.ok(app.events.includes(event), event)
  for (const event of ['interruptBackend', 'cancelSpeech']) assert.ok(!app.events.includes(event), event)
  app.onWake('no enviar'); app.onUtterance('no enviar'); app.onPartial('no mostrar'); app.onSpeechStart()
  app.onKey({ target: { tagName: 'DIV' }, code: 'Space', key: ' ', preventDefault() {} })
  assert.deepEqual(app.questions, [])
  assert.equal(app.state.caption, '')
  assert.equal(app.state.microphoneMuted, true)
  assert.equal(app.state.phase, 'speaking')
  app.state.phase = 'dormant' // the answer finished normally while input was off
  await app.toggleMicrophone()
  assert.equal(app.state.microphoneMuted, false)
  assert.equal(app.state.microphoneBusy, false)
  assert.equal(app.state.phase, 'listening')
  assert.ok(app.events.includes('startCapture'))
  assert.ok(!app.events.includes('resumeHistory'), 'never resume continuous recording implicitly')
  app.onUtterance('nueva pregunta')
  assert.deepEqual(app.questions, ['nueva pregunta'])
})

test('off/on never replaces thinking, tooling or speaking with listening', async () => {
  for (const phase of ['thinking', 'tooling', 'speaking']) {
    const app = harness()
    app.state.phase = phase
    await app.toggleMicrophone()
    assert.equal(app.state.phase, phase)
    await app.toggleMicrophone()
    assert.equal(app.state.phase, phase)
    assert.equal(app.turn.current, 10)
    assert.ok(!app.events.includes('interruptBackend'))
    assert.ok(!app.events.includes('cancelSpeech'))
  }
})

test('explicit stop remains available with microphone off and is the action that cancels the response', async () => {
  const app = harness()
  await app.toggleMicrophone()
  app.pauseConversation()
  assert.equal(app.state.microphoneMuted, true)
  assert.equal(app.state.phase, 'dormant')
  assert.equal(app.turn.current, 11)
  assert.ok(app.events.includes('interruptBackend'))
  assert.ok(app.events.includes('cancelSpeech'))
  assert.ok(!app.events.includes('startCapture'))
})


test('voice standby preserves ongoing output, listens only for activation and never dispatches classroom speech', () => {
  const app = harness()
  app.toggleStandby()
  assert.equal(app.state.microphoneStandby, true)
  assert.equal(app.state.microphoneMuted, false)
  assert.equal(app.state.microphoneActive, true)
  assert.equal(app.state.phase, 'speaking')
  assert.equal(app.mode(), 'wake')
  app.onSpeechStart(); app.onUtterance('hablando con estudiantes'); app.onPartial('privado')
  assert.deepEqual(app.questions, [])
  assert.equal(app.turn.current, 10)
  assert.ok(!app.events.includes('stopCapture'))
  assert.ok(!app.events.includes('cancelSpeech'))
  assert.ok(!app.events.includes('interruptBackend'))
  app.onWake('')
  assert.equal(app.state.microphoneStandby, false)
  assert.equal(app.state.phase, 'speaking', 'wake alone cannot cut an answer')
  assert.ok(!app.events.includes('cancelSpeech'))
})

test('standby can be resumed by button, and hard off cannot become voice standby', async () => {
  const app = harness(); app.state.phase = 'listening'
  app.toggleStandby(); app.toggleStandby()
  assert.equal(app.state.microphoneStandby, false)
  assert.equal(app.state.phase, 'listening')
  await app.toggleMicrophone()
  app.toggleStandby()
  assert.equal(app.mode(), 'deaf')
  assert.equal(app.state.microphoneStandby, false)
})

test('standby activation requires hola plus the current name, including escaped names and word boundaries', () => {
  const profile = { ...DEFAULT_PROFILE, name: 'Diógenes' }
  const greeting = wakePattern(profile, 'greeting')
  for (const text of ['hola Diógenes', '¡Hola, Diógenes! explícame', 'hola diógenes, sigue']) assert.ok(greeting.test(text), text)
  for (const text of ['Diógenes', 'mencionaron a Diógenes', 'hola asistente', 'hola DiógenesExtra', 'estudiantes hola Diógenes']) assert.ok(!greeting.test(text), text)
  const custom = wakePattern({ ...profile, name: 'A+B' }, 'greeting')
  assert.ok(custom.test('hola, A+B')); assert.ok(!custom.test('hola, AAAB'))
})


test('Space resumes voice standby during playback without stopping output or leaving standby latched', () => {
  const app = harness(); app.toggleStandby()
  app.onKey({ target: { tagName: 'DIV' }, code: 'Space', key: ' ', preventDefault() {} })
  assert.equal(app.state.microphoneStandby, false)
  assert.equal(app.state.phase, 'speaking')
  assert.ok(!app.events.includes('cancelSpeech')); assert.ok(!app.events.includes('interruptBackend'))
})

test('direct name-only activation preserves PCM and playback for a delayed question caption', () => {
  const app = harness(); app.state.inputMode = 'direct'; app.toggleStandby()
  app.events.length = 0
  app.onWake('')
  assert.equal(app.state.microphoneStandby, false); assert.equal(app.state.phase, 'speaking')
  assert.ok(!app.events.includes('clearRecognition')); assert.ok(!app.events.includes('cancelSpeech'))
})

test('Codex transcript wake-name plus question consumes available PCM and forwards only fresh recognized text', () => {
  const app = harness(true, { mime: 'audio/wav', data: 'captured-wake-pcm' })
  app.state.phase = 'dormant'; app.state.inputMode = 'transcript'; app.state.microphoneStandby = true
  const words = 'hola Diógenes explica las funciones'
  const match = wakePattern({ ...DEFAULT_PROFILE, name: 'Diógenes' }, 'greeting').exec(words)
  const trailing = words.slice(match.index + match[0].length).trim()
  app.onWake(trailing, 'wake-trace')
  assert.equal(app.consumed(), 1)
  assert.equal(app.responseInputs.length, 1)
  assert.equal(app.responseInputs[0][0], 'explica las funciones')
  assert.equal(app.responseInputs[0][1], undefined)
  assert.equal(app.responseInputs[0][2], 'wake-trace')
  assert.equal(app.state.microphoneStandby, false)
})
