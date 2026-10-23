import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const validID = (id) => typeof id === 'string' && /^ses_[\w-]{1,120}$/.test(id)

/** Private allowlist of JARVIS-owned chats. OpenCode, not this JSON, stores messages.
 * Serialize ownership changes so reconnect cannot race an old socket's abort. */
export class Conversations {
  constructor(api, workspace) {
    this.api = api
    this.workspace = resolve(workspace)
    this.dir = join(this.workspace, '.jarvis')
    this.file = join(this.dir, 'conversations.json')
    this.leases = new Map()
    this.queue = Promise.resolve()
  }
  serial(task) {
    const result = this.queue.catch(() => {}).then(task)
    this.queue = result.catch(() => {})
    return result
  }
  async load() {
    if (this.data) return
    let data
    try { data = JSON.parse(await readFile(this.file, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Registro de conversaciones ilegible; no se sobrescribió.')
      data = { version: 1, latest: null, entries: [] }
    }
    if (data.version !== 1 || !Array.isArray(data.entries) ||
        data.entries.some((e) => !validID(e.id) || typeof e.title !== 'string' || !Number.isFinite(e.updatedAt)) ||
        new Set(data.entries.map((e) => e.id)).size !== data.entries.length ||
        data.latest !== null && !data.entries.some((e) => e.id === data.latest)) {
      throw new Error('Registro de conversaciones inválido; no se modificó.')
    }
    this.data = data
  }
  async save(data) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temp = join(this.dir, `conversations-${randomUUID()}.json.part`)
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
    await rename(temp, this.file)
    this.data = data
  }
  async checked(id) {
    if (!this.data.entries.some((e) => e.id === id)) throw new Error('Esa conversación no pertenece a esta instalación.')
    const session = await this.api('GET', `/session/${id}`)
    if (session.id !== id || resolve(session.directory || '') !== this.workspace) {
      throw new Error('La conversación pertenece a otro espacio de trabajo.')
    }
    return session
  }
  open(choice, owner) {
    return this.serial(async () => {
      await this.load()
      let id = choice === 'new' ? null : choice || this.data.latest
      if (id && !validID(id)) throw new Error('Identificador de conversación inválido.')
      if (id && this.leases.has(id)) throw new Error('La conversación ya está abierta en otra ventana; abre una nueva.')
      const resumed = Boolean(id)
      const session = id ? await this.checked(id) : await this.api('POST', '/session', {
        title: `Asistente · ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date())}`,
      })
      if (!validID(session.id) || resolve(session.directory || '') !== this.workspace) throw new Error('Espacio de trabajo inesperado; no se abrió la conversación.')
      id = session.id
      if (resumed) await this.api('POST', `/session/${id}/abort`)
      const now = Date.now()
      const entry = { id, title: session.title, createdAt: session.time?.created || now, updatedAt: now }
      try { await this.save({ ...this.data, latest: id, entries: [...this.data.entries.filter((e) => e.id !== id), entry] }) }
      catch (error) {
        if (!resumed) await this.api('DELETE', `/session/${id}`).catch(() => {})
        throw error
      }
      this.leases.set(id, owner)
      return { ...entry, resumed }
    })
  }
  list() {
    return this.serial(async () => {
      await this.load()
      return this.data.entries.toSorted((a, b) => b.updatedAt - a.updatedAt).map((e) => ({ ...e, busy: this.leases.has(e.id) }))
    })
  }
  release(id, owner, cleanup = async () => {}) {
    return this.serial(async () => {
      if (this.leases.get(id) !== owner) return
      await this.api('POST', `/session/${id}/abort`)
      await cleanup()
      this.leases.delete(id)
    })
  }
  remove(id, owner) {
    return this.serial(async () => {
      await this.load()
      if (this.leases.get(id) !== owner) throw new Error('No puedes borrar una conversación que no tienes abierta.')
      await this.checked(id)
      await this.api('POST', `/session/${id}/abort`)
      if (await this.api('DELETE', `/session/${id}`) !== true) throw new Error('OpenCode no confirmó el borrado.')
      const entries = this.data.entries.filter((e) => e.id !== id)
      await this.save({ ...this.data, entries, latest: entries.at(-1)?.id || null })
      this.leases.delete(id)
    })
  }
}
