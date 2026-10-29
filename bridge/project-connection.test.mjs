import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import WebSocket from 'ws'
import { timingStub } from '../scripts/timing-fixture.mjs'

const until = async read => { const end = Date.now() + 6000; while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)) } throw Error('Synthetic connection fixture timed out') }

/** Real frontend connection module, real localhost WS, isolated native HTTP fixture. */
function browserClient(base, project, chat) {
  const sockets = [], timers = new Set(), events = [], storage = new Map()
  if (project && chat) storage.set('jarvis.opencode.conversation:' + project.id, chat)
  const state = { recording: null, autoScreen: false, error: null }
  state.setError = error => { state.error = error }
  class BrowserSocket extends WebSocket {
    constructor(url) { super(url, { origin: 'http://127.0.0.1:5173' }); sockets.push(this) }
  }
  const schedule = (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); timers.add(timer); return timer }
  const exports = {}
  const dependencies = {
    '../config': { BRIDGE_WS_URL: base.replace('http:', 'ws:') },
    '../store': { useStore: { setState: patch => Object.assign(state, patch), getState: () => state } },
    './projects': { selectedProject: () => project, projectMode: () => true, subscribeProjects: () => () => {}, refreshProjects: async () => {} },
    './models': { currentModelSelection: async () => ({}) },
    './voice-input-mode': { currentVoiceInputMode: () => 'transcript', reportVoiceInput() {} },
    './utterance-audio': { captureDiagnostics: () => ({ status: 'off' }) },
    './timings': timingStub(),
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, WebSocket: BrowserSocket, console, location: { port: '5173' },
    setTimeout: schedule, clearTimeout, window: { setTimeout: schedule }, localStorage: {
      getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
    }, require: id => { assert.ok(id in dependencies, 'Unexpected connection import ' + id); return dependencies[id] },
  })
  exports.watchConnection(event => events.push(event))
  exports.watchRecording(recording => { state.recording = recording })
  return { app: exports, state, events, dispose() { for (const socket of sockets) { socket.onclose = null; socket.terminate() } for (const timer of timers) clearTimeout(timer) } }
}

test('actual browser connection reaches project_required and native ready; origins, session errors and explicit recovery stay distinct', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'project-connection-')), directory = join(root, 'project')
  await mkdir(directory)
  const calls = [], sockets = [], browsers = [], streams = new Set()
  let mode = 'ok', child
  const session = { id: 'ses_connection_fixture', title: 'Synthetic fixture only', directory, time: { created: 1, updated: 2 } }
  const native = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture')
    calls.push({ method: req.method, path: url.pathname })
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:connection-fixture-only').toString('base64')) return json(401, {})
    if (mode === 'auth') return json(401, {})
    if (mode === 'unavailable') return json(503, {})
    if (req.method !== 'GET') return json(500, { error: 'Native mutations forbidden in this connection test' })
    if (url.pathname === '/global/health') return json(200, { healthy: true })
    if (url.pathname === '/path') return json(200, { directory })
    if (url.pathname === '/session') return json(200, [session])
    if (url.pathname === '/session/status') return json(200, {})
    if (url.pathname === '/session/' + session.id) return json(200, session)
    if (url.pathname === '/session/' + session.id + '/message' || url.pathname === '/permission') return json(200, [])
    if (url.pathname === '/event') { streams.add(res); res.on('close', () => streams.delete(res)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); return }
    return json(404, {})
  })
  native.listen(0, '127.0.0.1'); await once(native, 'listening')
  const nativeURL = 'http://127.0.0.1:' + native.address().port
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  const base = 'http://127.0.0.1:' + port, origin = 'http://127.0.0.1:5173', registry = join(root, 'projects.json'), preload = join(root, 'safe-network.mjs')
  const guard = 'const original=globalThis.fetch;globalThis.fetch=(input,options)=>{if(new URL(String(input)).origin!==' + JSON.stringify(nativeURL) + ')throw Error("Network outside fixture forbidden");return original(input,options)};'
  const desktopURL = new URL('./desktop.mjs', import.meta.url).href
  const blockedDesktop = 'export async function captureDesktop(){throw Error("Desktop capture forbidden in connection tests")}'
  await writeFile(preload, guard + '\nimport{registerHooks}from"node:module";registerHooks({load(url,context,next){if(url===' + JSON.stringify(desktopURL) + ')return{format:"module",shortCircuit:true,source:' + JSON.stringify(blockedDesktop) + '};return next(url,context)}})')
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./project-bridge.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), TMPDIR: root,
      JARVIS_BRIDGE_PORT: String(port), JARVIS_PROJECT_REGISTRY: registry, OPENCODE_URL: nativeURL,
      OPENCODE_SERVER_PASSWORD: 'connection-fixture-only', OPENCODE_SERVER_USERNAME: 'opencode',
      JARVIS_HISTORY_DIR: join(root, 'history'), JARVIS_AUTO_SCREEN: '0', JARVIS_RECORDING: '0', JARVIS_ALLOWED_ORIGINS: origin,
    }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  t.after(async () => {
    for (const browser of browsers) browser.dispose()
    for (const socket of sockets) socket.terminate()
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit }
    for (const response of streams) response.end()
    native.closeAllConnections(); await new Promise(resolve => native.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await until(async () => { assert.equal(child.exitCode, null); try { return (await fetch(base + '/health')).ok } catch { return false } })
  const unselected = browserClient(base, null); browsers.push(unselected)
  await unselected.app.warmBridge()
  assert.equal(unselected.app.isConnected(), true); assert.equal(unselected.app.conversationSnapshot().chat, null)
  assert.equal(calls.length, 0, 'no project must never create or inspect native conversations')
  assert.equal(unselected.state.recording, null); assert.equal(unselected.state.autoScreen, false)
  unselected.dispose()
  await new Promise(resolve => {
    const bad = new WebSocket(base.replace('http:', 'ws:'), { origin: 'https://untrusted.example' }); sockets.push(bad)
    bad.on('error', () => {}); bad.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, 403); bad.terminate(); resolve() })
  })
  const opened = await fetch(base + '/projects', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ directory, application: 'opencode' }) })
  assert.equal(opened.status, 200); const project = (await opened.json()).project
  const originalRegistry = await readFile(registry, 'utf8')
  for (let i = 0; i < 2; i++) {
    const client = browserClient(base, project, session.id); browsers.push(client)
    await client.app.warmBridge()
    await until(() => client.state.recording)
    assert.equal(client.app.isConnected(), true); assert.equal(client.app.conversationSnapshot().chat.id, session.id)
    assert.equal(client.state.recording.active, false); assert.equal(client.state.recording.controlVersion, 1)
    assert.equal(client.state.applicationCapabilities.screenOptIn, true)
    client.dispose()
  }
  const failedSession = async (projectID, expected) => {
    const frames = [], ws = new WebSocket(base.replace('http:', 'ws:') + '/?' + new URLSearchParams({ project: projectID, session: session.id }), { origin })
    sockets.push(ws); ws.on('message', raw => frames.push(JSON.parse(raw))); await once(ws, 'close')
    const failure = frames.find(frame => frame.type === 'session_error')
    assert.match(failure?.message || '', expected); assert.equal(frames.some(frame => frame.type === 'ready'), false)
  }
  await failedSession('unknown-fixture', /proyecto/i)
  mode = 'auth'; await failedSession(project.id, /contraseña.*servidor local/i)
  mode = 'unavailable'; await failedSession(project.id, /HTTP 503/)
  assert.equal((await fetch(base + '/health')).status, 200, 'native session errors do not mean transport down')
  mode = 'ok'
  const recovered = browserClient(base, project, session.id); browsers.push(recovered)
  await recovered.app.warmBridge(); await until(() => recovered.state.recording)
  assert.equal(recovered.app.conversationSnapshot().chat.id, session.id)
  assert.equal(await readFile(registry, 'utf8'), originalRegistry, 'error recovery preserves registered project')
  assert.equal(calls.some(call => call.method !== 'GET'), false, 'no native session creation, deletion, prompt or model request')
})
