import { currentModelSelection } from './models'
import { currentVoiceInputMode, reportVoiceInput } from './voice-input-mode'
import type { AskHandlers } from './anthropic'
import { useStore, type Blade, type Panel, type PermissionRequest } from '../store'
import { BRIDGE_WS_URL } from '../config'
import { selectedProject, subscribeProjects } from './projects'
import { startTiming, newTrace, receiveTiming } from './timings'
import type { TimingStatus } from './timings'
import { captureDiagnostics } from './utterance-audio'

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * OpenCode advertises a persistent conversation on ready; reconnect restores
 * its ID and visible text. Legacy Claude bridges still tie memory to the socket.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  event?: unknown
  status?: TimingStatus
  requestID?: string
  policy?: { mode: PermissionMode; autoApproved: number; error?: string }
  conversation?: Conversation
  entries?: ConversationEntry[]
  requests?: PermissionRequest[]
  recording?: NonNullable<ReturnType<typeof useStore.getState>['recording']>
  state?: string
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  ask?: string
  turns?: ReturnType<typeof useStore.getState>['turns']
  busy?: boolean
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null
let connectionEpoch = 0
let destinationRevision = 0
const recordingVersions = new WeakMap<WebSocket, number>()
const connectionTimings = new WeakMap<WebSocket, ReturnType<typeof startTiming>>()
let stopSequence = 0
const stops = new WeakMap<WebSocket, { id: string; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function settleStop(ws: WebSocket, error?: Error) {
  const stop = stops.get(ws)
  if (!stop) return
  stops.delete(ws); clearTimeout(stop.timer)
  if (error) stop.reject(error); else stop.resolve()
}
const CHAT_KEY = 'jarvis.opencode.conversation'
const chatKey = () => selectedProject() ? `${CHAT_KEY}:${selectedProject()!.id}` : CHAT_KEY
let requestedConversation: string | null = null
let manualSwitch = false
export type ConversationEntry = { id: string; title: string; updatedAt: number; busy: boolean }
export type Conversation = { id: string; title: string; resumed: boolean; turns: ReturnType<typeof useStore.getState>['turns']; entries: ConversationEntry[]; busy?: boolean }
let conversation: Conversation | null = null
let conversationView: { chat: Conversation | null; error: string } = { chat: null, error: '' }
const conversationListeners = new Set<() => void>()
export type PermissionMode = 'manual' | 'limited' | 'total'
let policy = { mode: 'manual' as PermissionMode, autoApproved: 0, connected: false, pending: false, error: '' }
const policyListeners = new Set<() => void>()
let policyTimer: ReturnType<typeof setTimeout> | undefined
let policyRequestID: string | null = null
let policySequence = 0
export const permissionModeSnapshot = () => policy
export function subscribePermissionMode(fn: () => void) { policyListeners.add(fn); return () => { policyListeners.delete(fn) } }
function publishPolicy(patch: Partial<typeof policy>, settle = true) {
  if (settle) clearTimeout(policyTimer)
  policy = { ...policy, ...patch }
  policyListeners.forEach(fn => fn())
}
export function setPermissionMode(mode: PermissionMode, confirmed = false) {
  if (!policy.connected || socket?.readyState !== WebSocket.OPEN) throw new Error('Sin conexión; no se cambió el modo de permisos.')
  if (mode === 'total' && !confirmed) throw new Error('Debes confirmar el riesgo del modo total.')
  const ws = socket
  policyRequestID = `policy-${++policySequence}`
  publishPolicy({ pending: true, error: '' })
  ws.send(JSON.stringify({ type: 'permission_mode', mode, confirmed, requestID: policyRequestID }))
  policyTimer = setTimeout(() => {
    policyRequestID = null
    // Never leave an unknown escalation running behind a stale Manual badge.
    if (socket === ws) ws.close()
    publishPolicy({ mode: 'manual', connected: false, pending: false, error: 'No se confirmó el cambio; se cerró la conexión para restablecer Manual.' })
  }, 5000)
}
export function conversationSnapshot() { return conversationView }
/** Changes only when the user switches projects/chats, including while a chat is opening. */
export function conversationRevision() { return destinationRevision }
export function subscribeConversation(fn: () => void) {
  conversationListeners.add(fn)
  return () => { conversationListeners.delete(fn) }
}
function publishConversation(error = '') {
  conversationView = { chat: conversation, error }
  for (const fn of conversationListeners) fn()
}
export function refreshConversations() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'session_list' }))
}
export async function chooseConversation(id: string = 'new') {
  if (pending && !pending.direct && !selectedProject()) throw new Error('Termina o interrumpe la respuesta antes de cambiar de chat.')
  detachDirectClips()
  pending?.finish(undefined, 'detached')
  destinationRevision++
  useStore.setState({ autoScreen: false, screenCapture: 'off', recording: null })
  if (socket) recordingVersions.delete(socket)
  conversation = null; publishConversation()
  requestedConversation = id
  manualSwitch = true
  connectionEpoch++; connecting = null
  clearTimeout(reconnectTimer)
  const old = socket
  if (old && old.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      old.addEventListener('close', () => resolve(), { once: true })
      old.close()
    })
  }
  manualSwitch = false
  attempt = 0
  await warmBridge()
}
export function deleteConversation() {
  if (!conversation || pending || directClips.size || socket?.readyState !== WebSocket.OPEN) throw new Error('El chat debe estar conectado y sin respuesta pendiente.')
  publishConversation()
  socket.send(JSON.stringify({ type: 'session_delete', id: conversation.id }))
}

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

let onRecording: ((state: NonNullable<Frame['recording']>) => void) | null = null
export function watchRecording(fn: NonNullable<typeof onRecording>) { onRecording = fn }
let onPermissions: ((requests: PermissionRequest[]) => void) | null = null
export function watchPermissions(fn: NonNullable<typeof onPermissions>) { onPermissions = fn }
let permissionIDs = new Set<string>()
const nativeReplies = new Map<string, { ws: WebSocket; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function settleNativeReply(id: string, error?: Error) {
  const pending = nativeReplies.get(id)
  if (!pending) return
  clearTimeout(pending.timer); nativeReplies.delete(id)
  if (error) pending.reject(error); else pending.resolve()
}
function sendNativeReply(id: string, payload: Record<string, unknown>): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Conexión perdida; respuesta no enviada.'))
  if (!permissionIDs.has(id)) return Promise.reject(new Error('La solicitud venció o pertenece a otra conversación.'))
  if (nativeReplies.has(id)) return Promise.reject(new Error('Esta respuesta ya se está enviando.'))
  const ws = socket
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settleNativeReply(id, new Error('No se confirmó la respuesta. Comprueba la solicitud antes de reintentar.')), 10000)
    nativeReplies.set(id, { ws, resolve, reject, timer })
    try { ws.send(JSON.stringify({ ...payload, id })) }
    catch { settleNativeReply(id, new Error('No se pudo enviar la respuesta.')) }
  })
}
export function replyPermission(id: string, reply: 'once' | 'reject') {
  return sendNativeReply(id, { type: 'permission', reply })
}
export function replyUserInput(id: string, answers: Record<string, { answers: string[] }>) {
  return sendNativeReply(id, { type: 'user_input', answers })
}
let recordingSequence = 0
const recordingRequests = new Map<string, { ws: WebSocket; active: boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function settleRecording(id: string, error?: Error) {
  const request = recordingRequests.get(id)
  if (!request) return
  clearTimeout(request.timer); recordingRequests.delete(id)
  if (error) request.reject(error); else request.resolve()
}
export async function setRecordingActive(active: boolean) {
  const ws = await connect()
  if (active && recordingVersions.get(ws) !== 1) throw new Error('Reinicia el puente para activar el historial con controles de privacidad compatibles. No se inició la grabación.')
  const microphone = !useStore.getState().microphoneMuted
  const requestID = 'recording-' + ++recordingSequence
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settleRecording(requestID, new Error('No se confirmó el cambio del historial. Comprueba la conexión y reintenta.')), 10000)
    recordingRequests.set(requestID, { ws, active, resolve, reject, timer })
    try { ws.send(JSON.stringify({ type: 'recording', active, microphone, requestID })) }
    catch { settleRecording(requestID, new Error('No se pudo enviar el cambio del historial.')) }
  })
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — transport disconnected; OpenCode keeps its saved conversation.
 *   'reconnected' — transport is back; ready confirms the actual session loaded.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial. It gives up after the last delay rather
 *  than retrying forever — a bridge that has been down for half a minute is
 *  usually one you stopped on purpose, and the next ask() re-dials anyway. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 8000]
let attempt = 0
let reconnectTimer = 0

function scheduleReconnect() {
  if (attempt >= RECONNECT_DELAYS.length) return
  const delay = RECONNECT_DELAYS[attempt]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    void connect().catch(() => {})
  }, delay)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'interrupted' && stops.get(ws)?.id === msg.requestID) {
      settleStop(ws, msg.status === 'ok' ? undefined : new Error('La aplicación no confirmó la detención de la respuesta anterior.'))
    } else if (msg.type === 'session_error') {
      connectionTimings.get(ws)?.end('error')
      publishConversation(msg.message || 'No se pudo abrir la conversación.')
    } else if (msg.type === 'status_error') {
      const error = new Error(msg.message || 'La aplicación no pudo completar la operación.')
      if (msg.ask || msg.requestID) settleNativeReply((msg.ask || msg.requestID)!, error)
      if (msg.requestID) settleRecording(msg.requestID, error)
      useStore.getState().setError?.(error.message)
    } else if (msg.type === 'timing') {
      receiveTiming(msg.event)
    } else if (msg.type === 'session_list' && conversation && msg.entries) {
      conversation = { ...conversation, entries: msg.entries }
      publishConversation()
    } else if (msg.type === 'session_deleted') {
      requestedConversation = 'new'
      try { localStorage.removeItem(chatKey()) } catch { /* storage may be disabled */ }
      conversation = null
      useStore.setState({ turns: [], caption: '' })
      publishConversation()
    } else if (msg.type === 'permission_mode' && msg.policy && ['manual', 'limited', 'total'].includes(msg.policy.mode)) {
      const settled = !policyRequestID || msg.requestID === policyRequestID
      if (settled) policyRequestID = null
      publishPolicy({ mode: msg.policy.mode, autoApproved: msg.policy.autoApproved, connected: true,
        ...(settled ? { pending: false } : {}), error: msg.policy.error || '' }, settled)
    } else if (msg.type === 'permissions' && Array.isArray(msg.requests)) {
      permissionIDs = new Set(msg.requests.map(request => request.id))
      for (const [id, pending] of nativeReplies) if (pending.ws === ws && !permissionIDs.has(id)) settleNativeReply(id)
      onPermissions?.(msg.requests)
    } else if (msg.type === 'recording' && msg.recording) {
      recordingVersions.set(ws, msg.recording.controlVersion ?? 0)
      onRecording?.(msg.recording)
      if (!msg.requestID && msg.recording.controlVersion !== 1) {
        for (const [id, request] of recordingRequests) if (request.ws === ws) settleRecording(id, new Error('El puente necesita reiniciarse para confirmar cambios del historial.'))
      }
      if (msg.requestID) {
        const request = recordingRequests.get(msg.requestID)
        settleRecording(msg.requestID, request && (msg.recording.active !== request.active || request.active && msg.recording.error)
          ? new Error(msg.recording.error || 'El historial no confirmó el estado solicitado. Reintenta.') : undefined)
      }
    } else if (msg.type === 'session_update' && Array.isArray(msg.turns)) {
      useStore.setState({ turns: msg.turns })
      if (conversation) { conversation = { ...conversation, turns: msg.turns, busy: msg.busy === true }; publishConversation() }
    } else if (msg.type === 'project_required') {
      connectionTimings.get(ws)?.end()
      servers = []; firstReady.resolve()
    } else if (msg.type === 'ready') {
      connectionTimings.get(ws)?.end()
      if (msg.conversation) {
        conversation = msg.conversation
        requestedConversation = conversation.id
        try { localStorage.setItem(chatKey(), conversation.id) } catch { /* session still works without browser storage */ }
        useStore.setState({ turns: conversation.turns, caption: '', screenCapture: 'off', error: null })
        publishConversation()
      }
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
        })
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting
  const epoch = ++connectionEpoch
  const connectionSpan = startTiming('connection.ready')

  firstReady = deferred()

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const url = new URL(BRIDGE_WS_URL)
    url.searchParams.set('trace', connectionSpan.traceId)
    const projectID = selectedProject()?.id || ''
    if (projectID) url.searchParams.set('project', projectID)
    let stored: string | null = null
    try { stored = localStorage.getItem(chatKey()) } catch { /* storage may be disabled */ }
    const selected = requestedConversation || stored
    if (selected) url.searchParams.set('session', selected)
    const ws = new WebSocket(url)
    connectionTimings.set(ws, connectionSpan)
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (epoch === connectionEpoch) connecting = null
      if (err) { connectionSpan.end('error'); reject(err) }
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      if (epoch !== connectionEpoch || (selectedProject()?.id || '') !== projectID) { ws.close(); settle(new Error('El proyecto cambió.')); return }
      policyRequestID = null
      publishPolicy({ mode: 'manual', autoApproved: 0, connected: false, pending: false, error: '' })
      socket = ws
      permissionIDs = new Set()
      attempt = 0
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = () => {
      recordingVersions.delete(ws)
      for (const [id, request] of recordingRequests) if (request.ws === ws) settleRecording(id, new Error('Se perdió la conexión antes de confirmar el historial. Reintenta al conectar.'))
      for (const [id, pending] of nativeReplies) if (pending.ws === ws) settleNativeReply(id, new Error('La conexión cambió antes de confirmar tu respuesta.'))
      if (socket === ws) permissionIDs = new Set()
      settleStop(ws, new Error('La conexión cambió antes de confirmar la interrupción.'))
      connectionSpan.end('detached')
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        useStore.setState({ autoScreen: false, screenCapture: 'off', recording: null })
        policyRequestID = null
        publishPolicy({ mode: 'manual', autoApproved: 0, connected: false, pending: false, error: '' })
        socket = null
        onPermissions?.([])
        onConnection?.('lost')
        if (!manualSwitch) scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
type TurnResult = { text: string; tools: string[]; status?: TimingStatus }
type Selection = { model?: string; variant?: string }
type DirectClip = {
  scope: number; project: string; session: string | null
  audio: import('./utterance-audio').VoiceClip
  preserveOnly: boolean; sent: boolean; submittedPreserveOnly: boolean; discarded: boolean
  text: string; tools: string[]; uiDone: boolean
  resolve: (value: TurnResult) => void; reject: (error: unknown) => void
  aborted: Promise<void>; abandon: () => void; discardedStatus: TimingStatus
  selection?: Promise<{ value: Selection; error?: never } | { value?: never; error: unknown }>
  queued: ReturnType<typeof startTiming>
}
type PendingSlot = { finish: (fallback?: string, status?: TimingStatus) => void; fail?: (error: Error) => void; direct?: DirectClip }
let pending: PendingSlot | null = null
let directScope = 0
let directLane: Promise<void> = Promise.resolve()
const directClips = new Set<DirectClip>()
class DirectAbandoned extends Error {
  readonly status: TimingStatus
  constructor(status: TimingStatus) { super('El destino de este clip ya no está activo.'); this.status = status }
}
function validDirect(clip: DirectClip) {
  return !clip.discarded && clip.scope === directScope && clip.project === (selectedProject()?.id || '') &&
    (!clip.session || clip.session === 'new' || !conversation || conversation.id === clip.session)
}
function cancelDirectUI(clip: DirectClip, status: TimingStatus = 'cancelled') {
  if (clip.uiDone) return
  clip.uiDone = true
  clip.resolve({ text: clip.text.trim(), tools: [...clip.tools], status })
}
function discardDirect(clip: DirectClip, status: TimingStatus) {
  if (clip.discarded) return
  clip.discarded = true; clip.discardedStatus = status
  clip.queued.end(status)
  cancelDirectUI(clip, status)
  clip.abandon()
}
function detachDirectClips() {
  directScope++
  for (const clip of directClips) discardDirect(clip, 'detached')
}
async function waitDirect<T>(work: Promise<T>, clip?: DirectClip): Promise<T> {
  if (!clip) return work
  if (!validDirect(clip)) throw new DirectAbandoned(clip.discardedStatus)
  return Promise.race([work, clip.aborted.then(() => { throw new DirectAbandoned(clip.discardedStatus) })])
}
async function waitForStop(ws: WebSocket, traceId: string, clip?: DirectClip) {
  const stop = stops.get(ws)
  if (!stop) return
  const wait = startTiming('turn.interrupt_wait', traceId)
  try { await waitDirect(stop.promise, clip); wait.end() }
  catch (error) { wait.end(error instanceof DirectAbandoned ? error.status : 'error'); throw error }
}
/** A UI answer may be cancelled immediately; its captured audio still owns this
 * serial delivery lane until native persistence + the stop barrier are settled. */
export function ask(
  prompt: string, handlers: AskHandlers, audio?: import('./utterance-audio').VoiceClip,
  traceId: string = newTrace(),
  options?: { audioMode?: 'transcript' },
): Promise<TurnResult> {
  const audioMode = options?.audioMode || currentVoiceInputMode()
  if (selectedProject()?.application === 'codex' && (audio || audioMode !== 'transcript')) {
    return Promise.reject(new Error('Codex usa solo dictado del navegador. No se envió el clip ni se convirtió su subtítulo en un mensaje.'))
  }
  if (audioMode !== 'direct') {
    if (!directClips.size) return askTurn(prompt, handlers, audio, traceId, audioMode)
    const scope = directScope
    cancel('speech')
    return directLane.then(() => scope === directScope
      ? askTurn(prompt, handlers, audio, traceId, audioMode) : { text: '', tools: [], status: 'detached' as TimingStatus })
  }
  if (!audio) return Promise.reject(new Error('Falta el clip de audio directo; no se enviará dictado como sustituto.'))
  if (directClips.size || pending) cancel('speech')
  let resolve!: DirectClip['resolve'], reject!: DirectClip['reject'], abandon!: () => void
  const result = new Promise<TurnResult>((yes, no) => { resolve = yes; reject = no })
  const aborted = new Promise<void>(yes => { abandon = yes })
  let session = conversation?.id || requestedConversation
  if (!session) { try { session = localStorage.getItem(chatKey()) } catch { /* optional storage */ } }
  let selection: DirectClip['selection']
  if ((servers.includes('opencode') || servers.includes('codex'))) {
    // Invoke now, not when an older clip finally frees the lane. Cached model
    // choice is captured with this utterance rather than a later UI selection.
    try { selection = currentModelSelection().then(value => ({ value }), error => ({ error })) }
    catch (error) { selection = Promise.resolve({ error }) }
  }
  const clip: DirectClip = {
    scope: directScope, project: selectedProject()?.id || '', session,
    audio: { mime: audio.mime, data: audio.data }, preserveOnly: false, sent: false, submittedPreserveOnly: false,
    discarded: false, discardedStatus: 'detached', text: '', tools: [], uiDone: false,
    resolve, reject, aborted, abandon, selection, queued: startTiming('audio.queue', traceId),
  }
  directClips.add(clip)
  const audible = () => !clip.preserveOnly && !clip.discarded && !clip.uiDone
  const guarded: AskHandlers = {
    onSubmitted() { if (audible()) handlers.onSubmitted?.() },
    onText(delta) { if (audible()) { clip.text += delta; handlers.onText(delta) } },
    onTool(name) { if (audible()) { clip.tools.push(name); handlers.onTool(name) } },
    onAudio(state, message) { if (audible()) handlers.onAudio?.(state, message) },
    onScreen(state) { if (audible()) handlers.onScreen?.(state) },
  }
  const job = async () => {
    try {
      if (!validDirect(clip)) { discardDirect(clip, 'detached'); return }
      clip.queued.end()
      const value = await askTurn(prompt, guarded, clip.audio, traceId, audioMode, clip)
      if (!clip.uiDone) { clip.uiDone = true; clip.resolve(clip.preserveOnly ? { ...value, status: 'cancelled' } : value) }
    } catch (error) {
      if (!clip.uiDone) { clip.uiDone = true; clip.reject(error) }
      // An uncertain persistence/stop failure must be visible and must not let
      // newer clips overtake it. No automatic replay can duplicate native audio.
      for (const waiting of directClips) {
        if (waiting === clip || waiting.scope !== clip.scope) continue
        if (!waiting.uiDone) { waiting.uiDone = true; waiting.reject(error) }
        waiting.discarded = true; waiting.queued.end('error'); waiting.abandon()
      }
      reportVoiceInput('No se confirmó la entrega ordenada del audio. Comprueba la conversación antes de continuar.')
    } finally { directClips.delete(clip) }
  }
  directLane = directLane.then(job, job)
  return result
}

async function askTurn(
  prompt: string,
  handlers: AskHandlers,
  audio: import('./utterance-audio').VoiceClip | undefined,
  traceId: string,
  audioMode: ReturnType<typeof currentVoiceInputMode>,
  direct?: DirectClip,
): Promise<TurnResult> {
  reportVoiceInput(audioMode === 'direct' ? 'Preparando el clip para enviarlo a la aplicación…'
    : audioMode === 'transcript' ? 'Entrada por transcripción: no se envía audio.' : audio ? 'Preparando tu clip MP3…'
    : captureDiagnostics().status === 'overflow' ? 'La intervención supera el límite de 60 s: se envía el dictado completo en lugar de un audio recortado.'
      : 'No hay un clip completo verificable; se usa el texto del dictado.')
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) {
    if (direct) pending.finish(undefined, 'cancelled')
    else cancel()
  }

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  let slot: PendingSlot = {
    direct,
    finish: () => {
      cancelledWhileDialling = true
    },
  }
  pending = slot
  const releasePending = () => { if (pending === slot) pending = null }

  let ws: WebSocket
  const connectionWait = startTiming('turn.connection', traceId)
  try {
    ws = await waitDirect(connect(), direct)
    connectionWait.end()
    await waitForStop(ws, traceId, direct)
  } catch (err) {
    const failure = direct && !validDirect(direct) ? new DirectAbandoned(direct.discardedStatus) : err
    connectionWait.end(failure instanceof DirectAbandoned ? failure.status : 'error')
    releasePending()
    if (failure instanceof DirectAbandoned) return { text: '', tools: [], status: failure.status }
    throw failure
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    releasePending()
    return { text: '', tools: [], status: 'cancelled' }
  }

  let selection: Selection = {}
  const selectionSpan = startTiming('turn.selection', traceId)
  try {
    if (direct?.selection) {
      const chosen = await waitDirect(direct.selection, direct)
      if ('error' in chosen) throw chosen.error
      selection = chosen.value
    } else if ((servers.includes('opencode') || servers.includes('codex'))) selection = await waitDirect(currentModelSelection(), direct)
    await waitForStop(ws, traceId, direct)
    if (direct && !validDirect(direct)) throw new DirectAbandoned(direct.discardedStatus)
    selectionSpan.end()
  } catch (err) {
    const failure = direct && !validDirect(direct) ? new DirectAbandoned(direct.discardedStatus) : err
    selectionSpan.end(failure instanceof DirectAbandoned ? failure.status : 'error'); releasePending()
    if (failure instanceof DirectAbandoned) return { text: '', tools: [], status: failure.status }
    throw failure
  }
  if (cancelledWhileDialling) { releasePending(); return { text: '', tools: [], status: 'cancelled' } }
  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0
    const firstText = startTiming('turn.first_text', traceId)
    const firstActivity = startTiming('turn.first_activity', traceId)
    const responseSpan = startTiming('turn.response', traceId)

    const cleanup = () => {
      done = true
      releasePending()
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '', status: TimingStatus = 'ok') => {
      if (done) return
      firstText.end(text || fallback ? status : status === 'ok' ? 'cancelled' : status)
      firstActivity.end(status); responseSpan.end(status)
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools, status })
    }

    const fail = (err: Error, status: TimingStatus = 'error') => {
      if (done) return
      firstText.end(status); firstActivity.end(status); responseSpan.end(status)
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error('El servidor dejó de responder en este turno. Puedes intentarlo de nuevo.'), 'timeout')
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'submitted':
            firstActivity.end()
            handlers.onSubmitted?.()
            break
          case 'audio':
            firstActivity.end()
            if (msg.state === 'attached' || msg.state === 'unsupported' || msg.state === 'processing' || msg.state === 'interpreted' || msg.state === 'fallback') {
              if (msg.message && !direct?.preserveOnly) reportVoiceInput(msg.message)
              handlers.onAudio?.(msg.state, msg.message)
            }
            break
          case 'screen':
            firstActivity.end()
            if (msg.state === 'unsupported') {
              handlers.onScreen?.('failed')
              useStore.getState().setError?.(msg.message || 'El modelo seleccionado no admite imágenes.')
            }
            if (msg.state === 'capturing' || msg.state === 'attached' || msg.state === 'failed') {
              handlers.onScreen?.(msg.state)
            }
            break
          case 'text':
            if (msg.delta) { firstText.end(); firstActivity.end() }
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            firstActivity.end()
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          case 'done':
            finish(msg.text ?? '', msg.status === 'cancelled' ? 'cancelled' : 'ok')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('Se perdió la conexión durante la respuesta. El chat guardado se comprobará al reconectar.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    slot = { finish, fail, direct }; pending = slot
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      if (useStore.getState().autoScreen === true && recordingVersions.get(ws) !== 1) {
        throw new Error('Reinicia el puente y vuelve a activar Compartir pantalla. No se envió la pregunta sin su captura solicitada.')
      }
      if (servers.includes('codex') && (audio || audioMode !== 'transcript')) {
        throw new Error('Codex usa solo dictado del navegador. No se envió el clip ni su subtítulo.')
      }
      if (direct) {
        if (!validDirect(direct) || socket !== ws) { finish('', 'detached'); return }
        direct.sent = true; direct.submittedPreserveOnly = direct.preserveOnly
      }
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id, traceId, ...selection, audioMode, screen: useStore.getState().autoScreen === true,
        ...(direct?.preserveOnly ? { preserveOnly: true } : {}), ...(audio && audioMode !== 'transcript' ? { audio } : {}) }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
function requestStop(reason: 'speech' | 'manual') {
  if (socket?.readyState === WebSocket.OPEN) {
    const ws = socket
    if (!stops.has(ws)) {
      const id = `stop-${++stopSequence}`
      let resolve!: () => void, reject!: (error: Error) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      // A stop can finish without a replacement clip; keep failures observed.
      void promise.catch(() => {})
      const timer = setTimeout(() => settleStop(ws, new Error('La aplicación tardó demasiado en confirmar la detención.')), 16000)
      stops.set(ws, { id, promise, resolve, reject, timer })
      try { ws.send(JSON.stringify({ type: 'interrupt', reason, requestID: id })) }
      catch { settleStop(ws, new Error('No se pudo enviar la detención a la aplicación.')) }
    }
  }
  return socket ? stops.get(socket)?.promise : undefined
}
export function cancel(reason: 'speech' | 'manual' = 'manual'): void {
  const owner = pending
  if (reason === 'speech') {
    for (const clip of directClips) { clip.preserveOnly = true; cancelDirectUI(clip) }
    // Unsent clips continue preparing as noReply commits. An already submitted
    // noReply commit also needs no abort: the serial lane waits for its receipt.
    if (owner?.direct && (!owner.direct.sent || owner.direct.submittedPreserveOnly)) return
    if (!owner && directClips.size) return
  } else {
    for (const clip of directClips) discardDirect(clip, 'cancelled')
  }
  const stop = requestStop(reason)
  if (reason === 'speech' && owner?.direct) {
    // Keep the transport listener alive while the UI is already cancelled.
    // Backend stop ack confirms durable audio persistence, not just cancellation.
    void stop?.then(() => {
      if (pending === owner) owner.finish(undefined, 'cancelled')
    }, error => { if (pending === owner) owner.fail?.(error) })
  } else owner?.finish(undefined, 'cancelled')
}

/** The older name for `cancel()`. */
export function interrupt(reason: 'speech' | 'manual' = 'manual'): void {
  cancel(reason)
}

let activeProjectID = ''
subscribeProjects(() => {
  const id = selectedProject()?.id || ''
  if (id === activeProjectID) return
  activeProjectID = id
  destinationRevision++
  // Detach only: native work survives closing or switching this client.
  detachDirectClips()
  pending?.finish(undefined, 'detached')
  requestedConversation = null; conversation = null; publishConversation()
  useStore.setState({ turns: [], caption: '', permissions: [], screenCapture: 'off', autoScreen: false, recording: null })
  if (socket) recordingVersions.delete(socket)
  manualSwitch = true
  connectionEpoch++; connecting = null
  clearTimeout(reconnectTimer)
  const old = socket
  const reconnect = () => {
    manualSwitch = false
    if (id === activeProjectID) void warmBridge().catch(error => publishConversation(String(error)))
  }
  if (old && old.readyState !== WebSocket.CLOSED) { old.addEventListener('close', reconnect, { once: true }); old.close() }
  else reconnect()
})

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
