import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

/** Codex 0.159 bidirectional NDJSON. Native stderr/errors never cross into logs/UI. */
export class CodexRpc extends EventEmitter {
  constructor({ cwd, command = 'codex', args = ['app-server', '--listen', 'stdio://'], env = process.env,
    spawnProcess = spawn, requestTimeoutMs = 30000, maxFrameBytes = 32 * 1024 * 1024 } = {}) {
    super()
    Object.assign(this, { cwd, command, args, env, spawnProcess, requestTimeoutMs, maxFrameBytes })
    this.pending = new Map(); this.nextId = 0; this.closed = false
  }
  async start() {
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (this.closed) throw new Error('La conexión de Codex está cerrada.')
      // Own a process group on POSIX: the CLI launcher, native server and MCP
      // children must be shut down together, including after protocol failures.
      const child = this.spawnProcess(this.command, this.args, { cwd: this.cwd, env: Object.fromEntries(Object.entries(this.env).filter(([key]) => !/^(?:OPENCODE_|JARVIS_)/.test(key) && key !== 'CODEX_THREAD_ID')), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      this.processExited = new Promise(resolve => child.once('close', resolve))
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      child.stdout.on('data', chunk => {
        buffer += decoder.write(chunk)
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (Buffer.byteLength(line) > this.maxFrameBytes) { this.fail('Codex excedió el tamaño de mensaje permitido.'); return }
          if (!line.trim()) continue
          try { this.receive(JSON.parse(line)) }
          catch { this.fail('Codex envió un mensaje de protocolo inválido.'); return }
        }
        if (Buffer.byteLength(buffer) > this.maxFrameBytes) this.fail('Codex excedió el tamaño de mensaje permitido.')
      })
      child.stderr.on('data', () => {}) // May contain credentials, paths and tool output.
      child.stdin.on('error', () => this.fail('Se perdió la entrada de Codex.'))
      child.on('error', () => this.fail('No se pudo iniciar Codex. Comprueba su instalación.'))
      child.on('exit', () => this.fail('Codex terminó; vuelve a conectar y comprueba el historial nativo.'))
      const info = await this.request('initialize', { clientInfo: { name: 'mi_asistente', title: 'Mi asistente', version: '0.0.0' }, capabilities: null })
      this.notify('initialized', {})
      return info
    })()
    return this.starting
  }
  receive(message) {
    if (this.closed || !message || typeof message !== 'object' || Array.isArray(message)) return
    if (typeof message.method === 'string') {
      this.emit(Object.hasOwn(message, 'id') ? 'request' : 'notification', message)
      return
    }
    const slot = this.pending.get(message.id)
    if (!slot) return
    this.pending.delete(message.id); clearTimeout(slot.timer)
    if (Object.hasOwn(message, 'error')) {
      const error = new Error(`Codex rechazó ${slot.method}; comprueba su estado en el cliente nativo.`)
      if (Number.isSafeInteger(message.error?.code)) error.code = message.error.code
      slot.reject(error)
    }
    else if (Object.hasOwn(message, 'result')) slot.resolve(message.result)
    else slot.reject(new Error('Respuesta de protocolo incompleta de Codex.'))
  }
  write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Codex no está conectado.')
    const line = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error('La petición de Codex es demasiado grande.')
    this.child.stdin.write(line)
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex no confirmó ${method}; comprueba el historial antes de reintentar.`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  notify(method, params = {}) { this.write({ method, params }) }
  respond(id, result) { this.write({ id, result }) }
  reject(id) { this.write({ id, error: { code: -32601, message: 'Este cliente no admite la solicitud. Usa el cliente nativo o detén el turno.' } }) }
  fail(message) {
    if (this.closed) return
    this.closed = true
    for (const slot of this.pending.values()) { clearTimeout(slot.timer); slot.reject(new Error(message)) }
    this.pending.clear()
    this.emit('closed', new Error(message))
    void this.stopProcess()
  }
  stopProcess() {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child) return Promise.resolve()
    const signal = name => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name)
        else child.kill(name)
      } catch { /* An already-exited owned group needs no signal. */ }
    }
    this.stopping = (async () => {
      signal('SIGTERM')
      let timer
      try {
        await Promise.race([this.processExited, new Promise(resolve => { timer = setTimeout(resolve, 2000) })])
      } finally {
        clearTimeout(timer)
        signal('SIGKILL') // Also reap descendants if the launcher exited first.
      }
      await this.processExited
    })()
    return this.stopping
  }
  async close() {
    this.fail('Se cerró la conexión local de Codex.')
    await this.stopProcess()
  }
}
