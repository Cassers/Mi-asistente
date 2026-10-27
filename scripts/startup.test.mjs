import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let ignite, startCapture, configureClient
const jsxTags = []
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'ignite') {
    ignite = node.initializer
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'configureClient') configureClient = node.initializer
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startCapture') startCapture = node.initializer
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    jsxTags.push(node.tagName.getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)

test('startup does not mount the cinematic intro', () => {
  assert.ok(ignite)
  assert.ok(!jsxTags.includes('Boot'))
  assert.ok(jsxTags.includes('Ignition'), 'keep the browser audio activation gesture')
})

for (const configured of [true, false]) test(`startup initializes without intro; configured=${configured}`, async () => {
  const events = []
  let phase = 'offline'
  let finishWarm
  let markWarming
  const warming = new Promise(resolve => { finishWarm = resolve })
  const warmingStarted = new Promise(resolve => { markWarming = resolve })
  const state = {
    setMicrophoneActive: () => {},
    setPhase: value => { phase = value; events.push(value) },
    setConnected: () => events.push('connected'),
    setVoice: () => events.push('voice'),
    setError: message => assert.fail(message),
    pushTurn: turn => { assert.match(turn.text, /cómo quieres llamarme.*estilo/); events.push('welcome') },
  }
  const context = {
    store: { getState: () => state },
    sfx: { unlockAudio: async () => { events.push('unlock') }, play: () => assert.fail('intro sound') },
    music: {
      enable: () => events.push('enable'),
      playBoot: () => assert.fail('intro music'),
      startAmbient: () => assert.fail('opening music'),
    },
    warm: () => { events.push('warm'); markWarming(); return warming },
    usingBridge: true, env: {}, TTS_ENGINE: 'browser',
    refreshProfile: async () => {}, currentProfile: () => ({ configured }),
    newId: () => 'welcome', speaker: { current: null },
    createSpeaker: () => ({ say: () => events.push('say'), end: async () => {} }),
    listen: delay => { assert.equal(delay, 60000); events.push('listen') },
    connectedLabels: () => [], currentVoiceName: () => 'browser voice',
    probeCapabilities: async () => { events.push('capabilities') },
    createMicrophone: () => ({ start: async () => { events.push('microphone'); return true } }),
    voice: { current: null },
    setTimeout: () => assert.fail('artificial startup delay'),
    setInterval: () => assert.fail('unexpected browser-voice polling'),
  }
  for (const name of ['watchServers', 'watchRecording', 'watchPermissions', 'watchPanels',
    'watchBlades', 'watchCapture', 'watchUi', 'watchConnection', 'mode', 'onWake',
    'onSpeechStart', 'onPartial', 'onUtterance', 'onClip', 'onVoiceError']) context[name] = () => {}
  const code = ts.transpileModule(`const configureClient = ${configureClient.getText(source)}; const startCapture = ${startCapture.getText(source)}; (${ignite.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const start = vm.runInNewContext(code, context)
  const ready = start()
  await warmingStarted
  assert.equal(phase, 'boot', 'do not accept turns before initialization finishes')
  assert.ok(!events.includes('microphone'))
  finishWarm()
  await ready
  assert.equal(phase, 'dormant')
  assert.ok(context.voice.current)
  assert.deepEqual(events, ['unlock', 'enable', 'boot', 'warm', 'connected', 'voice',
    'capabilities', 'microphone', 'dormant', ...(configured ? [] : ['welcome', 'say', 'listen'])])
})
