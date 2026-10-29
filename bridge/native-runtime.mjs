import { EventEmitter } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { Permissions } from './permissions.mjs'
import { screenPrompt } from './screen-context.mjs'
import { ClaudeDriver } from './claude-driver.mjs'
import { AntigravityDriver } from './antigravity-driver.mjs'

export const applicationNames = { claude: 'Claude Code', antigravity: 'Antigravity' }
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
const nativeText = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
class NativeRequestError extends Error {}
const noopTiming = { start: () => ({ end() {} }) }

/** Runtime ownership outlives sockets. Only the CLI/SDK owns generation and tools. */
export class NativeRuntime extends EventEmitter {
  constructor(directory, application, driver, { screen = screenPrompt, stateRoot = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'mi-asistente/native-views') } = {}) {
    super(); Object.assign(this, { directory, application, driver, screen })
    this.states = new Map(); this.runtimeId = randomUUID(); this.queue = Promise.resolve()
    this.file = join(stateRoot, createHash('sha256').update(application + '\0' + directory).digest('hex') + '.json')
    this.capabilities = { directAudio: false, transcriptOnly: true, archive: false, recoverableArchive: false, userInput: application === 'claude',
      screenOptIn: application === 'claude', recordingControlVersion: 1, nativePermissionUI: application === 'claude',
      historyScope: application === 'claude' ? 'native-project' : 'client-created' }
  }
  async verify() { await this.driver.verify(); return { application: this.application, directory: this.directory, authenticated: null } }
  async models() { return this.driver.models(this.directory) }
  async load() {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = this.loadOnce().finally(() => { this.loading = null })
    return this.loading
  }
  async loadOnce() {
    let data
    try { data = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw new Error('Historial local ilegible; no se sobrescribió.') }
    if (data && (data.directory !== this.directory || data.application !== this.application || !Array.isArray(data.sessions))) throw new Error('El historial pertenece a otro proyecto.')
    for (const row of data?.sessions || []) {
      if (!uuid(row.id) || row.nativeID && !uuid(row.nativeID) || !Array.isArray(row.turns)) throw new Error('Historial local inválido.')
      if (!this.states.has(row.id)) this.create(row)
    }
    this.loaded = true
  }
  persist() {
    const value = JSON.stringify({ directory: this.directory, application: this.application, sessions: [...this.states.values()].map(s => ({ id: s.id, nativeID: s.nativeID, title: s.title, updatedAt: s.updatedAt, turns: s.turns })) })
    const task = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.' + randomUUID() + '.part'
      await writeFile(temp, value, { mode: 0o600 }); await rename(temp, this.file)
    })
    this.queue = task; return task
  }
  create(row = {}) {
    const state = { id: row.id || randomUUID(), nativeID: row.nativeID || null, title: row.title || 'Nueva conversación', turns: row.turns || [], updatedAt: row.updatedAt || Date.now(), op: null, inputs: new Map(), approvals: new Map() }
    state.policy = new Permissions({ workspace: this.directory, session: () => state.id,
      reply: async (id, decision) => { const pending = state.approvals.get(id); if (!pending) throw new Error('La solicitud venció.'); pending(decision === 'once'); state.approvals.delete(id) },
      publish: () => this.publishPermissions(state), publishMode: policy => this.publish(state, { type: 'permission_mode', policy }) })
    if (this.application === 'antigravity') state.policy.setMode = mode => mode === 'manual'
    this.states.set(state.id, state); return state
  }
  async list() {
    await this.load()
    if (this.application === 'claude') {
      for (const row of await this.driver.list(this.directory)) if (uuid(row.sessionId) && row.cwd === this.directory) {
        const state = this.states.get(row.sessionId) || this.create({ id: row.sessionId, nativeID: row.sessionId })
        state.title = row.customTitle || row.summary || state.title; state.updatedAt = row.lastModified
      }
    }
    return [...this.states.values()].map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, busy: !!s.op })).sort((a,b) => b.updatedAt - a.updatedAt)
  }
  async open(choice) {
    await this.list()
    let state
    if (!choice) state = this.defaultState
    else if (choice !== 'new') state = this.states.get(choice)
    if (choice && choice !== 'new' && !state) throw new Error('La conversación no pertenece a este proyecto.')
    if (!state) { state = this.create(); if (!choice) this.defaultState = state }
    if (this.application === 'claude' && state.nativeID && !state.op) {
      const info = await this.driver.info(this.directory, state.nativeID)
      if (!info || info.cwd !== this.directory) throw new Error('La conversación nativa pertenece a otra carpeta o ya no existe.')
      const messages = await this.driver.history(this.directory, state.nativeID)
      state.turns = messages.filter(m => !m.parent_tool_use_id && ['user','assistant'].includes(m.type)).map(m => ({ id: m.uuid, role: m.type === 'user' ? 'user' : 'jarvis', text: nativeText(m.message) })).filter(m => m.text)
    }
    return state
  }
  transcript(state) { return state.turns }
  snapshot(state) { return { type: 'session_update', turns: state.turns, busy: !!state.op } }
  publish(state, frame) { this.emit(state.id, frame) }
  update(state) { this.publish(state, this.snapshot(state)) }
  subscribe(state, listener) { state.policy.setMode('manual'); this.on(state.id, listener); return () => { this.off(state.id, listener); state.policy.setMode('manual') } }
  publishPermissions(state) { this.publish(state, { type: 'permissions', requests: [...state.policy.pending.values(), ...[...state.inputs].map(([id, value]) => ({ id, permission: 'user_input', patterns: [], metadata: { application: this.application, questions: value.questions } }))] }) }
  permission(state, tool, input, { signal, toolUseID = randomUUID() } = {}) {
    if (!state.op || signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Turno detenido.' })
    const id = this.application + ':' + this.runtimeId + ':' + state.id + ':' + toolUseID
    return new Promise(resolve => {
      const finish = value => { signal?.removeEventListener('abort', abort); state.approvals.delete(id); state.inputs.delete(id); state.policy.resolved(id); resolve(value); this.publishPermissions(state) }
      const abort = () => finish({ behavior: 'deny', message: 'Solicitud cancelada.' })
      signal?.addEventListener('abort', abort, { once: true })
      if (tool === 'AskUserQuestion') {
        const questions = (input.questions || []).map((q, index) => ({ id: String(index), question: q.question, options: q.options || [], isOther: true, isSecret: false }))
        state.inputs.set(id, { questions, input, finish }); this.publishPermissions(state)
      } else {
        state.approvals.set(id, allow => finish(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'El usuario rechazó la operación.' }))
        void state.policy.receive({ id, sessionID: state.id, permission: tool === 'Read' ? 'read' : tool,
          patterns: tool === 'Read' ? [input.file_path] : [], metadata: { tool, input } })
      }
    })
  }
  answerInput(state, id, answers) {
    const request = state.inputs.get(id); if (!request) throw new Error('La solicitud venció o pertenece a otra conversación.')
    if (!answers || typeof answers !== 'object') throw new Error('Respuestas inválidas.')
    if (!Object.keys(answers).length) { request.finish({ behavior: 'deny', message: 'El usuario canceló la pregunta.' }); return }
    const mapped = {}
    for (const question of request.questions) {
      const values = answers[question.id]?.answers
      if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new Error('Responde todas las preguntas.')
      mapped[question.question] = values.join(', ')
    }
    request.finish({ behavior: 'allow', updatedInput: { ...request.input, answers: mapped } })
  }
  async archive() { throw new Error('Esta aplicación no ofrece archivado seguro desde Mi-asistente. Gestiona la conversación en su cliente nativo.') }
  async ask(state, message, timing = noopTiming) {
    if (state.op) throw new Error('La aplicación está trabajando; espera o detén su respuesta.')
    if (message.audio || message.preserveOnly || message.audioMode && message.audioMode !== 'transcript') throw new Error(applicationNames[this.application] + ' usa solo transcripción; no se envió el audio.')
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 200000) throw new Error('Escribe una pregunta válida.')
    if (message.screen && !this.capabilities.screenOptIn) throw new Error('Antigravity CLI admite solo texto por su interfaz programática. Desactiva Compartir pantalla; no se envió la pregunta.')
    const op = { ask: message.id, text: '', controller: new AbortController(), stopping: false }
    state.op = op; this.update(state)
    const prepare = timing.start('bridge.prepare', message.traceId)
    op.done = (async () => {
      try {
        const models = await this.driver.models(this.directory, op.controller.signal); op.controller.signal.throwIfAborted()
        const explicit = message.model && message.model !== 'native/default'
        const selected = explicit ? models.find(m => m.id === message.model) : null
        if (explicit && !selected || message.variant && !selected?.variants.includes(message.variant)) throw new NativeRequestError('Modelo o pensamiento no disponible en el catálogo nativo.')
        let content = [{ type: 'text', text: message.text }]
        if (message.screen) {
          if (explicit && !selected.image) throw new NativeRequestError('El modelo seleccionado no anuncia imágenes; no se envió la pregunta.')
          const visual = await this.screen(message.text, { signal: op.controller.signal, onState: status => this.publish(state, { type: 'screen', ask: op.ask, state: status }) })
          content = [{ type: 'text', text: message.text + (visual.context ? '\n\n' + visual.context : '') }, ...visual.parts.filter(p => p.type === 'file').map(p => {
            const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(p.url)
            if (!match) throw new NativeRequestError('Adjunto visual inválido.')
            return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
          })]
        }
        op.controller.signal.throwIfAborted()
        state.turns.push({ id: randomUUID(), role: 'user', text: message.text }); state.title = state.turns.find(t => t.role === 'user')?.text.slice(0,80) || state.title
        prepare.end(); this.publish(state, { type: 'submitted', ask: op.ask })
        await this.driver.run({ directory: this.directory, id: state.nativeID || state.id, resume: !!state.nativeID, content,
          model: selected?.id, effort: message.variant || undefined, signal: op.controller.signal,
          permission: (...args) => this.permission(state, ...args),
          onSession: async id => { if (!uuid(id)) throw new Error('Identificador nativo inválido.'); if (this.application === 'claude' && id !== state.id) throw new Error('El cliente nativo cambió de conversación.'); state.nativeID = id; await this.persist() },
          onText: delta => { op.text += delta; this.publish(state, { type: 'text', ask: op.ask, delta }) },
          onTool: name => this.publish(state, { type: 'tool', ask: op.ask, name }),
        })
        if (op.text) state.turns.push({ id: randomUUID(), role: 'jarvis', text: op.text })
        state.updatedAt = Date.now(); await this.persist()
        this.publish(state, { type: 'done', ask: op.ask, text: op.text, status: op.stopping ? 'cancelled' : 'ok' })
      } catch (error) {
        prepare.end(op.stopping ? 'cancelled' : 'error')
        if (op.stopping) this.publish(state, { type: 'done', ask: op.ask, text: op.text, status: 'cancelled' })
        else this.publish(state, { type: 'error', ask: op.ask, message: error instanceof NativeRequestError ? error.message : 'El cliente nativo no completó el turno. Revisa su sesión o autenticación y reintenta.' })
      } finally {
        for (const pending of state.inputs.values()) pending.finish({ behavior: 'deny', message: 'Turno terminado.' })
        await state.policy.rejectAll(); state.op = null; this.update(state)
      }
    })()
    return op.done
  }
  async interrupt(state) { const op = state.op; if (!op) return; op.stopping = true; op.controller.abort(); await op.done }
  async close() { for (const state of this.states.values()) await this.interrupt(state); await this.queue }
}
export class NativeManager {
  constructor(options = {}) { this.options = options; this.runtimes = new Map(); this.drivers = options.drivers || { claude: new ClaudeDriver(), antigravity: new AntigravityDriver() } }
  async runtime(directory, application) { const path = await realpath(directory); const key = application + '\0' + path; if (!this.runtimes.has(key)) { const driver = this.drivers[application]; if (!driver) throw new Error('Aplicación no disponible.'); this.runtimes.set(key, new NativeRuntime(path, application, driver, this.options)) } return this.runtimes.get(key) }
  async availability() {
    if (this.detected && Date.now() - this.detected.at < 30000) return this.detected.rows
    const rows = await Promise.all(Object.entries(this.drivers).map(async ([id, driver]) => { try { await driver.verify(); return { id, name: applicationNames[id], available: true } } catch (error) { return { id, name: applicationNames[id], available: false, reason: error.message } } }))
    this.detected = { at: Date.now(), rows }; return rows
  }
  async verify(directory, application) { return (await this.runtime(directory, application)).verify() }
  async models(directory, application) { return (await this.runtime(directory, application)).models() }
  async close() { await Promise.all([...this.runtimes.values()].map(runtime => runtime.close())) }
}
