import { realpath, stat, readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, basename, dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export function localServer(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('URL de OpenCode inválida.') }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Usa un servidor HTTP local de OpenCode, sin credenciales en la URL.')
  }
  return url.origin
}

export function nativeClient(serverURL, directory, { username = 'opencode', password = '' } = {}) {
  const base = localServer(serverURL)
  const headers = { 'x-opencode-directory': encodeURIComponent(directory),
    ...(password ? { authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') } : {}) }
  const url = path => {
    const target = new URL(base + path)
    target.searchParams.set('directory', directory)
    return target
  }
  const api = async (method, path, body, { signal } = {}) => {
    const timeout = AbortSignal.timeout(15000)
    const res = await fetch(url(path), { method, redirect: 'error',
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!res.ok) throw new Error(res.status === 401 ? 'OpenCode solicita la contraseña de su servidor local (no la API key del modelo).'
      : `OpenCode respondió HTTP ${res.status}.`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
  api.events = signal => fetch(url('/event'), { headers, redirect: 'error', signal })
  return api
}

export class Projects {
  constructor({ serverURL = 'http://127.0.0.1:4097', password = '', username = 'opencode',
    codex, native, file = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'mi-asistente/projects.json'), client = nativeClient } = {}) {
    this.codex = codex
    this.native = native
    this.serverURL = localServer(serverURL)
    this.credentials = { username, password }
    this.file = file
    this.client = client
    this.items = new Map()
    this.clients = new Map()
    this.queue = Promise.resolve()
  }
  async load() {
    if (this.loaded) return
    let data
    try { data = JSON.parse(await readFile(this.file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Registro de proyectos ilegible; no se sobrescribió.') }
    if (data && (!Array.isArray(data.projects) || data.version !== 1)) throw new Error('Registro de proyectos inválido.')
    for (const item of data?.projects || []) {
      if (typeof item.directory !== 'string' || !isAbsolute(item.directory)) throw new Error('Proyecto guardado inválido.')
      const application = item.application || 'opencode'
      if (!['opencode', 'codex', 'claude', 'antigravity'].includes(application)) throw new Error('Aplicación guardada inválida.')
      const serverURL = application !== 'opencode' ? '' : localServer(item.serverURL)
      const id = this.id(serverURL, item.directory, application)
      if (item.id !== id) throw new Error('Proyecto guardado inválido.')
      this.items.set(id, { id, directory: item.directory, name: basename(item.directory) || item.directory, serverURL, application })
    }
    this.loaded = true
  }
  id(server, directory, application = 'opencode') { return createHash('sha256').update((application !== 'opencode' ? application : server) + '\0' + directory).digest('hex').slice(0, 24) }
  async list() { await this.load(); return [...this.items.values()] }
  async get(id) {
    await this.load()
    const item = this.items.get(id)
    if (!item || await realpath(item.directory).catch(() => '') !== item.directory) throw new Error('El proyecto no está abierto o su carpeta cambió. Ábrelo de nuevo.')
    return item
  }
  api(item) {
    if (item.application !== 'opencode') throw new Error('Este proyecto usa ' + ({ codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }[item.application] || 'un cliente nativo') + ', no el servidor de OpenCode.')
    if (this.clients.has(item.id)) return this.clients.get(item.id)
    return this.client(item.serverURL, item.directory, item.serverURL === this.serverURL ? this.credentials : {})
  }
  async open({ directory, application = 'opencode', serverURL = this.serverURL, username = 'opencode', password } = {}) {
    if (!['opencode', 'codex', 'claude', 'antigravity'].includes(application)) throw new Error('Aplicación no compatible.')
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0') || directory.length > 4096) throw new Error('Elige una carpeta local con ruta absoluta.')
    const path = await realpath(directory).catch(() => { throw new Error('La carpeta no existe o no es accesible.') })
    if (!(await stat(path)).isDirectory()) throw new Error('El proyecto debe ser una carpeta.')
    const server = application !== 'opencode' ? '' : localServer(serverURL)
    const item = { id: this.id(server, path, application), directory: path, name: basename(path) || path, serverURL: server, application }
    let api
    if (application === 'codex') {
      if (!this.codex) throw new Error('Codex no está habilitado en este puente.')
      await this.codex.verify(path)
    } else if (application !== 'opencode') {
      if (!this.native) throw new Error('Este puente necesita actualizarse para abrir esta aplicación.')
      await this.native.verify(path, application)
    } else {
      const credentials = password === undefined && server === this.serverURL ? this.credentials : { username, password: password || '' }
      api = this.client(server, path, credentials)
      const health = await api('GET', '/global/health')
      if (health?.healthy !== true) throw new Error('El servidor seleccionado no es un OpenCode disponible.')
      const nativePath = await api('GET', '/path')
      if (await realpath(nativePath?.directory || '').catch(() => '') !== path) throw new Error('OpenCode no abrió la carpeta solicitada. No se conectó a otro proyecto.')
    }
    await this.load()
    const save = this.queue.catch(() => {}).then(async () => {
      const next = new Map(this.items); next.set(item.id, item)
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.' + randomUUID() + '.part'
      await writeFile(temp, JSON.stringify({ version: 1, projects: [...next.values()] }), { mode: 0o600 })
      await rename(temp, this.file)
      this.items = next; if (api) this.clients.set(item.id, api)
    })
    this.queue = save
    await save
    return item
  }
}

export class NativeConversations {
  constructor(api, directory) { this.api = api; this.directory = directory }
  async checked(id) {
    if (typeof id !== 'string' || !/^ses_[\w-]{1,120}$/.test(id)) throw new Error('Conversación inválida.')
    const session = await this.api('GET', '/session/' + encodeURIComponent(id))
    if (session.id !== id || session.directory !== this.directory) throw new Error('La conversación pertenece a otra carpeta.')
    return session
  }
  async list() {
    const [sessions, statuses] = await Promise.all([this.api('GET', '/session?limit=1000&roots=true'), this.api('GET', '/session/status')])
    return sessions.filter(s => s.directory === this.directory && !s.parentID && !s.time?.archived).map(s => ({ id: s.id,
      title: s.title || 'Conversación', updatedAt: s.time?.updated || s.time?.created || 0,
      busy: statuses[s.id]?.type === 'busy' || statuses[s.id]?.type === 'retry' })).sort((a,b) => b.updatedAt - a.updatedAt)
  }
  async open(id) {
    const session = id && id !== 'new' ? await this.checked(id) : await this.api('POST', '/session', {})
    await this.checked(session.id)
    return session
  }
  async remove(id) {
    await this.checked(id)
    const statuses = await this.api('GET', '/session/status')
    if (statuses[id] && statuses[id].type !== 'idle') throw new Error('La conversación está trabajando; no se borró.')
    return this.api('DELETE', '/session/' + encodeURIComponent(id))
  }
}
