/** Local voice client. OpenCode owns projects, instructions and session lifecycle. */
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { WebSocketServer } from 'ws'
import { Projects, NativeConversations } from './projects.mjs'
import { CodexManager } from './codex-runtime.mjs'
import { attachCodexClient } from './codex-bridge.mjs'
import { availableModels, selectModel } from './model-catalog.mjs'
import { transcript } from './turn-context.mjs'
import { DEFAULT_PROFILE } from '../shared/profile.mjs'
import { readProjectProfile } from './profile.mjs'
import { Permissions } from './permissions.mjs'
import { Recorder } from './recorder.mjs'
import { screenPrompt } from './screen-context.mjs'
import { sessionMedia } from './session-media.mjs'
import { nativeVision, nativeContinuation, turnInspection } from './native-vision.mjs'
import { interpretVoice } from './voice-input.mjs'
import { directAudio } from './direct-audio.mjs'
import { deliverNativeVoice } from './native-voice-delivery.mjs'
import { recoverVoiceHistory } from './voice-history.mjs'
import { TimingStore } from './timings.mjs'

const run = promisify(execFile)
const PORT = Number(process.env.JARVIS_BRIDGE_PORT || 8787)
const codex = new CodexManager()
const projects = new Projects({ codex, serverURL: process.env.OPENCODE_URL || 'http://127.0.0.1:4097',
  password: process.env.OPENCODE_SERVER_PASSWORD || '', username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
  ...(process.env.JARVIS_PROJECT_REGISTRY ? { file: process.env.JARVIS_PROJECT_REGISTRY } : {}) })
const timingStore = new TimingStore(process.env.JARVIS_TIMINGS_DIR || join(process.env.JARVIS_PROJECT_REGISTRY
  ? dirname(process.env.JARVIS_PROJECT_REGISTRY) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'mi-asistente'), 'timings'))
const httpTimings = timingStore.recorder()
const recorder = new Recorder(undefined, httpTimings)
const traceID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : randomUUID()
// A project client never starts recording as a side effect of opening a folder.
const sessionsSending = new Map()
const origins = new Set((process.env.JARVIS_ALLOWED_ORIGINS || '').split(',').filter(Boolean))
const allowed = origin => {
  if (!origin) return false
  if (origins.has(origin)) return true
  try { const u = new URL(origin); return u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname) &&
    ((Number(u.port) >= 5173 && Number(u.port) <= 5199) || (Number(u.port) >= 4173 && Number(u.port) <= 4199)) } catch { return false }
}
const nativeDefault = { id: 'native/default', name: 'Predeterminado del proyecto', provider: 'OpenCode', free: false,
  cost: { input: null, output: null }, image: false, audio: false, variants: [] }
const publicProfile = async project => {
  if (!project) return { ...DEFAULT_PROFILE, configured: true }
  return readProjectProfile(project.directory)
}
const publicError = error => {
  if (/file part media type audio\/.*functionality not supported/.test(String(error?.data?.message || error?.message || ''))) {
    return 'El historial contiene un audio antiguo incompatible con el modelo. No se pudo recuperarlo automáticamente; conserva este chat y abre uno nuevo para continuar.'
  }
  if (/this model does not read audio/i.test(String(error?.data?.message || error?.message || ''))) return 'El proveedor rechazó el audio aunque su catálogo lo anuncia. Elige Gemini para continuar con clips de voz.'
  if (error?.data?.statusCode === 401) return 'OpenCode rechazó la credencial del modelo (401). Actualízala en OpenCode y vuelve a conectar.'
  return String(error?.data?.message || error?.message || 'OpenCode no pudo completar la operación.')
    .replace(/(?:oc_sk_|sk-)[A-Za-z0-9_-]+/g, '[credencial oculta]').slice(0, 350)
}
async function body(req) {
  let text = ''
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 12000) throw new Error('Solicitud demasiado grande.') }
  try { return JSON.parse(text || '{}') } catch { throw new Error('Solicitud JSON inválida.') }
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  const cors = origin && allowed(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,x-timing-trace', vary: 'origin' } : {}
  const json = (status, value) => { res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  try {
    if (!['localhost','127.0.0.1','[::1]'].includes(new URL('http://' + req.headers.host).hostname)) return json(403, { error: 'Host no permitido.' })
  } catch { return json(403, { error: 'Host inválido.' }) }
  if ((origin && !allowed(origin)) || (req.method !== 'GET' && req.method !== 'OPTIONS' && !allowed(origin))) return json(403, { error: 'Origen no permitido.' })
  if (req.method === 'OPTIONS') return json(200, {})
  const url = new URL(req.url, 'http://localhost')
  const route = ({ '/projects': req.method === 'POST' ? 'project.open' : 'project.list', '/projects/browse': 'project.browse', '/models': 'model.catalog', '/profile': 'profile.load' })[url.pathname]
  const httpSpan = route ? httpTimings.start(route, traceID(req.headers['x-timing-trace'])) : null
  res.once('finish', () => httpSpan?.end(res.statusCode < 400 ? 'ok' : 'error'))
  res.once('close', () => { if (!res.writableFinished) httpSpan?.end('detached') })
  try {
    if (url.pathname === '/timings' && req.method === 'GET') return json(200, await timingStore.snapshot())
    if (url.pathname === '/timings' && req.method === 'POST') {
      const payload = await body(req)
      if (!Array.isArray(payload?.events) || payload.events.length > 24) return json(400, { error: 'Lote de tiempos inválido.' })
      const accepted = payload.events.filter(e => e?.phase === 'end' && timingStore.add(e, 'browser')).length
      return json(200, { accepted })
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, brain: 'opencode', projects: true, applications: ['opencode', 'codex'], tts: false, stt: false, autoScreen: process.env.JARVIS_AUTO_SCREEN !== '0' })
    if (req.method === 'GET' && url.pathname === '/projects') return json(200, { projects: await projects.list(), defaultServerURL: projects.serverURL })
    if (req.method === 'POST' && url.pathname === '/projects') return json(200, { project: await projects.open(await body(req)) })
    if (req.method === 'POST' && url.pathname === '/projects/browse') {
      await body(req)
      try { const { stdout } = await run('zenity', ['--file-selection', '--directory', '--title=Abrir proyecto'], { timeout: 120000, maxBuffer: 16384 }); return json(200, { directory: stdout.trim() || null }) }
      catch (error) {
        if (error.code === 1) return json(200, { directory: null })
        throw new Error('No se pudo abrir el selector. Escribe la ruta absoluta de la carpeta.')
      }
    }
    const project = url.searchParams.has('project') ? await projects.get(url.searchParams.get('project')) : null
    if (req.method === 'GET' && url.pathname === '/profile') return json(200, await publicProfile(project))
    if (req.method === 'GET' && url.pathname === '/models') {
      if (!project) return json(200, { models: [nativeDefault], defaultModel: nativeDefault.id })
      if (project.application === 'codex') return json(200, { models: [{ ...nativeDefault, provider: 'Codex', audioReason: 'Codex usa solo dictado del navegador en este cliente; el audio directo está deshabilitado.' }, ...await codex.models(project.directory)], defaultModel: nativeDefault.id })
      return json(200, { models: [nativeDefault, ...availableModels(await projects.api(project)('GET', '/provider'))], defaultModel: nativeDefault.id })
    }
    return json(404, { error: 'Ruta no disponible.' })
  } catch (error) { return json(400, { error: publicError(error) }) }
})
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024, verifyClient: ({ origin }, done) => done(allowed(origin), 403, 'Forbidden') })
wss.on('connection', async (socket, req) => {
  const queued = []
  const buffer = raw => { if (queued.length < 20) queued.push(raw) }
  socket.on('message', buffer)
  const initialQuery = new URL(req.url, 'http://localhost').searchParams
  let initialProject
  try { if (initialQuery.get('project')) initialProject = await projects.get(initialQuery.get('project')) }
  catch (error) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'session_error', message: publicError(error) }))
    socket.close(); return
  }
  if (socket.readyState !== socket.OPEN) return
  if (initialProject?.application === 'codex') {
    try { await attachCodexClient(socket, { project: initialProject, manager: codex, recorder, timingStore, queued, buffer, query: initialQuery }) }
    catch (error) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'session_error', message: publicError(error) }))
      socket.close()
    }
    return
  }
  const send = value => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value)) }
  const query = new URL(req.url, 'http://localhost').searchParams
  const timing = timingStore.recorder(event => send({ type: 'timing', event }))
  const connectingSpan = timing.start('connection.ready', traceID(query.get('trace')))
  const measured = async (name, trace, fn) => {
    const span = timing.start(name, trace)
    try { const value = await fn(); span.end(); return value }
    catch (error) { span.end(error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'cancelled' : 'error'); throw error }
  }
  const endOperation = (current, status = 'ok') => {
    current?.prepareSpan?.end(status); current?.firstSpan?.end(status); current?.responseSpan?.end(status)
    for (const span of current?.permissionSpans?.values() || []) span.end(status)
  }
  let gone = false, project, api, conversations, session, permissions, timer, poller
  let syncing = false, repeat = false, last = '', own = null, capture = null
  let lastIdleSample = 0, eventWait = null
  let interruptedBySpeech = 0, consumedSpeechInterruption = 0, lastDirectAudio = false
  const events = new AbortController()
  const media = sessionMedia()
  const localKey = () => project.id + ':' + session.id
  const release = current => { if (session && sessionsSending.get(localKey()) === current) sessionsSending.delete(localKey()) }
  // Ask OpenCode for ancestry, never route a permission solely by its supplied ID.
  async function belongs(id) {
    const visited = new Set()
    for (let i=0; id && i<8 && !visited.has(id); i++) {
      if (id === session.id) return true
      visited.add(id)
      const child = await api('GET', '/session/' + encodeURIComponent(id)).catch(() => null)
      if (!child || child.directory !== project.directory) return false
      id = child.parentID
    }
    return false
  }
  async function sync() {
    if (gone || !session) return
    if (syncing) { repeat = true; return }
    syncing = true
    const sample = own || Date.now() - lastIdleSample > 30000
    if (sample) lastIdleSample = Date.now()
    const syncSpan = sample ? timing.start('bridge.sync', own?.traceId) : null
    try {
      await conversations.checked(session.id)
      const [messages, statuses, pending] = await Promise.all([api('GET', `/session/${session.id}/message`), api('GET', '/session/status'), api('GET', '/permission')])
      if (gone) return
      const busy = !!statuses[session.id] && statuses[session.id].type !== 'idle'
      const turns = transcript(messages)
      const snapshot = JSON.stringify({ turns, busy })
      if (snapshot !== last) { last = snapshot; send({ type: 'session_update', turns, busy }) }
      for (const item of pending) {
        if (!await belongs(item.sessionID)) continue
        const rootRequest = { ...item, sessionID: session.id }
        void permissions.receive(rootRequest)
      }
      const pendingIDs = new Set(pending.map(p => p.id))
      for (const id of permissions.pending.keys()) if (!pendingIDs.has(id)) permissions.resolved(id)
      if (own) {
        for (const id of permissions.pending.keys()) if (!own.permissionSpans.has(id)) own.permissionSpans.set(id, timing.start('permission.wait', own.traceId))
        for (const [id, span] of own.permissionSpans) if (!pendingIDs.has(id)) { span.end(); own.permissionSpans.delete(id) }
      }
      if (!own || !own.submitted) return
      const current = own
      const responses = messages.filter(m => m.info?.role === 'assistant' && m.info.parentID === current.messageID)
      const text = responses.flatMap(m => m.parts.filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text)).join('\n')
      const error = responses.find(m => m.info.error)?.info.error
      if (text.startsWith(current.text) && text.length > current.text.length) {
        current.firstSpan?.end()
        send({ type: 'text', ask: current.id, delta: text.slice(current.text.length) })
      }
      current.text = text
      const tools = responses.flatMap(m => m.parts.filter(p => p.type === 'tool'))
      for (const part of tools) {
        if (!current.tools.has(part.callID)) { current.tools.add(part.callID); send({ type: 'tool', ask: current.id, name: part.tool }) }
        if (!current.toolTimes.has(part.callID) && Number.isFinite(part.state?.time?.start) && Number.isFinite(part.state?.time?.end)) {
          current.toolTimes.add(part.callID)
          const at = part.state.time.start, durationMs = part.state.time.end - at
          const event = { traceId: current.traceId, id: randomUUID(), name: 'tool.execution', source: 'bridge', phase: 'end', status: part.state.status === 'error' ? 'error' : 'ok', at, durationMs }
          if (timingStore.add(event, 'bridge')) send({ type: 'timing', event })
        }
      }
      if (error && error.name !== 'MessageAbortedError') { endOperation(current, 'error'); send({ type: 'error', ask: current.id, message: publicError(error) }); own = null; release(current) }
      else if (!busy && responses.length && responses.every(m => m.info.time?.completed || m.info.error)) {
        const status = responses.some(m => m.info.error?.name === 'MessageAbortedError') ? 'cancelled' : 'ok'
        if (!text) current.firstSpan?.end('cancelled')
        endOperation(current, status)
        send({ type: 'done', ask: current.id, text, status }); own = null; release(current)
      }
      syncSpan?.end()
    } catch (error) { syncSpan?.end('error'); if (!gone) send({ type: 'status_error', message: publicError(error) }) }
    finally { syncSpan?.end(); syncing = false; if (repeat && !gone) { repeat = false; schedule() } }
  }
  function schedule() { if (!timer && !gone) {
    eventWait = own ? timing.start('bridge.event_wait', own.traceId) : null
    timer = setTimeout(() => { timer = null; eventWait?.end(); eventWait = null; void sync() }, 80)
  } }
  async function stream() {
    // Polling recovers missed events; SSE keeps first-token latency low.
    while (!gone) {
      try {
        const res = await measured('bridge.events_connect', connectingSpan.traceId, () => api.events(events.signal))
        if (!res.ok || !res.body) throw new Error('Eventos no disponibles')
        const reader = res.body.getReader()
        try { for (;;) { const value = await reader.read(); if (value.done || gone) break; schedule() } }
        finally { await reader.cancel().catch(() => {}) }
      } catch { if (gone) return }
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  socket.on('close', () => {
    eventWait?.end('detached')
    connectingSpan.end('detached'); endOperation(own, 'detached')
    gone = true; events.abort(); clearTimeout(timer); clearInterval(poller); capture?.abort()
    // Detach only: never abort, reject permissions or rewrite native history.
    if (permissions) { permissions.epoch++; permissions.pending.clear(); permissions.mode = 'manual' }
    release(own)
    // Keep submitted attachments available for OpenCode's asynchronous ingestion.
    if (!own?.submitted) void media.then(value => value.close()).catch(() => {})
    else { const cleanup = setTimeout(() => { void media.then(value => value.close()).catch(() => {}) }, 30*60*1000); cleanup.unref() }
  })
  try {
    const id = query.get('project')
    if (!id) { connectingSpan.end(); send({ type: 'project_required', servers: [] }); return }
    project = initialProject || await projects.get(id); api = projects.api(project)
    conversations = new NativeConversations(api, project.directory)
    const choice = query.get('session')
    const entries = await conversations.list()
    session = await conversations.open(choice || entries[0]?.id || 'new')
    if (gone) return
    permissions = new Permissions({ workspace: project.directory, session: () => session.id,
      reply: (id, reply) => api('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply }),
      publish: requests => send({ type: 'permissions', requests }), publishMode: policy => send({ type: 'permission_mode', policy }) })
    send({ type: 'ready', servers: ['opencode', project.name], conversation: { id: session.id, title: session.title,
      resumed: choice !== 'new', entries: await conversations.list(), turns: transcript(await api('GET', `/session/${session.id}/message`)) }, native: true })
    connectingSpan.end()
    if (gone) return
    send({ type: 'recording', recording: recorder.snapshot() })
    send({ type: 'permission_mode', policy: permissions.snapshot() })
    poller = setInterval(() => { void sync(); send({ type: 'recording', recording: recorder.snapshot() }) }, 1400)
    void sync(); void stream()
  } catch (error) { connectingSpan.end('error'); send({ type: 'session_error', message: publicError(error) }); socket.close(); return }
  const onMessage = async raw => {
    let msg
    let operation
    let interruptBarrier
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
    // The active submission can belong to another view of this native chat.
    const stopping = msg.type === 'interrupt' ? sessionsSending.get(localKey()) || own : null
    if (msg.type === 'interrupt') {
      if (sessionsSending.get(localKey())?.interrupting) return
      const preserveClip = msg.reason === 'speech' && stopping?.audioDirect && !stopping.submitted
      if (preserveClip) stopping.preserveOnly = true
      else { capture?.abort(); stopping?.controller?.abort() }
      interruptBarrier = { interrupting: true }
      sessionsSending.set(localKey(), interruptBarrier)
    }
    try {
      if (msg.type === 'ask') {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return
        if (sessionsSending.has(localKey())) throw new Error('La conversación ya está trabajando. Espera o detenla explícitamente.')
        const trace = traceID(msg.traceId)
        operation = { id: msg.id, audioDirect: msg.audioMode === 'direct', traceId: trace, prepareSpan: timing.start('bridge.prepare', trace), permissionSpans: new Map(), toolTimes: new Set(), messageID: 'msg_' + Date.now().toString(16) + randomUUID().replaceAll('-', ''), text: '', tools: new Set(), submitted: false, controller: new AbortController() }
        operation.preserveOnly = operation.audioDirect && msg.preserveOnly === true
        operation.prepared = new Promise(resolve => { operation.finishPreparation = resolve })
        operation.stopConfirmed = () => {
          endOperation(operation, 'cancelled')
          send({ type: 'done', ask: operation.id, text: operation.text, status: 'cancelled' })
          if (own === operation) own = null
          release(operation); schedule()
        }
        own = operation; capture = operation.controller
        sessionsSending.set(localKey(), operation)
      }
      session = operation ? await measured('bridge.membership', operation.traceId, () => conversations.checked(session.id)) : await conversations.checked(session.id)
      if (gone || operation?.controller.signal.aborted) return
      if (msg.type === 'recording' && typeof msg.active === 'boolean') { await recorder.setActive(msg.active); send({ type: 'recording', recording: recorder.snapshot() }); return }
      if (msg.type === 'session_list') { send({ type: 'session_list', entries: await conversations.list() }); return }
      if (msg.type === 'session_delete' && msg.id === session.id) {
        if (await conversations.remove(msg.id) !== true) throw new Error('OpenCode no confirmó el borrado.')
        send({ type: 'session_deleted' }); socket.close(); return
      }
      if (msg.type === 'permission') { await permissions.respond(msg.id, msg.reply); return }
      if (msg.type === 'permission_mode') {
        const success = permissions.setMode(msg.mode, msg.confirmed)
        send({ type: 'permission_mode', requestID: msg.requestID, policy: { ...permissions.snapshot(), ...(!success ? { error: 'Modo inválido o sin confirmación.' } : {}) } }); return
      }
      if (msg.type === 'interrupt') {
        // A prompt already crossing HTTP must finish submission before abort.
        // Otherwise a delayed prompt could start after OpenCode acknowledged stop.
        if (msg.reason === 'speech' && stopping?.audioDirect) {
          await stopping.prepared
          if (stopping.failure) throw stopping.failure
          if (!stopping.audioStored) throw new Error('No se pudo confirmar el guardado del clip anterior; no se continuará omitiéndolo.')
        } else if (stopping?.submission) await stopping.submission.catch(() => {})
        await measured('bridge.interrupt', stopping?.traceId, () => api('POST', `/session/${session.id}/abort`))
        endOperation(stopping, 'cancelled')
        if (msg.reason === 'speech' && (stopping?.audioDirect || lastDirectAudio)) interruptedBySpeech++
        stopping?.stopConfirmed?.()
        if (own === stopping) own = null
        send({ type: 'interrupted', requestID: msg.requestID, status: 'ok' })
        release(stopping); schedule(); return
      }
      if (msg.type !== 'ask' || typeof msg.text !== 'string' || !msg.text.trim()) return
      const statuses = await measured('bridge.status', operation.traceId, () => api('GET', '/session/status'))
      operation.controller.signal.throwIfAborted()
      if (gone || own !== operation) return
      if (statuses[session.id] && statuses[session.id].type !== 'idle') throw new Error('OpenCode está trabajando en esta conversación desde otro cliente. Espera o usa Detener respuesta.')
      const current = operation
      const signal = current.controller.signal
      const recovered = await measured('bridge.recovery', current.traceId, () => recoverVoiceHistory(api, session, { signal }))
      signal.throwIfAborted()
      if (gone || own !== current) return
      if (recovered) {
        send({ type: 'session_list', entries: await conversations.list() })
        send({ type: 'audio', ask: current.id, state: 'processing', message: 'Historial recuperado. Se conservó una copia nativa de respaldo y todo el texto.' })
      }
      const selectionSpan = timing.start('bridge.selection', current.traceId)
      const inspect = turnInspection(api)
      if (current.audioDirect) for (const path of ['/config', '/agent', '/provider']) void inspect('GET', path).catch(() => {})
      let selection
      let image = false
      try {
      selection = await nativeContinuation(inspect, session)
      if (msg.model && msg.model !== nativeDefault.id) {
        const selected = selectModel(await inspect('GET', '/provider'), msg.model, msg.variant || '')
        selection = { ...(selection.agent ? { agent: selection.agent } : {}), model: selected.model, ...(selected.variant ? { variant: selected.variant } : {}) }; image = selected.image
      } else {
        // Inspection cannot change the agent, model or reasoning selected by OpenCode.
        if (process.env.JARVIS_AUTO_SCREEN !== '0') image = await nativeVision(inspect, session, selection)
      }
      selectionSpan.end()
      } catch (error) { selectionSpan.end('error'); throw error }
      const audioSpan = msg.audioMode !== 'transcript' && msg.audio ? timing.start('audio.total', current.traceId) : null
      let audioFallback = false, text, nativeAudio
      const direct = msg.audioMode === 'direct'
      try {
      if (direct) {
        if (!msg.audio) throw new Error('No se obtuvo un clip completo; no se sustituyó tu voz por la transcripción del navegador.')
        send({ type: 'audio', ask: current.id, state: 'processing', message: 'Preparando audio directo…' })
        nativeAudio = await directAudio({ api: inspect, session, selection, clip: msg.audio, signal, measure: (name, fn) => measured(name, current.traceId, fn) })
        text = 'Escucha el audio adjunto junto con los fragmentos anteriores de esta intervención que todavía no hayas respondido. Responde a lo que dice el usuario considerando la intervención completa, no solo la última frase.'
      } else text = audioSpan ? await interpretVoice({ api: inspect, session, selection, clip: msg.audio, text: msg.text, signal,
        measure: (name, fn) => measured(name, current.traceId, fn),
        notify: state => { if (state.state === 'fallback') audioFallback = true; send({ type: 'audio', ask: current.id, ...state }) },
      }) : msg.text
      audioSpan?.end(audioFallback ? 'fallback' : 'ok')
      } catch (error) { audioSpan?.end(signal.aborted ? 'cancelled' : 'error'); throw error }
      signal.throwIfAborted()
      if (gone || own !== current) return
      session = await conversations.checked(session.id)
      let screenFailed = false
      const screenSpan = !current.preserveOnly && image && process.env.JARVIS_AUTO_SCREEN !== '0' ? timing.start('screen.capture', current.traceId) : null
      let visual
      try { visual = screenSpan ? await screenPrompt(text, {
        signal, attach: (image, options) => media.then(files => files.attach(image, options)),
        onState: state => { if (state === 'failed') screenFailed = true; send({ type: 'screen', ask: current.id, state }) },
      }) : { parts: [{ type: 'text', text }] }
      screenSpan?.end(screenFailed ? 'fallback' : 'ok')
      } catch (error) { screenSpan?.end('cancelled'); throw error }
      signal.throwIfAborted()
      if (gone || own !== current) return
      if (direct) {
        // Browser dictation stays visual. Only this fixed instruction and actual
        // audio enter the native conversation, with interruption context if any.
        visual.parts[0].synthetic = true
        if (current.preserveOnly) visual.parts[0].text = 'Este audio es un fragmento de una intervención del usuario que continúa en los siguientes clips. Conserva su contenido como parte de esa misma intervención.'
        if (interruptedBySpeech > consumedSpeechInterruption) visual.parts.unshift({ type: 'text', synthetic: true, text: 'La respuesta anterior fue interrumpida porque el usuario continuó hablando. Escucha este nuevo clip como continuación o corrección de su intervención; responde teniendo en cuenta los audios previos.' })
        visual.parts.push(nativeAudio)
      }
      current.submitted = true
      current.prepareSpan.end()
      if (!current.preserveOnly) {
        current.firstSpan = timing.start('bridge.first_text', current.traceId)
        current.responseSpan = timing.start('bridge.response', current.traceId)
      }
      // Only native conversation selections; no UI identity/bootstrap/system override.
      const interruptionAtSubmit = interruptedBySpeech
      const request = { messageID: current.messageID, ...selection, parts: visual.parts }
      current.submission = measured('bridge.submit', current.traceId, () => direct
        ? deliverNativeVoice(api, session.id, request, { noReply: current.preserveOnly })
        : api('POST', `/session/${session.id}/prompt_async`, request))
      await current.submission
      current.audioStored = direct
      if (!current.preserveOnly) send({ type: 'submitted', ask: current.id })
      lastDirectAudio = direct
      if (direct) consumedSpeechInterruption = interruptionAtSubmit
      if (direct) send({ type: 'audio', ask: current.id, state: 'attached', message: current.preserveOnly
        ? 'Clip conservado completo en el chat; esperando tu continuación.'
        : 'Audio enviado directamente al modelo; el dictado del navegador no se envió.' })
      if (current.preserveOnly) {
        endOperation(current, 'cancelled')
        send({ type: 'done', ask: current.id, text: '', status: 'cancelled' })
        if (own === current) own = null
        release(current)
      }
      schedule()
    } catch (error) {
      if (operation) operation.failure = error
      if (msg.type === 'interrupt') send({ type: 'interrupted', requestID: msg.requestID, status: 'error' })
      endOperation(operation, operation?.controller.signal.aborted ? 'cancelled' : 'error')
      if (operation) { if (own === operation) own = null; release(operation) }
      if (!operation?.controller.signal.aborted) send({ type: ['session_list','session_delete'].includes(msg.type) ? 'session_error' : 'error', ask: msg.id, message: publicError(error) })
    } finally {
      operation?.finishPreparation?.()
      if (operation && (gone || operation.controller.signal.aborted)) endOperation(operation, gone ? 'detached' : 'cancelled')
      if (operation && (!operation.submitted || gone || own !== operation)) { release(operation); if (own === operation && !operation.submitted) own = null }
      if (interruptBarrier) release(interruptBarrier)
    }
  }
  socket.off('message', buffer)
  socket.on('message', onMessage)
  for (const raw of queued) void onMessage(raw)
})
let shuttingDown = false
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return
  shuttingDown = true
  for (const socket of wss.clients) socket.close()
  clearInterval(recorder.maintenance)
  void Promise.allSettled([recorder.setActive(false), codex.close()]).finally(() => server.close(() => process.exit(0)))
  setTimeout(() => process.exit(0), 2000).unref()
})
server.listen(PORT, process.env.JARVIS_BRIDGE_HOST || '127.0.0.1')
console.log(`[project-client] http://127.0.0.1:${PORT} · OpenCode ${projects.serverURL} · proyectos reales`)
