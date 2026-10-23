import { limitedReadAllowed } from './permission-policy.mjs'

/** Connection-scoped modes. Native deny rules still run before requests arrive. */
export class Permissions {
  constructor({ session, reply, publish, workspace, publishMode = () => {}, readAllowed = limitedReadAllowed }) {
    this.session = session
    this.reply = reply
    this.publish = publish
    this.pending = new Map()
    this.epoch = 0
    this.workspace = workspace
    this.publishMode = publishMode
    this.readAllowed = readAllowed
    this.mode = 'manual'
    this.policyVersion = 0
    this.autoApproved = 0
    this.seen = new Set()
  }
  snapshot() { return { mode: this.mode, autoApproved: this.autoApproved } }
  setMode(mode, confirmed = false) {
    if (!['manual', 'limited', 'total'].includes(mode) || (mode === 'total' && confirmed !== true)) return false
    this.mode = mode
    this.policyVersion++
    // Deliberately do not revisit existing requests when escalating the mode.
    this.publishMode(this.snapshot())
    return true
  }
  update() { this.publish([...this.pending.values()]) }
  receive(request) {
    if (request.sessionID !== this.session() || !request.id || this.seen.has(request.id)) return
    this.seen.add(request.id)
    const item = {
      id: request.id, permission: request.permission ?? request.action,
      patterns: request.patterns ?? request.resources ?? [], metadata: request.metadata ?? {},
    }
    this.pending.set(request.id, item)
    this.update()
    const mode = this.mode, version = this.policyVersion, epoch = this.epoch
    if (mode === 'manual') return
    return (async () => {
      const allowed = mode === 'total' || await this.readAllowed(item, this.workspace)
      if (!allowed || epoch !== this.epoch || version !== this.policyVersion || this.pending.get(request.id) !== item) return
      if (await this.respond(request.id, 'once')) {
        this.autoApproved++
        this.publishMode(this.snapshot())
      }
    })().catch(() => {
      // An uncertain response must not create an automatic retry loop.
      this.mode = 'manual'; this.policyVersion++
      this.publishMode({ ...this.snapshot(), error: 'Falló una aprobación automática. Se volvió a Manual; revisa la solicitud pendiente.' })
    })
  }
  resolved(id) { this.pending.delete(id); this.update() }
  async respond(id, decision) {
    if (!this.pending.has(id) || !['once', 'reject'].includes(decision)) return false
    // Remove before awaiting, preventing a double click from granting twice.
    const request = this.pending.get(id)
    const epoch = this.epoch
    this.resolved(id)
    try { await this.reply(id, decision); return true }
    catch (err) {
      if (epoch === this.epoch) { this.pending.set(id, request); this.update() }
      throw err
    }
  }
  async rejectAll() {
    this.epoch++
    const ids = [...this.pending.keys()]
    this.pending.clear()
    this.update()
    await Promise.all(ids.map((id) => this.reply(id, 'reject').catch(() => {})))
  }
}
