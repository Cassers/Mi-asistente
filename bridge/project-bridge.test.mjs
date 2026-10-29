import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

function voiceClip() {
  const wav = Buffer.alloc(44 + 8000)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(8000, 40)
  return { mime: 'audio/wav', data: wav.toString('base64') }
}

const origin = 'http://localhost:5173'
const timingEvent = patch => ({ traceId: 'trace-browser-1234', id: 'span-browser-1234', source: 'browser', name: 'turn.total', phase: 'end', status: 'ok', at: Date.now(), durationMs: 50, ...patch })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, description, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(15) }
  assert.fail(`Timed out: ${description}`)
}
const user = (id, text) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] })
const answer = (id, parentID, text) => ({ info: { id, parentID, role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text }] })

async function fixture(t, { screenFixture } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-project-bridge-test-'))
  const directories = [join(root, 'project'), join(root, 'project/nested')]
  for (const directory of directories) await mkdir(directory, { recursive: true })
  const sessions = new Map([
    ['ses_a', { id: 'ses_a', title: 'Native A', directory: directories[0], time: { updated: 20 } }],
    ['ses_b', { id: 'ses_b', title: 'Native B', directory: directories[1], time: { updated: 10 } }],
    ['ses_child', { id: 'ses_child', title: 'Child', directory: directories[0], parentID: 'ses_a' }],
    ['ses_grandchild', { id: 'ses_grandchild', directory: directories[0], parentID: 'ses_child' }],
    ['ses_forged', { id: 'ses_forged', directory: directories[1], parentID: 'ses_a' }],
    ['ses_unrelated', { id: 'ses_unrelated', directory: directories[0] }],
    ['ses_cycle', { id: 'ses_cycle', directory: directories[0], parentID: 'ses_cycle' }],
  ])
  const messages = new Map([
    ['ses_a', [user('msg_native_a', 'Native question A'), answer('msg_answer_a', 'msg_native_a', 'Native answer A')]],
    ['ses_b', [user('msg_native_b', 'Native question B'), answer('msg_answer_b', 'msg_native_b', 'Native answer B')]],
  ])
  const requests = [], streams = new Set(), clients = [], gates = new Map(), pendingGates = new Set()
  let pending = [], hold = false, logs = '', child, nativeProvider = 'fake', audioStatus = 200, audioText = 'Voz interpretada correctamente', directAdapter = false
  const emit = () => { for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'session.updated', properties: { sessionID: 'ses_b' } })}\n\n`) }
  const model = { id: 'fake-model', name: 'Fake model, no inference', api: { npm: '@ai-sdk/google', url: 'https://opencode.ai/inference/go/google/v1beta' }, capabilities: { input: { text: true, image: false }, output: { text: true } }, variants: { high: {} } }
  const mock = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const url = new URL(req.url, 'http://localhost')
      const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      const path = url.pathname
      requests.push({ method: req.method, path, directory: url.searchParams.get('directory'), header: req.headers['x-opencode-directory'], data })
      const gate = gates.get(path)
      if (gate) { gate.hits++; await gate.promise }
      if (path === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': heartbeat\n\n')
        streams.add(res); res.on('close', () => streams.delete(res)); return
      }
      const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
      if (path === '/audio-transcribe') {
        const text = JSON.stringify({ heard: true, transcript: audioText })
        return json(data.input ? { output: [{ content: [{ type: 'output_text', text }] }] }
          : data.messages ? { choices: [{ message: { content: text } }] } : { candidates: [{ content: { parts: [{ text }] } }] }, audioStatus)
      }
      if (path === '/global/health') return json({ healthy: true })
      if (path === '/path') return json({ directory: url.searchParams.get('directory') })
      if (path === '/config') return json(directAdapter ? { plugin: ['file:///fixture/opencode-audio-plugin.mjs'] } : {})
      if (path === '/agent') return json([{ name: 'build', mode: 'primary', model: { providerID: nativeProvider, modelID: 'fake-model' } }])
      if (path === '/provider') return json({ connected: [nativeProvider], all: [{ id: nativeProvider, name: 'Test provider', models: { 'fake-model': model } }] })
      if (path === '/session/status') return json({})
      if (path === '/permission') return json(pending)
      // Intentionally unscoped: bridge must check directory independently.
      if (path === '/session' && req.method === 'GET') return json([...sessions.values()])
      if (path === '/session' && req.method === 'POST') {
        const session = { id: `ses_new_${sessions.size}`, title: 'New native chat', directory: url.searchParams.get('directory'), time: { created: Date.now() } }
        sessions.set(session.id, session)
        messages.set(session.id, [])
        return json(session)
      }
      if (/^\/session\/[^/]+$/.test(path) && req.method === 'GET') return json(sessions.get(path.split('/')[2]) || {}, sessions.has(path.split('/')[2]) ? 200 : 404)
      if (path.endsWith('/message') && req.method === 'GET') return json(messages.get(path.split('/')[2]) || [])
      if (/\/message\/msg_[\w-]+$/.test(path) && req.method === 'GET') {
        const message = messages.get(path.split('/')[2])?.find(m => m.info.id === path.split('/').at(-1))
        return json(message || {}, message ? 200 : 404)
      }
      if (path.endsWith('/prompt_async') || path.endsWith('/message') && req.method === 'POST') {
        const id = path.split('/')[2]
        const history = messages.get(id) || []
        // Preserve bridge-provided IDs: completion must correlate to this exact user message.
        const submitted = user(data.messageID, data.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'))
        submitted.parts = data.parts.map(part => part.type === 'file' && part.mime === 'audio/mpeg'
          ? { type: 'text', synthetic: true, text: '[fixture-audio]', metadata: { miAsistenteAudio: { data: part.url.split('base64,')[1], format: 'mp3' } } }
          : structuredClone(part))
        for (const key of ['agent', 'model', 'variant']) if (data[key] !== undefined) submitted.info[key] = data[key]
        history.push(submitted)
        if (!hold && !data.noReply) history.push(answer(`msg_response_${requests.length}`, data.messageID, `Fake response for ${id}`))
        messages.set(id, history)
        json(data.noReply ? submitted : true); emit(); return
      }
      if (path.endsWith('/abort') || /^\/permission\/[^/]+\/reply$/.test(path)) return json(true)
      return json({ error: `Unexpected fake route: ${req.method} ${path}` }, 404)
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
  })
  t.after(async () => {
    for (const gate of pendingGates) gate.release()
    for (const client of clients) client.ws.terminate()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited; clearTimeout(killer)
    }
    for (const res of streams) res.end()
    mock.closeAllConnections()
    await new Promise(resolve => mock.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const reserve = http.createServer()
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const registry = join(root, 'state/projects.json')
  await mkdir(join(root, 'data/opencode'), { recursive: true })
  await writeFile(join(root, 'data/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-only' } }))
  const preload = join(root, 'local-audio-provider.mjs')
  await writeFile(preload, `const original=globalThis.fetch;globalThis.fetch=(url,options)=>String(url).startsWith('https://opencode.ai/inference/go/')?original(${JSON.stringify(`http://127.0.0.1:${mock.address().port}/audio-transcribe`)},options):original(url,options);`)
  if (screenFixture) {
    const desktopURL = new URL('./desktop.mjs', import.meta.url).href
    const source = screenFixture === 'fail'
      ? "export async function captureDesktop() { throw new Error('Fixture capture denied') }"
      : "let count=0; export async function captureDesktop(monitor) { if(monitor!=='principal') throw Error('Wrong fixture monitor'); return {mimeType:'image/png',data:Buffer.from('fixture-screen-'+ ++count).toString('base64')} }"
    await writeFile(preload, (await readFile(preload, 'utf8')) + `\nimport {registerHooks} from 'node:module';registerHooks({load(url,context,next){if(url===${JSON.stringify(desktopURL)}) return {format:'module',shortCircuit:true,source:${JSON.stringify(source)}};return next(url,context)}});`)
  }
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./project-bridge.mjs', import.meta.url))], {
    cwd: root,
    env: { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: root,
      OPENCODE_URL: `http://127.0.0.1:${mock.address().port}`, OPENCODE_SERVER_PASSWORD: '', OPENCODE_SERVER_USERNAME: 'opencode',
      JARVIS_BRIDGE_HOST: '127.0.0.1', JARVIS_BRIDGE_PORT: String(port), JARVIS_PROJECT_REGISTRY: registry,
      JARVIS_AUTO_SCREEN: '0', JARVIS_RECORDING: '0', JARVIS_HISTORY_DIR: join(root, 'history'), JARVIS_ALLOWED_ORIGINS: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('error', error => { logs += error.message })
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000) })
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000) })
  await until(async () => {
    assert.equal(child.exitCode, null, `Bridge exited: ${logs}`)
    try { return (await fetch(base + '/health')).ok } catch { return false }
  }, 'bridge HTTP ready')
  const projects = []
  for (const directory of directories) {
    const res = await fetch(base + '/projects', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ directory }) })
    const data = await res.json()
    assert.equal(res.status, 200, JSON.stringify(data))
    projects.push(data.project)
  }
  async function connect(project, session) {
    const query = new URLSearchParams({ project: project.id, ...(session ? { session } : {}) })
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/?' + query, { origin })
    const frames = []
    const client = { ws, frames, closed: false,
      send: data => ws.send(JSON.stringify(data)),
      frame: (predicate, from = 0) => until(() => frames.slice(from).find(predicate), 'matching WebSocket frame'),
      close: async () => { if (ws.readyState === WebSocket.CLOSED) return; const closed = once(ws, 'close'); ws.close(); await closed },
    }
    clients.push(client)
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())))
    ws.on('close', () => { client.closed = true })
    ws.on('error', () => {})
    await once(ws, 'open')
    await client.frame(frame => ['ready', 'session_error'].includes(frame.type))
    return client
  }
  return { root, base, registry, directories, projects, requests, messages, sessions, connect, emit,
    enableDirect: () => { directAdapter = true; model.capabilities.input.audio = true; nativeProvider = 'opencode-go'; model.api.npm = '@ai-sdk/openai'; model.api.url = 'https://opencode.ai/inference/go/openai/v1' },
    setImageSupport: value => { model.capabilities.input.image = value },
    setAudioSupport: value => { model.capabilities.input.audio = value; nativeProvider = 'opencode-go' },
    setTransport: npm => { model.api.npm = npm; model.api.url = 'https://opencode.ai/inference/go/' + (npm === '@ai-sdk/google' ? 'google/v1beta' : 'openai/v1') },
    setAudioResponse: (status, text = '') => { audioStatus = status; audioText = text },
    setPermissions: value => { pending = value; emit() }, setHold: value => { hold = value },
    block: path => {
      assert.ok(!gates.has(path), `Only one gate per path: ${path}`)
      let resolve
      const promise = new Promise(done => { resolve = done })
      const gate = { promise, hits: 0,
        passThrough: () => { if (gates.get(path) === gate) gates.delete(path) },
        release: () => { gate.passThrough(); pendingGates.delete(gate); resolve() },
      }
      gates.set(path, gate)
      pendingGates.add(gate)
      return gate
    },
    forbidden: () => requests.filter(r => r.method === 'DELETE' || r.path.endsWith('/abort') || /^\/permission\/[^/]+\/reply$/.test(r.path)),
  }
}

test('direct audio keeps the native chat, waits for submitted prompt before abort and marks the following clip as continuation', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.enableDirect(); f.setHold(true)
  const client = await f.connect(f.projects[0])
  const submission = f.block('/session/ses_a/prompt_async')
  client.send({ type: 'ask', id: 'clip-one', audioMode: 'direct', audio: voiceClip(), text: 'Browser caption must never enter the model' })
  await until(() => submission.hits === 1, 'first direct clip submitting')
  const abort = f.block('/session/ses_a/abort')
  client.send({ type: 'interrupt', requestID: 'stop-one', reason: 'speech' })
  await sleep(80)
  assert.equal(abort.hits, 0, 'abort must not race ahead of a prompt still entering native OpenCode')
  assert.equal(client.frames.some(frame => frame.type === 'interrupted'), false)
  submission.release()
  await until(() => abort.hits === 1, 'abort after native submission accepted')
  assert.equal(client.frames.some(frame => frame.type === 'interrupted'), false, 'no acknowledgement before native stop completes')
  abort.release()
  await client.frame(frame => frame.type === 'interrupted' && frame.requestID === 'stop-one' && frame.status === 'ok')
  f.setHold(false)
  client.send({ type: 'ask', id: 'clip-two', audioMode: 'direct', audio: voiceClip(), text: 'Another visual caption only' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'clip-two')
  client.send({ type: 'ask', id: 'clip-three', audioMode: 'direct', audio: voiceClip(), text: 'Caption three' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'clip-three')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 3)
  assert.ok(prompts.every(request => request.path === '/session/ses_a/prompt_async'))
  for (const request of prompts) {
    assert.equal(request.data.parts.filter(part => part.type === 'file' && part.mime === 'audio/mpeg').length, 1)
    assert.ok(request.data.parts.filter(part => part.type === 'text').every(part => part.synthetic))
    assert.doesNotMatch(JSON.stringify(request.data), /Browser caption|Another visual|Caption three/)
    assert.ok(!request.data.system, 'native project instructions remain authoritative')
  }
  assert.match(prompts[1].data.parts[0].text, /interrumpida.*continuó hablando/)
  assert.doesNotMatch(JSON.stringify(prompts[2].data), /interrumpida/, 'continuation note is consumed by exactly the next submitted clip')
  assert.equal(f.requests.filter(request => request.path === '/audio-transcribe').length, 0)
})

test('two exact-directory projects resume existing native chats; opening and disconnecting are read-only', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setPermissions([{ id: 'per_pending', sessionID: 'ses_a', permission: 'bash', patterns: ['printf fake'] }])
  const a = await f.connect(f.projects[0])
  const b = await f.connect(f.projects[1])
  for (const [client, id, text, directory] of [[a, 'ses_a', 'Native answer A', f.directories[0]], [b, 'ses_b', 'Native answer B', f.directories[1]]]) {
    const ready = client.frames.find(frame => frame.type === 'ready')
    assert.equal(ready.native, true)
    assert.equal(ready.conversation.id, id)
    assert.ok(ready.conversation.turns.some(turn => turn.text === text))
    assert.ok(ready.conversation.entries.every(entry => f.sessions.get(entry.id).directory === directory))
    assert.ok(!ready.conversation.entries.some(entry => ['ses_child', 'ses_grandchild'].includes(entry.id)))
  }
  await a.frame(frame => frame.type === 'permissions' && frame.requests.some(p => p.id === 'per_pending'))
  await a.close(); await b.close()
  await sleep(150)
  assert.deepEqual(f.forbidden(), [], 'attach/detach must never abort/delete/reject native work')
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0, 'opening native sessions creates no bootstrap or synthetic chat')
  for (const request of f.requests) {
    assert.ok(f.directories.includes(request.directory))
    assert.equal(request.header, encodeURIComponent(request.directory))
  }
  assert.doesNotMatch(await readFile(f.registry, 'utf8'), /password|username|authorization/)
})

test('a second view stops the shared native owner and waits for its in-flight submission before acknowledging', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setHold(true)
  const owner = await f.connect(f.projects[0]), observer = await f.connect(f.projects[0])
  const submission = f.block('/session/ses_a/prompt_async')
  owner.send({ type: 'ask', id: 'shared-owner', text: 'Owner request crossing HTTP' })
  await until(() => submission.hits === 1, 'owner submission held')
  observer.send({ type: 'interrupt', reason: 'speech', requestID: 'observer-stop' })
  await sleep(100)
  assert.equal(f.forbidden().length, 0, 'second view cannot abort before owner submission lands')
  assert.equal(observer.frames.some(frame => frame.type === 'interrupted'), false)
  submission.release()
  await observer.frame(frame => frame.type === 'interrupted' && frame.requestID === 'observer-stop' && frame.status === 'ok')
  const cancelled = await owner.frame(frame => frame.type === 'done' && frame.ask === 'shared-owner')
  assert.equal(cancelled.status, 'cancelled', 'the owning view must also settle its pending reply')
  f.setHold(false)
  observer.send({ type: 'ask', id: 'after-shared-stop', text: 'Fresh observer question' })
  await observer.frame(frame => frame.type === 'done' && frame.ask === 'after-shared-stop')
  assert.equal(f.requests.filter(request => request.path.endsWith('/abort')).length, 1)
})

test('speech during direct preparation preserves the entire first clip before stop acknowledgement, then answers the next clip', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.enableDirect()
  const client = await f.connect(f.projects[0])
  const inspection = f.block('/provider')
  client.send({ type: 'ask', id: 'prefix-audio', audioMode: 'direct', audio: voiceClip(), text: 'ignored browser text' })
  await until(() => inspection.hits > 0, 'model inspection held before audio submission')
  client.send({ type: 'interrupt', requestID: 'resume-speech', reason: 'speech' })
  await sleep(75)
  assert.equal(client.frames.some(frame => frame.type === 'interrupted'), false)
  inspection.release()
  await client.frame(frame => frame.type === 'interrupted' && frame.requestID === 'resume-speech' && frame.status === 'ok')
  const stored = f.requests.find(request => request.method === 'POST' && request.path === '/session/ses_a/message')
  assert.equal(stored.data.noReply, true, 'early interruption must save audio without generating an obsolete answer')
  assert.equal(stored.data.parts.filter(part => part.type === 'file' && part.mime === 'audio/mpeg').length, 1)
  assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 0)
  assert.ok(f.messages.get('ses_a').some(m => m.info.id === stored.data.messageID && m.parts.some(part => part.metadata?.miAsistenteAudio)))
  client.send({ type: 'ask', id: 'continuing-audio', audioMode: 'direct', audio: voiceClip(), text: 'ignored last caption' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'continuing-audio')
  const complete = f.requests.find(request => request.path.endsWith('/prompt_async'))
  assert.match(complete.data.parts[0].text, /continuación o corrección/)
  assert.equal(f.messages.get('ses_a').filter(m => m.info.role === 'user' && m.parts.some(part => part.metadata?.miAsistenteAudio)).length, 2)
})

test('queued preserveOnly clips append in order without model calls or answers', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.enableDirect()
  const client = await f.connect(f.projects[0])
  for (const id of ['first-queued', 'second-queued']) {
    client.send({ type: 'ask', id, audioMode: 'direct', preserveOnly: true, audio: voiceClip(), text: 'fixed' })
    const done = await client.frame(frame => frame.type === 'done' && frame.ask === id)
    assert.equal(done.status, 'cancelled')
  }
  const commits = f.requests.filter(request => request.method === 'POST' && request.path === '/session/ses_a/message')
  assert.equal(commits.length, 2); assert.ok(commits.every(request => request.data.noReply))
  assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 0)
  client.send({ type: 'ask', id: 'answer-latest', audioMode: 'direct', audio: voiceClip(), text: 'fixed' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'answer-latest')
  assert.equal(f.messages.get('ses_a').filter(m => m.info.role === 'user' && m.parts.some(part => part.metadata?.miAsistenteAudio)).length, 3)
})

test('timings correlate native preparation and response without storing chat content or touching native payload', { timeout: 15000 }, async t => {
  const f = await fixture(t), client = await f.connect(f.projects[0], 'ses_a')
  const traceId = 'trace-fixture-12345'
  client.send({ type: 'ask', id: 'timing-request', traceId, text: 'Private user words must never enter telemetry' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'timing-request')
  const response = await fetch(f.base + '/timings'), data = await response.json()
  const rows = data.events.filter(e => e.traceId === traceId && e.phase === 'end')
  for (const label of ['bridge.prepare','bridge.membership','bridge.status','bridge.recovery','bridge.selection','bridge.submit','bridge.first_text','bridge.response']) assert.ok(rows.some(e => e.name === label), label)
  assert.doesNotMatch(JSON.stringify(data), /Private user words|Native question|Native answer|ses_a|authorization|fixture-only/)
  const native = f.requests.find(r => r.path.endsWith('/prompt_async'))
  assert.equal(native.data.traceId, undefined)
  assert.ok(client.frames.some(frame => frame.type === 'timing' && frame.event.traceId === traceId))
  const post = (payload, sentOrigin = origin) => fetch(f.base + '/timings', { method: 'POST', headers: { origin: sentOrigin, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal((await post({ events: [timingEvent({ prompt: 'secret-browser', password: 'secret-key' }), timingEvent({ source: 'bridge', id: 'forged-source-1234' })] })).status, 200)
  assert.equal((await post({ events: [] }, 'https://evil.example')).status, 403)
  assert.equal((await post({ events: Array.from({ length: 25 }, () => timingEvent()) })).status, 400)
  const saved = await (await fetch(f.base + '/timings')).json()
  assert.ok(saved.events.some(e => e.id === 'span-browser-1234'))
  assert.ok(!saved.events.some(e => e.id === 'forged-source-1234'))
  assert.doesNotMatch(JSON.stringify(saved), /secret-browser|secret-key/)
})

test('live audio waits are visible; provider fallback and explicit interruption keep honest timing outcomes', { timeout: 15000 }, async t => {
  const f = await fixture(t), client = await f.connect(f.projects[0], 'ses_a')
  f.setAudioSupport(true)
  f.setAudioResponse(503)
  const gate = f.block('/audio-transcribe')
  const traceId = 'trace-audio-wait-1234'
  client.send({ type: 'ask', id: 'audio-wait', traceId, text: 'Private fallback speech', audio: voiceClip() })
  await until(() => gate.hits > 0, 'audio provider entered')
  const live = await (await fetch(f.base + '/timings')).json()
  assert.ok(live.events.some(e => e.traceId === traceId && e.name === 'audio.provider' && e.phase === 'start'))
  await sleep(40); gate.release()
  await client.frame(frame => frame.type === 'done' && frame.ask === 'audio-wait')
  let saved = await (await fetch(f.base + '/timings')).json()
  const rows = saved.events.filter(e => e.traceId === traceId && e.phase === 'end')
  assert.ok(rows.some(e => e.name === 'audio.provider' && e.status === 'error' && e.durationMs >= 35))
  assert.ok(rows.some(e => e.name === 'audio.total' && e.status === 'fallback'))
  assert.ok(rows.some(e => e.name === 'audio.encode' && e.status === 'ok'))
  assert.doesNotMatch(JSON.stringify(saved), /Private fallback speech|data:audio|input_audio/)
  f.setHold(true)
  client.send({ type: 'ask', id: 'timing-cancel', traceId: 'trace-cancelled-1234', text: 'Never store these words' })
  await until(() => f.requests.filter(r => r.path.endsWith('/prompt_async')).length === 2, 'held prompt submitted')
  client.send({ type: 'interrupt' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'timing-cancel')
  saved = await (await fetch(f.base + '/timings')).json()
  assert.ok(saved.events.some(e => e.traceId === 'trace-cancelled-1234' && e.name === 'bridge.response' && e.status === 'cancelled'))
})

test('a voice turn reads provider catalogue once and the next turn observes changed audio capability', { timeout: 15000 }, async t => {
  const f = await fixture(t), client = await f.connect(f.projects[0], 'ses_a')
  f.setAudioSupport(true)
  const count = path => f.requests.filter(r => r.path === path).length
  let before = count('/provider')
  client.send({ type: 'ask', id: 'one-inspection', text: 'Fixture dictation', model: 'opencode-go/fake-model', audio: voiceClip() })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'one-inspection')
  assert.equal(count('/provider') - before, 1, 'model validation and MP3 interpretation share the same current catalogue')
  assert.equal(count('/audio-transcribe'), 1)
  f.setAudioSupport(false)
  before = count('/provider')
  client.send({ type: 'ask', id: 'fresh-inspection', text: 'New complete dictation', model: 'opencode-go/fake-model', audio: voiceClip() })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'fresh-inspection')
  assert.equal(count('/provider') - before, 1)
  assert.equal(count('/audio-transcribe'), 1, 'changed native capability is honored without cached audio inference')
  assert.ok(client.frames.some(frame => frame.type === 'audio' && frame.ask === 'fresh-inspection' && frame.state === 'fallback'))
  const prompt = f.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1)
  assert.equal(prompt.data.parts[0].text, 'New complete dictation')
})

test('native abort with partial text is cancelled in bridge timings and done status', { timeout: 15000 }, async t => {
  const f = await fixture(t), client = await f.connect(f.projects[0], 'ses_a')
  f.setHold(true)
  client.send({ type: 'ask', id: 'aborted-external', traceId: 'trace-aborted-native', text: 'Fixture only' })
  await until(() => f.requests.some(r => r.path.endsWith('/prompt_async')), 'native request submitted')
  const native = f.requests.find(r => r.path.endsWith('/prompt_async'))
  const partial = answer('msg_external_abort', native.data.messageID, 'Partial answer still visible')
  partial.info.error = { name: 'MessageAbortedError' }
  f.messages.get('ses_a').push(partial); f.emit()
  const done = await client.frame(frame => frame.type === 'done' && frame.ask === 'aborted-external')
  assert.equal(done.status, 'cancelled'); assert.equal(done.text, 'Partial answer still visible')
  const metrics = await (await fetch(f.base + '/timings')).json()
  assert.ok(metrics.events.some(e => e.traceId === 'trace-aborted-native' && e.name === 'bridge.response' && e.status === 'cancelled'))
})

for (const path of ['/session/status', '/provider']) {
  test(`same-socket simultaneous asks preserve first claim while ${path} is pending`, { timeout: 15000 }, async t => {
    const f = await fixture(t)
    const client = await f.connect(f.projects[0], 'ses_a')
    await client.frame(frame => frame.type === 'session_update')
    const gate = f.block(path)
    client.send({ type: 'ask', id: 'first', text: 'First request wins', ...(path === '/provider' ? { model: 'fake/fake-model' } : {}) })
    client.send({ type: 'ask', id: 'duplicate', text: 'Duplicate must not erase first turn' })
    const rejected = await client.frame(frame => frame.type === 'error' && frame.ask === 'duplicate')
    assert.match(rejected.message, /ya está trabajando/)
    await until(() => gate.hits > 0, `first request held at ${path}`)
    client.send({ type: 'ask', id: 'third', text: 'Duplicate error must not release first claim' })
    await client.frame(frame => frame.type === 'error' && frame.ask === 'third')
    gate.release()
    const done = await client.frame(frame => frame.type === 'done' && frame.ask === 'first')
    assert.equal(done.text, 'Fake response for ses_a')
    const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
    assert.equal(prompts.length, 1)
    assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'First request wins' }])
    assert.ok(!client.frames.some(frame => frame.type === 'error' && frame.ask === 'first'))
    assert.deepEqual(f.forbidden(), [])
  })
}

for (const path of ['/session/status', '/provider', '/session/ses_a/prompt_async']) {
  test(`observer disconnect preserves owner claim while ${path} is pending`, { timeout: 15000 }, async t => {
    const f = await fixture(t)
    const owner = await f.connect(f.projects[0], 'ses_a')
    const observer = await f.connect(f.projects[0], 'ses_a')
    const contender = await f.connect(f.projects[0], 'ses_a')
    for (const client of [owner, observer, contender]) await client.frame(frame => frame.type === 'session_update')
    const gate = f.block(path)
    owner.send({ type: 'ask', id: 'owner', text: 'Owner survives observer detach', ...(path === '/provider' ? { model: 'fake/fake-model' } : {}) })
    await until(() => gate.hits > 0, `owner request held at ${path}`)
    // No native busy flag: only the bridge's owner claim prevents a competing prompt.
    await observer.close()
    contender.send({ type: 'ask', id: 'contender', text: 'Observer detach must not release owner' })
    await contender.frame(frame => frame.type === 'error' && frame.ask === 'contender')
    assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, path.endsWith('/prompt_async') ? 1 : 0)
    gate.release()
    const done = await owner.frame(frame => frame.type === 'done' && frame.ask === 'owner')
    assert.equal(done.text, 'Fake response for ses_a')
    assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 1)
    assert.ok(!owner.frames.some(frame => frame.type === 'error' && frame.ask === 'owner'))
    assert.deepEqual(f.forbidden(), [])
  })
}

test('interrupt during held native status prevents delayed prompt submission', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const client = await f.connect(f.projects[0], 'ses_a')
  await client.frame(frame => frame.type === 'session_update')
  const gate = f.block('/session/status')
  client.send({ type: 'ask', id: 'cancel-before-status', text: 'Must never reach prompt' })
  await until(() => gate.hits > 0, 'ask waiting for native status')
  client.send({ type: 'interrupt' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'cancel-before-status')
  gate.release()
  // A later successful turn is a completion barrier for the released status request.
  client.send({ type: 'ask', id: 'after-interrupt', text: 'Fresh request after cancelled status' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'after-interrupt')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'Fresh request after cancelled status' }])
  assert.deepEqual(f.forbidden().map(request => [request.method, request.path]), [['POST', '/session/ses_a/abort']])
})

test('interrupt barrier survives cancelled ask cleanup and blocks prompts until delayed native abort finishes', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const owner = await f.connect(f.projects[0], 'ses_a')
  const observer = await f.connect(f.projects[0], 'ses_a')
  for (const client of [owner, observer]) await client.frame(frame => frame.type === 'session_update')
  const status = f.block('/session/status')
  owner.send({ type: 'ask', id: 'cancelled-before-prompt', text: 'Cancelled operation must not clear interrupt barrier' })
  await until(() => status.hits > 0, 'original ask waiting on status')
  const membership = f.block('/session/ses_a')
  const abort = f.block('/session/ses_a/abort')
  owner.send({ type: 'interrupt' })
  await until(() => membership.hits > 0, 'interrupt waiting on membership validation')
  status.release()
  await sleep(100) // Allow cancelled A's finally to run while interrupt still owns the barrier.
  owner.send({ type: 'ask', id: 'during-membership', text: 'Must wait for interrupt membership and abort' })
  const blockedMembership = await owner.frame(frame => frame.type === 'error' && frame.ask === 'during-membership')
  assert.match(blockedMembership.message, /ya está trabajando/)
  owner.send({ type: 'interrupt' }) // Coalesced while membership is pending.
  assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 0)
  membership.release()
  await until(() => abort.hits > 0, 'native abort response held')
  observer.send({ type: 'ask', id: 'during-abort', text: 'Other client must also respect interrupt barrier' })
  const blockedAbort = await observer.frame(frame => frame.type === 'error' && frame.ask === 'during-abort')
  assert.match(blockedAbort.message, /ya está trabajando/)
  owner.send({ type: 'interrupt' }) // Coalesced while native abort is pending.
  // A later rejection confirms the repeated interrupt was processed before releasing abort.
  owner.send({ type: 'ask', id: 'after-repeated-interrupt', text: 'Repeated interrupt must not drop barrier' })
  await owner.frame(frame => frame.type === 'error' && frame.ask === 'after-repeated-interrupt')
  assert.equal(abort.hits, 1, 'repeated interrupts must issue one native abort')
  assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 0)
  assert.ok(!owner.frames.some(frame => frame.type === 'done' && frame.ask === 'cancelled-before-prompt'))
  abort.release()
  await owner.frame(frame => frame.type === 'done' && frame.ask === 'cancelled-before-prompt')
  observer.send({ type: 'ask', id: 'after-abort-barrier', text: 'Fresh request after native abort response' })
  await observer.frame(frame => frame.type === 'done' && frame.ask === 'after-abort-barrier')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'Fresh request after native abort response' }])
  assert.deepEqual(f.forbidden().map(request => [request.method, request.path]), [['POST', '/session/ses_a/abort']])
})

test('disconnect during held status frees lock; stale cleanup cannot release reconnected owner token', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const old = await f.connect(f.projects[0], 'ses_a')
  await old.frame(frame => frame.type === 'session_update')
  const status = f.block('/session/status')
  old.send({ type: 'ask', id: 'disconnected', text: 'Detached before status returned' })
  await until(() => status.hits > 0, 'old request waiting for native status')
  await old.close()
  status.passThrough() // New client may read status; the old response stays held.
  const fresh = await f.connect(f.projects[0], 'ses_a')
  await fresh.frame(frame => frame.type === 'session_update')
  const provider = f.block('/provider')
  fresh.send({ type: 'ask', id: 'fresh', text: 'Fresh owner after detach', model: 'fake/fake-model' })
  await until(() => provider.hits > 0, 'fresh owner acquired lock without old status response')
  status.release()
  await sleep(100) // Let old operation's finally run while the new token remains claimed.
  fresh.send({ type: 'ask', id: 'duplicate-after-stale-cleanup', text: 'Must not steal fresh owner' })
  await fresh.frame(frame => frame.type === 'error' && frame.ask === 'duplicate-after-stale-cleanup')
  provider.release()
  await fresh.frame(frame => frame.type === 'done' && frame.ask === 'fresh')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'Fresh owner after detach' }])
  assert.deepEqual(f.forbidden(), [])
})

test('foreign session rejected even when native server ignores directory query', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const client = await f.connect(f.projects[0], 'ses_b')
  assert.ok(client.frames.some(frame => frame.type === 'session_error' && /otra carpeta/.test(frame.message)))
  assert.ok(!client.frames.some(frame => frame.type === 'ready'))
  await until(() => client.closed, 'foreign socket closed')
  assert.deepEqual(f.forbidden(), [])
})

test('native prompts contain exact text only; explicit model/variant adds only chosen override', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const client = await f.connect(f.projects[0], 'ses_a')
  for (const [id, extra] of [['default', {}], ['native', { model: 'native/default' }], ['override', { model: 'fake/fake-model', variant: 'high' }]]) {
    const text = `Pregunta ficticia ${id}.`
    client.send({ type: 'ask', id, text, ...extra })
    const done = await client.frame(frame => frame.type === 'done' && frame.ask === id)
    assert.equal(done.text, 'Fake response for ses_a')
    const prompt = f.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1).data
    assert.match(prompt.messageID, /^msg_/)
    assert.deepEqual(prompt.parts, [{ type: 'text', text }])
    assert.deepEqual(Object.keys(prompt).sort(), (id === 'override' ? ['messageID', 'model', 'parts', 'variant'] : ['messageID', 'parts']).sort())
    if (id === 'override') {
      assert.deepEqual(prompt.model, { providerID: 'fake', modelID: 'fake-model' })
      assert.equal(prompt.variant, 'high')
    }
    const history = f.messages.get('ses_a')
    assert.equal(history.at(-2).info.id, prompt.messageID)
    assert.equal(history.at(-1).info.parentID, prompt.messageID)
  }
  assert.deepEqual(f.forbidden(), [])
})

for (const shape of ['legacy user fields', 'session model id and variant', 'user model nested variant']) {
test(`resumed native plan/model/high normalized from ${shape}; explicit model keeps agent`, { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const oldModel = { providerID: 'native-fixture', modelID: 'old-model' }
  const earlier = user('msg_earlier', 'Earlier choice must not win')
  Object.assign(earlier.info, { agent: 'build', model: { providerID: 'wrong', modelID: 'older' }, variant: 'low' })
  const latest = user('msg_latest_native', 'Native plan question')
  Object.assign(latest.info, { agent: 'plan', model: oldModel, variant: 'high' })
  if (shape === 'session model id and variant') {
    f.sessions.get('ses_a').model = { providerID: oldModel.providerID, id: oldModel.modelID, variant: 'high' }
    latest.info.model = { providerID: 'superseded', modelID: 'older-user-model', variant: 'low' }
    latest.info.variant = 'low'
  } else if (shape === 'user model nested variant') {
    latest.info.model = { ...oldModel, variant: 'high' }
    latest.info.variant = 'low'
  }
  const response = answer('msg_latest_answer', latest.info.id, 'Native plan answer')
  response.info.agent = 'build' // Continuation comes from the last user, not the assistant.
  f.messages.set('ses_a', [earlier, latest, response])
  let client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'resume-native', text: 'Continue this plan', model: 'native/default' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'resume-native')
  let prompt = f.requests.filter(request => request.path.endsWith('/prompt_async')).at(-1).data
  assert.deepEqual(prompt, { messageID: prompt.messageID, agent: 'plan', model: oldModel, variant: 'high', parts: [{ type: 'text', text: 'Continue this plan' }] })
  assert.match(prompt.messageID, /^msg_/)
  await client.close()
  client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'override-native', text: 'Continue with selected model', model: 'fake/fake-model', variant: 'high' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'override-native')
  prompt = f.requests.filter(request => request.path.endsWith('/prompt_async')).at(-1).data
  assert.deepEqual(prompt, { messageID: prompt.messageID, agent: 'plan', model: { providerID: 'fake', modelID: 'fake-model' }, variant: 'high', parts: [{ type: 'text', text: 'Continue with selected model' }] })
  assert.deepEqual(f.forbidden(), [])
})
}

for (const selection of ['native/default', 'opencode-go/fake-model']) {
  test(`MP3 is interpreted with ${selection}; native chat receives recognized text only`, { timeout: 15000 }, async t => {
    const f = await fixture(t)
    f.setAudioSupport(true)
    const client = await f.connect(f.projects[0], 'ses_a')
    const audio = voiceClip()
    client.send({ type: 'ask', id: 'voice', text: 'Texto de respaldo', model: selection, audio })
    await client.frame(frame => frame.type === 'done' && frame.ask === 'voice')
    const prompt = f.requests.find(request => request.path.endsWith('/prompt_async')).data
    assert.deepEqual(prompt.parts, [{ type: 'text', text: 'Voz interpretada correctamente' }])
    const preflight = f.requests.find(request => request.path === '/audio-transcribe').data
    assert.equal(preflight.contents[0].parts[1].inlineData.mimeType, 'audio/mpeg')
    assert.notEqual(Buffer.from(preflight.contents[0].parts[1].inlineData.data, 'base64').toString('ascii', 0, 4), 'RIFF')
    assert.ok(client.frames.some(frame => frame.type === 'audio' && frame.ask === 'voice' && frame.state === 'interpreted'))
    assert.equal(prompt.agent, undefined)
    assert.equal(prompt.system, undefined)
    if (selection === 'native/default') assert.equal(prompt.model, undefined, 'capability inspection must not override native model')
    assert.deepEqual(f.forbidden(), [])
  })
}

test('malformed clip and provider rejection each fall back once without poisoning native history', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setAudioSupport(true)
  f.setTransport('@ai-sdk/openai')
  const client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'invalid-audio', text: 'Do not submit malformed clip', audio: { mime: 'audio/wav', data: 'bad' } })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'invalid-audio')
  assert.equal(f.requests.filter(request => request.path === '/audio-transcribe').length, 0)
  f.setAudioResponse(400)
  client.send({ type: 'ask', id: 'fallback', text: 'Solo transcripción', audio: voiceClip(), model: 'opencode-go/fake-model' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'fallback')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 2)
  assert.deepEqual(prompts[1].data.parts, [{ type: 'text', text: 'Solo transcripción' }])
  assert.ok(prompts.every(prompt => prompt.data.parts.every(part => part.type === 'text')))
  assert.ok(client.frames.some(frame => frame.type === 'audio' && frame.ask === 'fallback' && frame.state === 'fallback'))
  const catalog = await (await fetch(`${f.base}/models?project=${f.projects[0].id}`)).json()
  assert.equal(catalog.models.find(model => model.id === 'opencode-go/fake-model').audio, true, 'trial available; provider failure is handled at runtime')
})

test('transcript mode never sends audio to provider even if an old client includes a clip', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setAudioSupport(true)
  const client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'only-text', text: 'Texto elegido', audioMode: 'transcript', audio: voiceClip(), model: 'opencode-go/fake-model' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'only-text')
  assert.equal(f.requests.filter(request => request.path === '/audio-transcribe').length, 0)
  assert.deepEqual(f.requests.find(request => request.path.endsWith('/prompt_async')).data.parts, [{ type: 'text', text: 'Texto elegido' }])
})

test('provider missing-audio status becomes browser fallback, never a forged user utterance', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setAudioSupport(true)
  f.setAudioResponse(200, 'No se ha detectado ningún audio adjunto para transcribir.')
  const client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'no-audio', text: 'Esto sí fue lo que dicté', audioMode: 'clip', audio: voiceClip(), model: 'opencode-go/fake-model' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'no-audio')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'Esto sí fue lo que dicté' }])
  assert.ok(client.frames.some(frame => frame.type === 'audio' && frame.ask === 'no-audio' && frame.state === 'fallback'))
})

test('interrupt during MP3 interpretation never submits a fallback or delayed prompt', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setAudioSupport(true)
  const client = await f.connect(f.projects[0], 'ses_a')
  const gate = f.block('/audio-transcribe')
  client.send({ type: 'ask', id: 'voice-cancel', text: 'No enviar el respaldo', audio: voiceClip(), model: 'opencode-go/fake-model' })
  await until(() => gate.hits > 0, 'MP3 request pending')
  client.send({ type: 'interrupt' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'voice-cancel')
  gate.release()
  client.send({ type: 'ask', id: 'after-voice-cancel', text: 'Nuevo texto', audioMode: 'transcript' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'after-voice-cancel')
  const prompts = f.requests.filter(request => request.path.endsWith('/prompt_async'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].data.parts, [{ type: 'text', text: 'Nuevo texto' }])
  assert.ok(!client.frames.some(frame => frame.type === 'audio' && frame.ask === 'voice-cancel' && frame.state === 'fallback'))
})

test('new empty native chat omits agent/model/variant and injected instructions', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  Object.assign(f.messages.get('ses_a')[0].info, { agent: 'plan', model: { providerID: 'old', modelID: 'other-chat' }, variant: 'high' })
  const client = await f.connect(f.projects[0], 'new')
  const id = client.frames.find(frame => frame.type === 'ready').conversation.id
  assert.notEqual(id, 'ses_a')
  assert.deepEqual(f.messages.get(id), [])
  client.send({ type: 'ask', id: 'empty-default', text: 'First native question', model: 'native/default' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'empty-default')
  const prompt = f.requests.find(request => request.path === `/session/${id}/prompt_async`).data
  assert.deepEqual(prompt, { messageID: prompt.messageID, parts: [{ type: 'text', text: 'First native question' }] })
  assert.match(prompt.messageID, /^msg_/)
  assert.deepEqual(f.forbidden(), [])
})

test('JSON null and array WebSocket messages leave bridge and socket operational', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const client = await f.connect(f.projects[0], 'ses_a')
  for (const malformed of [null, []]) {
    const before = client.frames.length
    client.send(malformed)
    client.send({ type: 'session_list' })
    const listed = await client.frame(frame => frame.type === 'session_list', before)
    assert.ok(listed.entries.some(entry => entry.id === 'ses_a'))
    assert.equal(client.closed, false)
    assert.equal((await fetch(f.base + '/health')).status, 200)
  }
  client.send({ type: 'ask', id: 'after-invalid-json', text: 'Valid request after malformed messages' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'after-invalid-json')
  assert.equal(f.requests.filter(request => request.path.endsWith('/prompt_async')).length, 1)
  assert.deepEqual(f.forbidden(), [])
})

test('explicit interrupt aborts own submitted turn; disconnecting submitted turn does not abort', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setHold(true)
  const client = await f.connect(f.projects[0], 'ses_a')
  client.send({ type: 'ask', id: 'interrupt-me', text: 'Fake held request' })
  await until(() => f.requests.some(r => r.path.endsWith('/prompt_async')), 'held prompt submitted')
  client.send({ type: 'interrupt' })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'interrupt-me')
  assert.deepEqual(f.forbidden().map(r => [r.method, r.path, r.directory]), [['POST', '/session/ses_a/abort', f.directories[0]]])
  client.send({ type: 'ask', id: 'detach-me', text: 'Continue natively after detach' })
  await until(() => f.requests.filter(r => r.path.endsWith('/prompt_async')).length === 2, 'second prompt submitted')
  await client.close(); await sleep(150)
  assert.equal(f.forbidden().length, 1, 'only explicit interrupt mutates native lifecycle')
})

test('external native messages update matching project only, even with globally broadcast SSE', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const a = await f.connect(f.projects[0], 'ses_a')
  const b = await f.connect(f.projects[1], 'ses_b')
  f.messages.get('ses_b').push(user('msg_external_b', 'External private B'))
  f.messages.get('ses_a').push(user('msg_external_a', 'External private A'))
  f.emit()
  await a.frame(frame => frame.type === 'session_update' && frame.turns.some(turn => turn.text === 'External private A'))
  await b.frame(frame => frame.type === 'session_update' && frame.turns.some(turn => turn.text === 'External private B'))
  assert.doesNotMatch(JSON.stringify(a.frames), /Native answer B|External private B|msg_external_b/)
  assert.doesNotMatch(JSON.stringify(b.frames), /Native answer A|External private A|msg_external_a/)
})

test('native child permissions require checked same-directory ancestry; foreign, unrelated and cyclic requests stay hidden', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const a = await f.connect(f.projects[0], 'ses_a')
  const b = await f.connect(f.projects[1], 'ses_b')
  const request = (id, sessionID) => ({ id, sessionID, permission: 'bash', patterns: ['printf fake'] })
  f.setPermissions([
    request('per_child', 'ses_child'), request('per_grandchild', 'ses_grandchild'),
    request('per_forged', 'ses_forged'),
    request('per_unrelated', 'ses_unrelated'), request('per_cycle', 'ses_cycle'), request('per_missing', 'ses_missing'),
    request('per_root_a', 'ses_a'), request('per_b', 'ses_b'),
  ])
  await a.frame(frame => frame.type === 'permissions' && frame.requests.some(p => p.id === 'per_root_a'))
  await b.frame(frame => frame.type === 'permissions' && frame.requests.some(p => p.id === 'per_b'))
  const ids = client => new Set(client.frames.filter(frame => frame.type === 'permissions').flatMap(frame => frame.requests.map(p => p.id)))
  assert.deepEqual(ids(a), new Set(['per_child', 'per_grandchild', 'per_root_a']))
  assert.deepEqual(ids(b), new Set(['per_b']))
  for (const id of ['ses_child', 'ses_grandchild', 'ses_forged', 'ses_unrelated', 'ses_cycle', 'ses_missing']) {
    assert.ok(f.requests.some(r => r.method === 'GET' && r.path === '/session/' + id), `Ancestry checked: ${id}`)
  }
  a.send({ type: 'permission', id: 'per_b', reply: 'once' })
  a.send({ type: 'permission', id: 'per_grandchild', reply: 'once' })
  await until(() => f.requests.some(r => r.path === '/permission/per_grandchild/reply'), 'own child approval forwarded')
  assert.deepEqual(f.forbidden().map(r => [r.path, r.data]), [['/permission/per_grandchild/reply', { reply: 'once' }]])
  await a.close(); await b.close(); await sleep(150)
  assert.equal(f.forbidden().length, 1, 'pending native permissions survive detach')
})


test('OpenCode explicit screen opt-in sends fresh file parts, respects off/text-only and never starts history', async t => {
  const f = await fixture(t, { screenFixture: 'ok' }); f.setImageSupport(true)
  const client = await f.connect(f.projects[0])
  assert.equal(client.frames.find(frame => frame.type === 'ready').capabilities.screenOptIn, true)
  assert.equal((await (await fetch(f.base + '/health')).json()).screenOptIn, true)
  for (const [index, screen] of [true, true, false].entries()) {
    const id = 'screen-fixture-' + index
    client.send({ type: 'ask', id, text: 'Mira mi pantalla', audioMode: 'transcript', screen })
    await client.frame(frame => frame.type === 'done' && frame.ask === id)
    const payload = f.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1).data
    const images = payload.parts.filter(part => part.type === 'file')
    assert.equal(images.length, screen ? 1 : 0)
    if (screen) {
      assert.equal(images[0].mime, 'image/png')
      assert.equal(await readFile(fileURLToPath(images[0].url), 'utf8'), 'fixture-screen-' + (index + 1))
      assert.ok(client.frames.some(frame => frame.type === 'screen' && frame.ask === id && frame.state === 'attached'))
    }
    assert.equal(payload.system, undefined); assert.equal(payload.agent, undefined)
  }
  f.setImageSupport(false)
  client.send({ type: 'ask', id: 'text-only-screen', text: 'Texto', audioMode: 'transcript', screen: true })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'text-only-screen')
  assert.ok(client.frames.some(frame => frame.type === 'screen' && frame.ask === 'text-only-screen' && frame.state === 'unsupported'))
  assert.equal(f.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1).data.parts.some(part => part.type === 'file'), false)
  client.send({ type: 'recording', active: false, requestID: 'pause-fixture-history' })
  const ack = await client.frame(frame => frame.requestID === 'pause-fixture-history')
  assert.equal(ack.type, 'recording'); assert.equal(ack.recording.active, false); assert.equal(ack.recording.controlVersion, 1)
  assert.equal(client.frames.some(frame => frame.type === 'recording' && frame.recording.active), false)
})
test('OpenCode failed screen capture sends text without file and reports failed rather than attached', async t => {
  const f = await fixture(t, { screenFixture: 'fail' }); f.setImageSupport(true)
  const client = await f.connect(f.projects[0])
  client.send({ type: 'ask', id: 'failed-fixture-screen', text: 'Mira mi pantalla', audioMode: 'transcript', screen: true })
  await client.frame(frame => frame.type === 'done' && frame.ask === 'failed-fixture-screen')
  assert.ok(client.frames.some(frame => frame.type === 'screen' && frame.state === 'failed'))
  assert.equal(client.frames.some(frame => frame.type === 'screen' && frame.state === 'attached'), false)
  assert.equal(f.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1).data.parts.some(part => part.type === 'file'), false)
})
