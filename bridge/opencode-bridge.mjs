/**
 * JARVIS bridge, OpenCode edition.
 *
 * Same wire protocol to the face as bridge/server.mjs (ready / text / tool /
 * done / error out; ask / interrupt in), but the brain is an `opencode serve`
 * instance instead of Claude Code. Minimal on purpose: conversation, web
 * search/fetch and desktop screenshots. No blades, UI control, camera or
 * Chrome control — those are in-process tools of the Claude SDK.
 *
 * Official standard build agent with actual, one-use user confirmations.
 * Only the archive/screenshot MCP and web readers are pre-authorized.
 * The bridge only speaks to the face over HTTP/WS on 127.0.0.1.
 *
 * Env:
 *   OPENCODE_URL              default http://127.0.0.1:4097
 *   OPENCODE_SERVER_PASSWORD  basic-auth password for opencode serve (user "opencode")
 *   JARVIS_OC_MODEL           default model from a connected OpenCode provider
 *   JARVIS_BRIDGE_PORT        default 8787
 */
import http from 'node:http'
import { availableModels, selectModel } from './model-catalog.mjs'
import { WebSocketServer } from 'ws'
import { screenPrompt } from './screen-context.mjs'
import { MONITORS } from './desktop.mjs'
import { Recorder } from './recorder.mjs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Conversations } from './conversations.mjs'
import { turnParts, transcript } from './turn-context.mjs'
import { Permissions } from './permissions.mjs'
import { sessionMedia } from './session-media.mjs'
import { clearPreviousMedia } from './visual-context.mjs'
import { HISTORY_ROOT } from './history-store.mjs'
import { readProfile } from './profile.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const OC = (process.env.OPENCODE_URL ?? 'http://127.0.0.1:4097').replace(/\/+$/, '')
const OC_AUTH = process.env.OPENCODE_SERVER_PASSWORD
  ? { authorization: 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64') }
  : {}
const MODEL = process.env.JARVIS_OC_MODEL || 'opencode/deepseek-v4.1-flash-free'
if (!/^[\w.-]+\/.+/.test(MODEL)) {
  throw new Error('Identificador de modelo inválido; usa proveedor/modelo.')
}
const AGENT = 'build'
const WORKSPACE = fileURLToPath(new URL('../opencode/workspace/', import.meta.url))
const conversations = new Conversations(oc, WORKSPACE)
const SETTLE_CAP_MS = 400
const AUTO_SCREEN = process.env.JARVIS_AUTO_SCREEN === '1'
const SCREEN_MONITOR = MONITORS.includes(process.env.JARVIS_SCREEN_MONITOR)
  ? process.env.JARVIS_SCREEN_MONITOR : 'principal'
const recorder = new Recorder()
if (process.env.JARVIS_RECORDING === '1') {
  void recorder.setActive(true).catch((err) => { recorder.state.error = err.message })
}

// --- origins: identical policy to server.mjs ---------------------------------
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const isDevPort = (p) => (p >= 5173 && p <= 5199) || (p >= 4173 && p <= 4199)
function originAllowed(origin) {
  if (!origin) return false
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  try {
    const u = new URL(origin)
    return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname) && isDevPort(Number(u.port))
  } catch {
    return false
  }
}

// --- OpenCode HTTP ------------------------------------------------------------
async function oc(method, path, body, { signal } = {}) {
  const timeout = AbortSignal.timeout(15000)
  const options = {
    method,
    headers: { ...OC_AUTH, ...(body ? { 'content-type': 'application/json' } : {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') options.body = JSON.stringify(body)
  const res = await fetch(OC + path, options)
  if (!res.ok) throw new Error(`opencode ${method} ${path} -> ${res.status} ${await res.text().catch(() => '')}`)
  const t = await res.text()
  return t ? JSON.parse(t) : null
}

/** The face's filler table keys off Claude-style names; translate. */
function toolName(tool) {
  if (tool.startsWith('jarvis_desktop_')) return `mcp__jarvis_desktop__${tool.slice('jarvis_desktop_'.length)}`
  if (tool === 'webfetch') return 'WebFetch'
  if (tool === 'websearch') return 'WebSearch'
  return tool
}

// --- event fan-out: one SSE stream, routed by session --------------------------
const handlers = new Map() // sessionID -> (event) => void

async function pumpEvents() {
  for (;;) {
    try {
      const res = await fetch(OC + '/event', { headers: OC_AUTH })
      if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
      console.log('[jarvis-oc] event stream connected')
      // Recover pending confirmations if the SSE transport was interrupted.
      void oc('GET', '/permission').then((requests) => {
        for (const request of requests) handlers.get(request.sessionID)?.({ type: 'permission.asked', properties: request })
      }).catch(() => {})
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          let ev
          try {
            ev = JSON.parse(line.slice(5))
          } catch {
            continue
          }
          const p = ev.properties ?? {}
          const sid = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID
          const h = sid && handlers.get(sid)
          if (h) h(ev)
        }
      }
    } catch (err) {
      console.error('[jarvis-oc] event stream error:', err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// --- HTTP: health only --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  const cors = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'origin' } : {}
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }
  if (req.method === 'GET' && req.url === '/models') {
    try {
      const models = availableModels(await oc('GET', '/provider'))
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ defaultModel: MODEL, models }))
    } catch {
      res.writeHead(503, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Catálogo no disponible.' }))
    }
  }
  if (req.method === 'GET' && req.url === '/profile') {
    try {
      const profile = await readProfile()
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(profile))
    } catch {
      res.writeHead(503, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ error: 'Configuración ilegible; no se sobrescribió.' }))
    }
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, tts: false, stt: false, brain: 'opencode', model: MODEL, agent: AGENT, autoScreen: AUTO_SCREEN,
      permissionModes: ['manual', 'limited', 'total'], permissionDefault: 'manual' }))
  }
  res.writeHead(404, cors)
  res.end('not found')
})

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, done) => {
    if (!originAllowed(origin)) {
      console.warn(`[jarvis-oc] rejected websocket from origin ${origin ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})

wss.on('connection', async (socket, request) => {
  console.log('[jarvis-oc] client connected')
  const send = (msg) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg))

  // Messages can arrive before the OpenCode session exists (the face asks the
  // moment the socket opens), so every ask waits on `settling`, which starts as
  // the session creation itself.
  let sessionID
  const owner = randomUUID()
  const choice = new URL(request.url, 'http://localhost').searchParams.get('session') || undefined
  const media = sessionMedia()
  let policyRequestID
  const permissions = new Permissions({
    workspace: WORKSPACE,
    session: () => sessionID,
    reply: (id, reply) => oc('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply }),
    publish: (requests) => send({ type: 'permissions', requests }),
    publishMode: (policy) => send({ type: 'permission_mode', policy, ...(policyRequestID ? { requestID: policyRequestID } : {}) }),
  })
  const created = oc('GET', '/provider').then((catalog) => {
    selectModel(catalog, MODEL)
    return conversations.open(choice, owner)
  }).then(
    async (ses) => {
      sessionID = ses.id
      if (socket.readyState !== socket.OPEN) {
        await conversations.release(sessionID, owner)
        return false
      }
      handlers.set(sessionID, onEvent)
      // Remove the last visual payload too: stored chats retain text, not a screen archive.
      await clearPreviousMedia(oc, sessionID)
      const turns = transcript(await oc('GET', `/session/${sessionID}/message`))
      send({ type: 'ready', conversation: { ...ses, turns, entries: await conversations.list() }, servers: ['opencode', 'jarvis_desktop', 'historial 30 min', ...(AUTO_SCREEN ? ['pantalla automática'] : [])] })
      send({ type: 'recording', recording: recorder.snapshot() })
      send({ type: 'permission_mode', policy: permissions.snapshot() })
      return true
    },
    (err) => {
      console.error('[jarvis-oc] cannot create session:', err.message)
      send({ type: 'session_error', message: err.message.includes('coste cero') ? err.message : 'No se pudo abrir la conversación. Puede estar abierta en otra ventana, haber sido borrada o no estar disponible OpenCode. Puedes crear una nueva.' })
      socket.close()
      return false
    },
  ).catch((err) => {
    console.error('[jarvis-oc] cannot open saved conversation:', err.message)
    send({ type: 'session_error', message: 'No se pudo abrir el chat guardado. Puedes crear uno nuevo; no se borró el anterior.' })
    socket.close()
    return false
  })

  // Per-turn state. `answering` tags every frame with the question it belongs
  // to, so the face can drop the tail of an interrupted answer.
  let answering = null
  let turnText = ''
  let turnStart = 0
  let firstToken = 0
  let lastTextPart = null
  const textParts = new Set()
  const announced = new Set()
  let finishTurn = null
  let settling = created
  let busy = false
  let cost = 0
  let generation = 0
  let capturing = null
  let submitted = false
  let permissionRejected = false
  let closingSession = false

  const sendTurn = (msg) => send({ ...msg, ask: answering })

  const endTurn = () => {
    busy = false
    submitted = false
    finishTurn?.()
    finishTurn = null
    textParts.clear()
    announced.clear()
  }

  function onEvent(ev) {
    if (ev.type === 'permission.asked' || ev.type === 'permission.v2.asked') {
      if (submitted) permissions.receive(ev.properties)
      else void oc('POST', `/permission/${encodeURIComponent(ev.properties.id)}/reply`, { reply: 'reject' }).catch(() => {})
      return
    }
    if (ev.type === 'permission.replied' || ev.type === 'permission.v2.replied') {
      if (ev.properties.reply === 'reject') permissionRejected = true
      permissions.resolved(ev.properties.requestID)
      return
    }
    // No model work exists yet while the local screenshot is being prepared.
    if (!submitted) return
    const p = ev.properties ?? {}
    switch (ev.type) {
      case 'message.part.updated': {
        const part = p.part
        if (!part) break
        if (part.type === 'text' && !part.synthetic) textParts.add(part.id)
        if (part.type === 'tool') {
          const st = part.state?.status
          if (st === 'running' && !announced.has(part.callID)) {
            announced.add(part.callID)
            sendTurn({ type: 'tool', name: toolName(part.tool) })
            console.log(`[jarvis-oc] tool ${part.tool} running`)
          }
          if (st === 'error') console.log(`[jarvis-oc] tool ${part.tool} error: ${String(part.state?.error ?? '').slice(0, 160)}`)
        }
        break
      }
      case 'message.part.delta': {
        if (p.field !== 'text' || !p.delta || !textParts.has(p.partID)) break
        if (!firstToken) firstToken = Date.now()
        // A new text part (e.g. after a tool call) starts a new sentence; keep
        // it from gluing onto the previous one ("…monitor.La captura…").
        let delta = p.delta
        if (p.partID !== lastTextPart) {
          if (lastTextPart && turnText && !/\s$/.test(turnText)) delta = ' ' + delta
          lastTextPart = p.partID
        }
        turnText += delta
        sendTurn({ type: 'text', delta })
        break
      }
      case 'message.updated': {
        if (p.info?.role === 'assistant' && typeof p.info.cost === 'number') cost = p.info.cost
        break
      }
      case 'session.error': {
        const e = p.error
        if (e?.name === 'MessageAbortedError') break
        console.error('[jarvis-oc] session error:', JSON.stringify(e ?? {}).slice(0, 300))
        const detail = String(e?.data?.message || e?.message || '')
        sendTurn({ type: 'error', message: detail.includes('free tier can only be used')
          ? 'OpenCode rechazó el acceso al modelo (403). La grabación local sigue disponible; no se intentó con otro modelo.'
          : 'Me temo que el cerebro de OpenCode falló en ese turno.' })
        endTurn()
        break
      }
      case 'session.idle': {
        if (!busy) break
        if (!turnText && permissionRejected) {
          turnText = 'El permiso fue rechazado.'
          sendTurn({ type: 'text', delta: turnText })
        }
        const ttft = firstToken ? firstToken - turnStart : -1
        console.log(`[jarvis-oc] turn done in ${Date.now() - turnStart}ms (first token ${ttft}ms, cost $${cost.toFixed(5)})`)
        sendTurn({ type: 'done', text: turnText, costUsd: cost })
        endTurn()
        break
      }
    }
  }

  const ask = async (text, id, mine, choice) => {
    if (mine !== generation || socket.readyState !== socket.OPEN) return
    answering = id
    turnText = ''
    cost = 0
    firstToken = 0
    lastTextPart = null
    turnStart = Date.now()
    busy = true
    submitted = false
    const controller = new AbortController()
    permissionRejected = false
    capturing = controller
    const stale = () => mine !== generation || socket.readyState !== socket.OPEN
    let preparingContext = true
    let selectingModel = true
    try {
      const selected = selectModel(await oc('GET', '/provider'), choice.model ?? MODEL, choice.variant ?? '')
      if (stale()) return
      selectingModel = false
      const removed = await clearPreviousMedia(oc, sessionID, { signal: controller.signal })
      if (stale()) return
      preparingContext = false
      console.log(`[jarvis-oc] previous media cleared: ${JSON.stringify(removed)}`)
      const profile = await readProfile()
      const visual = selected.image && AUTO_SCREEN && profile.configured ? await screenPrompt(text, {
        attach: (image, options) => media.then((files) => files.attach(image, options)),
        monitor: SCREEN_MONITOR,
        signal: controller.signal,
        onState: (state) => {
          if (!stale()) sendTurn({ type: 'screen', state })
        },
      }) : { parts: [{ type: 'text', text }], context: selected.image ? '' : 'El modelo elegido solo admite texto. No hay captura actual adjunta y no puede ver el monitor en este turno.' }
      if (stale()) return
      capturing = null
      submitted = true
      await oc('POST', `/session/${sessionID}/prompt_async`, {
        agent: AGENT,
        ...{ model: selected.model },
        ...(selected.variant ? { variant: selected.variant } : {}),
        parts: turnParts(visual, { now: turnStart, historyRoot: HISTORY_ROOT, profile }),
      })
    } catch (err) {
      if (stale()) return
      console.error('[jarvis-oc] prompt failed:', err.message)
      sendTurn({ type: 'error', message: selectingModel ? err.message : preparingContext
        ? 'No se pudieron retirar los adjuntos anteriores. La pregunta no se envió; inténtalo de nuevo.'
        : 'Me temo que OpenCode no aceptó la pregunta.' })
      endTurn()
    }
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'recording' && typeof msg.active === 'boolean') {
      void recorder.setActive(msg.active).catch((err) => { recorder.state.error = err.message })
        .finally(() => send({ type: 'recording', recording: recorder.snapshot() }))
      return
    }
    if (msg.type === 'permission' && typeof msg.id === 'string') {
      void permissions.respond(msg.id, msg.reply).catch(() => {
        send({ type: 'error', message: 'No se pudo responder al permiso. No se ha autorizado la operación.' })
      })
      return
    }
    if (msg.type === 'permission_mode') {
      policyRequestID = typeof msg.requestID === 'string' && msg.requestID.length <= 80 ? msg.requestID : undefined
      if (!sessionID || !handlers.has(sessionID) || !permissions.setMode(msg.mode, msg.confirmed)) {
        send({ type: 'permission_mode', requestID: policyRequestID, policy: { ...permissions.snapshot(), error: 'No se cambió el modo. Espera a la conexión y confirma el modo total si lo necesitas.' } })
      }
      policyRequestID = undefined
      return
    }
    if (msg.type === 'session_list') {
      void conversations.list().then((entries) => send({ type: 'session_list', entries }))
        .catch(() => send({ type: 'session_error', message: 'No se pudo leer la lista de chats.' }))
      return
    }
    if (msg.type === 'session_delete' && msg.id === sessionID) {
      if (busy) { send({ type: 'session_error', message: 'Termina o interrumpe la respuesta antes de borrar el chat.' }); return }
      closingSession = true
      void settling.then(async () => {
        await permissions.rejectAll()
        await conversations.remove(sessionID, owner)
        send({ type: 'session_deleted' })
        socket.close()
      }).catch(() => { closingSession = false; send({ type: 'session_error', message: 'No se pudo borrar el chat; no se confirmó el borrado.' }) })
      return
    }
    if (msg.type === 'ask' && typeof msg.text === 'string') {
      if (closingSession) { send({ type: 'error', ask: msg.id, message: 'Se está cerrando la conversación.' }); return }
      const id = typeof msg.id === 'string' ? msg.id : null
      const mine = ++generation
      capturing?.abort()
      void settling.then((ready) => ready !== false && sessionID && ask(msg.text, id, mine, { model: msg.model, variant: msg.variant }))
    }
    if (msg.type === 'interrupt') {
      generation++
      capturing?.abort()
      capturing = null
      void permissions.rejectAll()
      if (!busy) return
      if (!submitted) {
        endTurn()
        return
      }
      const stopped = new Promise((r) => (finishTurn = r))
      settling = oc('POST', `/session/${sessionID}/abort`)
        .catch(() => {})
        .then(() => Promise.race([stopped, new Promise((r) => setTimeout(r, SETTLE_CAP_MS))]))
        .then(() => endTurn())
    }
    // 'reply' (camera frames) has no tool to answer here; ignored.
  })

  socket.on('close', () => {
    console.log('[jarvis-oc] client disconnected')
    generation++
    capturing?.abort()
    permissions.setMode('manual')
    void permissions.rejectAll()
    void media.then((files) => files.close()).catch(() => {})
    if (!sessionID) return
    if (handlers.get(sessionID) === onEvent) handlers.delete(sessionID)
    void created.then(() => permissions.rejectAll()).then(() => conversations.release(sessionID, owner, () => clearPreviousMedia(oc, sessionID)))
      .catch((err) => console.error('[jarvis-oc] saved chat cleanup:', err.message))
  })
})

void pumpEvents()
const recordingUpdates = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: 'recording', recording: recorder.snapshot() }))
  }
}, 2000)
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(recordingUpdates)
  clearInterval(recorder.maintenance)
  void recorder.setActive(false).finally(() => process.exit(0))
})
server.listen(PORT, process.env.JARVIS_BRIDGE_HOST ?? '127.0.0.1')
console.log(`[jarvis-oc] bridge listening on ws://localhost:${PORT}`)
console.log(`[jarvis-oc] brain: opencode at ${OC}, agent ${AGENT}, model ${MODEL || '(config default)'}`)
console.log('[jarvis-oc] standard OpenCode: tool actions require visible one-use approval')
