import { EventEmitter } from 'node:events'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexRpc } from './codex-rpc.mjs'
import { Permissions } from './permissions.mjs'
import { screenPrompt } from './screen-context.mjs'
import { voiceAttachment } from './voice-attachment.mjs'

const directError = 'El modelo nativo de Codex no anuncia entrada de audio. Elige uno compatible o selecciona explícitamente Solo transcripción. No se envió el audio.'
const clientAudioError = 'El audio directo requiere Codex CLI 0.159.0 o posterior. No se envió el audio.'
const audioPrompt = 'Escucha los fragmentos de audio adjuntos de mi intervención en orden y responde a lo que digo. Los fragmentos conservados sin respuesta forman parte de la misma intervención.'
const continuationPrompt = 'He retomado el habla: este audio continúa o corrige mi petición anterior. Considera también los fragmentos anteriores y no completes una respuesta que haya quedado interrumpida.'
const busy = thread => thread?.status?.type === 'active'
const idKey = id => `${typeof id}:${id}`
const noopTiming = { start: () => ({ end() {} }) }
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)
const textItem = item => item.type === 'agentMessage' ? item.text || '' : item.type === 'userMessage'
  ? (item.content || []).map(part => part.type === 'text' ? part.text : part.type === 'image' || part.type === 'localImage' ? '[Imagen adjunta]' : part.type === 'audio' || part.type === 'localAudio' ? '[Audio adjunto]' : '').filter(Boolean).join('\n') : null

/** Installed protocol is authoritative: no instruction, approval or sandbox overrides. */
export class CodexRuntime extends EventEmitter {
  constructor(directory, rpc, { screen = screenPrompt, autoScreen = process.env.JARVIS_AUTO_SCREEN !== '0', stopTimeoutMs = 16000 } = {}) {
    super(); Object.assign(this, { directory, rpc, screen, autoScreen, stopTimeoutMs })
    this.runtimeId = randomUUID()
    this.threads = new Map(); this.requests = new Map(); this.opening = new Map()
    rpc.on('notification', message => this.notification(message))
    rpc.on('request', message => { void this.nativeRequest(message).catch(() => this.unsupported(message)) })
    rpc.on('closed', () => {
      for (const state of this.threads.values()) {
        this.publish(state, { type: 'status_error', message: 'Codex se desconectó. Comprueba el historial nativo antes de reintentar.' })
        if (state.op) this.finish(state, 'error')
      }
    })
  }
  async initialize() { try {
    const info = await this.rpc.start()
    const version = /\/(\d+)\.(\d+)\.(\d+)\b/.exec(info?.userAgent || '')
    this.directAudioSupported = !!version && (+version[1] > 0 || +version[2] >= 159)
    return this
  } catch (error) { await this.rpc.close(); throw error } }
  async pages(method, params = {}) {
    const rows = [], seen = new Set(); let cursor
    do {
      const result = await this.rpc.request(method, { ...params, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result?.data)) throw new Error('Codex devolvió una página inválida.')
      rows.push(...result.data); cursor = result.nextCursor
      if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('Codex devolvió un cursor repetido o inválido.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return rows
  }
  async verify() {
    const account = await this.rpc.request('account/read', { refreshToken: false })
    if (account?.requiresOpenaiAuth && !account?.account) throw new Error('Codex requiere iniciar sesión. Ejecuta codex login en tu terminal y vuelve a abrir el proyecto.')
    const result = await this.rpc.request('config/read', { cwd: this.directory, includeLayers: false })
    return { application: 'codex', directory: this.directory, authenticated: !!account?.account,
      requiresOpenaiAuth: account?.requiresOpenaiAuth === true,
      authType: ['apiKey', 'chatgpt', 'amazonBedrock'].includes(account?.account?.type) ? account.account.type : null,
      model: typeof result?.config?.model === 'string' ? result.config.model : null }
  }
  async rawModels() { return this.pages('model/list', { limit: 100, includeHidden: false }) }
  async models() {
    return (await this.rawModels()).filter(m => typeof m.model === 'string' && !m.hidden).map(m => ({
      id: m.model, name: m.displayName || m.model, provider: 'Codex', free: false, cost: { input: null, output: null },
      image: m.inputModalities?.includes('image') === true, audio: this.directAudioSupported && m.inputModalities?.includes('audio') === true,
      audioReason: !this.directAudioSupported ? clientAudioError : m.inputModalities?.includes('audio') ? '' : directError,
      variants: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(e => typeof e === 'string'),
      defaultVariant: m.defaultReasoningEffort || '',
    }))
  }
  async checked(threadId) {
    if (!safeId(threadId)) throw new Error('Identificador de conversación de Codex inválido.')
    const { thread } = await this.rpc.request('thread/read', { threadId })
    if (thread?.id !== threadId || !isAbsolute(thread.cwd || '') || await realpath(thread.cwd).catch(() => '') !== this.directory || thread.parentThreadId) {
      throw new Error('La conversación de Codex no pertenece a esta carpeta o es un subagente.')
    }
    return thread
  }
  async list() {
    const rows = await this.pages('thread/list', { cwd: this.directory, archived: false, limit: 100, sortKey: 'updated_at' })
    return rows.filter(t => t.cwd === this.directory && !t.parentThreadId && !t.ephemeral && !t.archived).map(t => ({
      id: t.id, title: t.name || t.preview || 'Conversación de Codex', updatedAt: (t.updatedAt || t.createdAt || 0) * 1000,
      busy: busy(t) || !!this.threads.get(t.id)?.liveTurn || !!this.threads.get(t.id)?.op,
    }))
  }
  state(thread, native = {}) {
    let state = this.threads.get(thread.id)
    if (state) { state.model = native.model || thread.model || state.model; state.active = busy(thread); state.title = thread.name || thread.preview || state.title; return state }
    state = { id: thread.id, title: thread.name || thread.preview || 'Conversación de Codex', model: native.model || thread.model,
      items: new Map(), listeners: new Set(), liveTurn: null, active: busy(thread), op: null, deferred: [], ordinary: new Map(),
      ephemeral: thread.ephemeral === true, historyAvailable: true, nativeLoaded: false, interruptions: 0, audioUncertain: false }
    state.policy = new Permissions({ session: () => state.id, workspace: this.directory,
      reply: (id, decision) => this.answerApproval(state, id, decision),
      publish: () => this.publishPermissions(state), publishMode: policy => this.publish(state, { type: 'permission_mode', policy }) })
    this.threads.set(state.id, state)
    return state
  }
  async hydrate(state) {
    // New native threads have no rollout until their first user message. Ephemeral
    // threads never expose paginated history; retain their process-local stream.
    if (!state.historyAvailable || state.ephemeral) return this.transcript(state)
    // Native cursors may repeat anchors. Stable item IDs reconcile stream/history.
    const before = new Map(state.items)
    const turns = await this.pages('thread/turns/list', { threadId: state.id, limit: 100, sortDirection: 'asc', itemsView: 'full' })
    const previous = state.items
    const history = new Map()
    for (const turn of turns) {
      const items = turn.itemsView && turn.itemsView !== 'full'
        ? (await this.pages('thread/items/list', { threadId: state.id, turnId: turn.id, limit: 100, sortDirection: 'asc' })).map(entry => entry.item)
        : turn.items || []
      for (const item of items) {
        if (!item) continue
        const text = textItem(item)
        if (text !== null) history.set(item.id, { id: state.id + ':' + item.id, role: item.type === 'userMessage' ? 'user' : 'jarvis', text })
      }
    }
    // Overlay live items while retaining native chronological order.
    for (const [id, item] of previous) if (before.get(id) !== item || !history.has(id)) history.set(id, item)
    state.items = history
    return this.transcript(state)
  }
  async open(choice) {
    if (choice === 'new') return this.openThread(choice)
    // An absent selection is the initial view, including reconnects before ready.
    // Coalesce that request without changing the meaning of explicit "new".
    const key = choice ? `thread:${choice}` : 'default'
    if (!this.opening.has(key)) {
      const pending = this.openThread(choice || this.defaultThreadId || 'new').then(state => {
        if (!choice) this.defaultThreadId = state.id
        return state
      }).finally(() => { if (this.opening.get(key) === pending) this.opening.delete(key) })
      this.opening.set(key, pending)
    }
    return this.opening.get(key)
  }
  async openThread(choice) {
    let result
    const fresh = choice === 'new'
    if (fresh) result = await this.rpc.request('thread/start', { cwd: this.directory, ephemeral: false })
    else {
      const thread = await this.checked(choice)
      const loaded = this.threads.get(choice)
      if (loaded?.nativeLoaded) {
        const state = this.state(thread)
        await this.hydrate(state)
        return state
      }
      result = await this.rpc.request('thread/resume', { threadId: choice, excludeTurns: true })
    }
    const thread = result?.thread
    if (!safeId(thread?.id) || (!fresh && thread.id !== choice) || !isAbsolute(thread.cwd || '') || await realpath(thread.cwd).catch(() => '') !== this.directory || thread.parentThreadId) throw new Error('Codex abrió una conversación fuera de esta carpeta.')
    const state = this.state(thread, result)
    state.nativeLoaded = true
    if (fresh) state.historyAvailable = false
    await this.hydrate(state)
    return state
  }
  async archive(state) {
    const thread = await this.checked(state.id)
    if (busy(thread) || state.liveTurn || state.op || state.policy.pending.size || state.ordinary.size) throw new Error('La conversación está trabajando; no se archivó.')
    await this.rpc.request('thread/archive', { threadId: state.id })
    state.nativeLoaded = false
    if (this.defaultThreadId === state.id) this.defaultThreadId = null
  }
  put(state, item) {
    if (typeof item?.id !== 'string') return
    const text = textItem(item)
    if (text === null) return
    state.items.set(item.id, { id: `${state.id}:${item.id}`, role: item.type === 'userMessage' ? 'user' : 'jarvis', text })
  }
  transcript(state) { return [...state.items.values()] }
  snapshot(state) { return { type: 'session_update', turns: this.transcript(state), busy: !!state.op || !!state.liveTurn || state.active } }
  publish(state, frame) { for (const listener of [...state.listeners]) { try { listener(frame) } catch { /* Detached UI cannot affect native execution. */ } } }
  update(state) { this.publish(state, this.snapshot(state)) }
  subscribe(state, listener) {
    state.listeners.add(listener)
    state.policy.setMode('manual')
    return () => { state.listeners.delete(listener); state.policy.setMode('manual') }
  }
  publishPermissions(state) { this.publish(state, { type: 'permissions', requests: [...state.policy.pending.values(), ...state.ordinary.values()] }) }
  // UI capabilities must not survive a project switch or a restarted native process.
  requestKey(threadId, rpcId) { return `codex:${this.runtimeId}:${threadId}:${idKey(rpcId)}` }
  async nativeRequest(message) {
    const p = message.params || {}
    const state = this.threads.get(p.threadId)
    if (!state) { this.unsupported(message); return }
    if (message.method === 'mcpServer/elicitation/request') {
      this.rpc.respond(message.id, { action: 'decline', content: null, _meta: null })
      this.publish(state, { type: 'status_error', message: 'Se rechazó una solicitud de información MCP que este cliente aún no presenta. Usa el cliente nativo para ese flujo.' })
      return
    }
    if (!safeId(p.turnId) || !safeId(p.itemId) || (state.liveTurn && p.turnId !== state.liveTurn)) { this.unsupported(message); return }
    const id = this.requestKey(p.threadId, message.id)
    if (this.requests.has(id)) return
    const entry = { id: message.id, method: message.method, threadId: p.threadId, turnId: p.turnId }
    this.requests.set(id, entry)
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      const command = message.method.includes('commandExecution')
      await state.policy.receive({ id, sessionID: state.id, permission: command ? 'bash' : 'edit',
        patterns: command && p.command ? [p.command] : [], metadata: command ? { command: p.command || '', cwd: p.cwd || '', reason: p.reason || '' }
          : { reason: p.reason || '', changes: p.itemId && state.nativeChanges?.get(p.itemId) || [] } })
    } else if (message.method === 'item/tool/requestUserInput') {
      state.ordinary.set(id, { id, permission: 'user_input', patterns: [], metadata: { questions: p.questions || [], message: p.message || '' } })
      this.publishPermissions(state)
      entry.questions = p.questions
    } else { this.requests.delete(id); this.unsupported(message) }
  }
  unsupported(message) {
    try { this.rpc.reject(message.id) } catch { /* A lost connection already has a visible recovery event. */ }
    const frame = { type: 'status_error', message: 'Codex pidió una operación que este cliente no admite. Usa el cliente nativo o detén el turno.' }
    for (const state of this.threads.values()) this.publish(state, frame)
  }
  async answerApproval(state, id, decision) {
    const request = this.requests.get(id)
    if (!request || request.threadId !== state.id || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) throw new Error('Autorización nativa vencida o de otra conversación.')
    this.rpc.respond(request.id, { decision: decision === 'once' ? 'accept' : 'decline' })
    this.requests.delete(id)
  }
  answerInput(state, id, answers) {
    const request = this.requests.get(id)
    if (!request || request.threadId !== state.id || request.method !== 'item/tool/requestUserInput' || !answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Entrada nativa inválida o vencida.')
    const questions = new Set((request.questions || []).map(q => q.id))
    const valid = Object.entries(answers).every(([key, value]) => questions.has(key) && Array.isArray(value?.answers) && value.answers.length > 0 && value.answers.length <= 20 && value.answers.every(v => typeof v === 'string' && v.length <= 16000))
    if (!valid) throw new Error('Las respuestas no corresponden a las preguntas de Codex.')
    this.rpc.respond(request.id, { answers }); this.requests.delete(id); state.ordinary.delete(id); this.publishPermissions(state)
  }
  notification({ method, params: p = {} }) {
    const state = this.threads.get(p.threadId || p.thread?.id)
    if (!state) return
    if (method === 'serverRequest/resolved') {
      const id = this.requestKey(p.threadId, p.requestId)
      this.requests.delete(id); state.policy.resolved(id); state.ordinary.delete(id); this.publishPermissions(state); return
    }
    if (state.op?.starting && p.turnId && !state.op.turnId) { state.deferred.push({ method, params: p }); return }
    if (state.op?.starting && p.turn?.id && !state.op.turnId) { state.deferred.push({ method, params: p }); return }
    const turnId = p.turnId || p.turn?.id
    if (turnId && state.liveTurn && turnId !== state.liveTurn) return
    if (method === 'turn/started') { state.historyAvailable = true; state.liveTurn = p.turn.id; state.active = true; this.update(state); return }
    if (method === 'thread/status/changed') { state.active = busy({ status: p.status }); this.update(state); return }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item
      this.put(state, item || {})
      if (item?.type === 'fileChange') { state.nativeChanges ??= new Map(); state.nativeChanges.set(item.id, item.changes) }
      if (state.op?.turnId === turnId && item?.type === 'agentMessage') this.agentText(state, item.id, item.text || '', false)
      if (state.op?.turnId === turnId && ['commandExecution','mcpToolCall','fileChange','webSearch','dynamicToolCall'].includes(item?.type) && !state.op.tools.has(item.id)) {
        state.op.tools.add(item.id); this.publish(state, { type: 'tool', ask: state.op.ask, name: item.tool || item.type })
      }
      this.update(state)
    } else if (method === 'item/agentMessage/delta') {
      if (state.op?.turnId !== turnId) return
      this.agentText(state, p.itemId, p.delta || '', true); this.update(state)
    } else if (method === 'turn/completed') {
      if (state.op?.turnId === turnId) {
        for (const item of p.turn.items || []) { this.put(state, item); if (item.type === 'agentMessage') this.agentText(state, item.id, item.text || '', false) }
        this.finish(state, p.turn.status === 'completed' ? 'ok' : p.turn.status === 'interrupted' ? 'cancelled' : 'error')
      }
      state.liveTurn = null; state.active = false
      for (const [id, request] of this.requests) if (request.threadId === state.id && request.turnId === turnId) { this.requests.delete(id); state.policy.resolved(id); state.ordinary.delete(id) }
      this.publishPermissions(state); this.update(state)
    } else if (method === 'error' && !p.willRetry) this.publish(state, { type: 'status_error', message: 'Codex informó un error en el turno. Comprueba su estado nativo.' })
  }
  agentText(state, id, value, append) {
    const op = state.op
    const previous = op.messages.get(id) || ''
    op.messages.set(id, append ? previous + value : value)
    const combined = [...op.messages.values()].join('\n')
    if (combined.startsWith(op.text) && combined.length > op.text.length) { op.first.end(); this.publish(state, { type: 'text', ask: op.ask, delta: combined.slice(op.text.length) }) }
    op.text = combined
    this.put(state, { type: 'agentMessage', id, text: op.messages.get(id) })
  }
  finish(state, status) {
    const op = state.op
    if (!op) return
    op.first?.end(status === 'ok' && !op.text ? 'cancelled' : status); op.response?.end(status)
    if (status === 'error') this.publish(state, { type: 'error', ask: op.ask, message: 'Codex no completó el turno. Comprueba su historial nativo antes de reintentar.' })
    this.publish(state, { type: 'done', ask: op.ask, text: op.text, status })
    state.op = null; op.resolveCompletion?.(); this.update(state)
  }
  async ask(state, message, timing = noopTiming) {
    const direct = message.audioMode === 'direct'
    if (message.preserveOnly && !direct || message.audio && !direct && message.audioMode !== 'transcript') throw new Error('El clip requiere el modo Audio directo explícito. No se envió el audio.')
    if (direct && !message.audio) throw new Error('Falta el clip de audio directo; no se enviará dictado como sustituto.')
    if (direct && !this.directAudioSupported) throw new Error(clientAudioError)
    if (state.audioUncertain && direct) throw new Error('No se confirmó la conservación del audio anterior. Envía un mensaje escrito para continuar sin reenviar el clip, o abre otro chat.')
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 200000) throw new Error('Escribe un mensaje válido para Codex.')
    if (state.op || state.liveTurn) throw new Error('Codex está trabajando; espera o usa Detener respuesta.')
    const op = { ask: message.id, starting: true, messages: new Map(), text: '', tools: new Set(), controller: new AbortController(), direct, preserveOnly: direct && message.preserveOnly === true }
    op.prepared = new Promise(resolve => { op.resolvePrepared = resolve })
    op.completed = new Promise(resolve => { op.resolveCompletion = resolve })
    state.op = op
    const prepare = timing.start('bridge.prepare', message.traceId)
    try {
      const thread = await this.checked(state.id)
      if (busy(thread)) throw new Error('Codex trabaja en esta conversación desde otro cliente. Espera o detenla explícitamente.')
      const recoveringAudio = state.audioUncertain && !direct
      if (recoveringAudio) {
        // Public history does not expose injected raw items. Verify ownership,
        // idle state and readable history; never claim the uncertain clip is absent
        // or replay it. An explicitly chosen text message is the recovery action.
        await this.hydrate(state)
        this.publish(state, { type: 'status_error', message: 'El recibo del audio anterior sigue sin confirmar. Se continuará con tu nuevo texto, sin reenviar ese clip.' })
      }
      const models = await this.rawModels()
      const explicit = message.model && message.model !== 'native/default'
      const selected = models.find(m => m.model === (explicit ? message.model : thread.model || state.model))
      if (explicit && !selected) throw new Error('El modelo elegido no está en el catálogo nativo de Codex.')
      if (message.variant && (!explicit || !selected?.supportedReasoningEfforts?.some(e => e.reasoningEffort === message.variant))) throw new Error('El nivel de pensamiento no corresponde al modelo elegido.')
      if (direct && !selected?.inputModalities?.includes('audio')) throw new Error(directError)
      const interruption = state.interruptions
      let text = direct ? audioPrompt + (interruption ? '\n\n' + continuationPrompt : '') : message.text
      let input = [{ type: 'text', text, text_elements: [] }]
      if (direct) {
        // Native append-only history, NOT a generated-and-immediately-aborted turn.
        // The data URI is durable in Codex's rollout, never a temporary pathname.
        const audio = voiceAttachment(message.audio)
        if (op.stopping) throw new Error('Se canceló la preparación del turno.')
        const id = 'mi_asistente_audio_' + randomUUID()
        op.appending = true
        try {
          await this.rpc.request('thread/inject_items', { threadId: state.id, items: [{ type: 'message', id, role: 'user',
            content: [{ type: 'input_text', text: '[Audio directo adjunto]' }, { type: 'input_audio', audio_url: audio.url }] }] })
        } catch {
          state.audioUncertain = true
          throw new Error('Codex no confirmó la conservación del clip. Comprueba el historial nativo antes de reintentar; no se reenvió ni se sustituyó por texto.')
        }
        op.audioStored = true; state.historyAvailable = true
        this.put(state, { type: 'userMessage', id, content: [{ type: 'audio' }] })
        this.publish(state, { type: 'audio', ask: op.ask, state: 'attached', message: 'Audio conservado en el hilo nativo de Codex, sin transcripción previa.' })
        if (op.preserveOnly || op.stopping) {
          prepare.end(); this.update(state); this.finish(state, 'cancelled'); return
        }
        // Re-read interruption state after persistence: speech may have resumed
        // while the native append was pending. Such a prefix must not generate.
        text = '[Audio adjunto]\n' + audioPrompt + (state.interruptions ? '\n\n' + continuationPrompt : '')
        input = [{ type: 'text', text, text_elements: [] }]
      }
      if (message.screen === true && !selected?.inputModalities?.includes('image')) this.publish(state, { type: 'screen', ask: op.ask, state: 'unsupported', message: 'El modelo seleccionado no admite imágenes; no se adjuntó una captura.' })
      if ((typeof message.screen === 'boolean' ? message.screen : this.autoScreen) && selected?.inputModalities?.includes('image')) {
        const visual = await this.screen(text, { signal: op.controller.signal, onState: status => this.publish(state, { type: 'screen', ask: op.ask, state: status }) })
        input = [{ type: 'text', text: text + (visual.context ? '\n\n' + visual.context : ''), text_elements: [] },
          ...visual.parts.filter(p => p.type === 'file').map(p => ({ type: 'image', url: p.url }))]
      }
      if (direct && op.preserveOnly) { prepare.end(); this.finish(state, 'cancelled'); return }
      if (op.stopping) throw new Error('Se canceló la preparación del turno.')
      op.first = timing.start('bridge.first_text', message.traceId); op.response = timing.start('bridge.response', message.traceId)
      const result = await this.rpc.request('turn/start', { threadId: state.id, input, clientUserMessageId: randomUUID(),
        ...(explicit ? { model: selected.model, ...(message.variant ? { effort: message.variant } : {}) } : {}) })
      if (!safeId(result?.turn?.id)) throw new Error('Codex no confirmó el identificador del turno. Comprueba el historial antes de reintentar.')
      state.historyAvailable = true
      if (recoveringAudio) state.audioUncertain = false
      if (direct && state.interruptions === interruption) state.interruptions = 0
      op.turnId = result.turn.id; op.starting = false; state.liveTurn = op.turnId; state.active = true
      prepare.end(); this.publish(state, { type: 'submitted', ask: op.ask })
      const deferred = state.deferred.splice(0)
      for (const event of deferred) this.notification(event)
      this.update(state)
    } catch (error) {
      op.prepareError = error
      prepare.end(op.stopping ? 'cancelled' : 'error')
      if (state.op === op) {
        if (op.stopping && !state.audioUncertain) this.finish(state, 'cancelled')
        else {
          op.first?.end('error'); op.response?.end('error')
          state.op = null; op.resolveCompletion(); this.update(state)
        }
      }
      if (!op.stopping || state.audioUncertain) throw error
    } finally { op.resolvePrepared() }
  }
  async interrupt(state, timing = noopTiming, reason = 'manual') {
    const span = timing.start('bridge.interrupt')
    const op = state.op
    if (reason === 'speech') state.interruptions++
    if (op?.starting) {
      if (op.direct && reason === 'speech') op.preserveOnly = true
      else { op.stopping = true; op.controller.abort() }
      await op.prepared
      if (op.direct && op.prepareError && (!op.stopping || state.audioUncertain)) { span.end('error'); throw op.prepareError }
    }
    try {
      let turnId = state.liveTurn
      if (!turnId) {
        const thread = await this.checked(state.id)
        if (!busy(thread)) { span.end(); return }
        const turns = await this.pages('thread/turns/list', { threadId: state.id, itemsView: 'notLoaded', sortDirection: 'desc', limit: 100 })
        turnId = turns.find(t => t.status === 'inProgress')?.id
      }
      if (!turnId) throw new Error('No se pudo identificar el turno activo de Codex.')
      let cleanup = () => {}
      const completed = new Promise(resolve => {
        const onEvent = message => { if (message.method === 'turn/completed' && message.params?.threadId === state.id && message.params?.turn?.id === turnId) { cleanup(); resolve(true) } }
        const onClosed = () => { cleanup(); resolve(false) }
        const timer = setTimeout(() => { cleanup(); resolve(false) }, this.stopTimeoutMs)
        cleanup = () => { clearTimeout(timer); this.rpc.off('notification', onEvent); this.rpc.off('closed', onClosed) }
        this.rpc.on('notification', onEvent); this.rpc.once('closed', onClosed)
      })
      try {
        await this.rpc.request('turn/interrupt', { threadId: state.id, turnId })
        if (await completed === false) throw new Error('Codex no confirmó la detención. Comprueba el turno nativo antes de continuar.')
      } finally { cleanup() }
      span.end()
    } catch (error) { span.end('error'); throw error }
  }
}

export class CodexManager {
  constructor({ transportFactory, rpc = {}, ...runtimeOptions } = {}) {
    this.transportFactory = transportFactory || (directory => new CodexRpc({ ...rpc, cwd: directory }))
    this.options = runtimeOptions; this.cache = new Map(); this.closed = false
  }
  async runtime(directory) {
    if (this.closed || typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new Error('Carpeta de Codex inválida o gestor cerrado.')
    const canonical = await realpath(directory)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Codex requiere una carpeta local.')
    if (!this.cache.has(canonical)) {
      const rpc = this.transportFactory(canonical)
      const promise = new CodexRuntime(canonical, rpc, this.options).initialize()
      this.cache.set(canonical, promise)
      rpc.once('closed', () => { if (this.cache.get(canonical) === promise) this.cache.delete(canonical) })
      void promise.catch(() => { if (this.cache.get(canonical) === promise) this.cache.delete(canonical) })
    }
    return this.cache.get(canonical)
  }
  async verify(directory) { return (await this.runtime(directory)).verify() }
  async models(directory) { return (await this.runtime(directory)).models() }
  async close() { this.closed = true; const rows = await Promise.allSettled([...this.cache.values()]); await Promise.all(rows.filter(r => r.status === 'fulfilled').map(r => r.value.rpc.close())); this.cache.clear() }
}
