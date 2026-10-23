import { resolve } from 'node:path'

const permissionEvent = type => /^permission\.(?:v2\.)?(?:asked|replied)$/.test(type)

/** Only verified descendants in this workspace may share their owner's dialog. */
export function sessionEvents({ handlers, getSession, workspace, onError = () => {} }) {
  const queues = new Map()
  async function owner(id) {
    const seen = new Set()
    for (let depth = 0; depth < 8 && typeof id === 'string' && !seen.has(id); depth++) {
      if (handlers.has(id)) return id
      seen.add(id)
      const session = await getSession(id)
      if (session?.id !== id || typeof session.directory !== 'string' || resolve(session.directory) !== resolve(workspace)) return null
      id = session.parentID
    }
    return null
  }
  return ev => {
    const p = ev.properties ?? {}
    const sid = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID
    const direct = handlers.get(sid)
    if (direct) { direct(ev); return Promise.resolve() }
    // Child text/idle/error never ends or speaks over the main assistant's turn.
    if (!sid || !permissionEvent(ev.type)) return Promise.resolve()
    const queued = (queues.get(sid) || Promise.resolve()).then(async () => {
      const root = await owner(sid)
      if (!root) return
      handlers.get(root)?.({ ...ev, properties: { ...p, sessionID: root,
        metadata: { ...p.metadata, subagentSessionID: sid } } })
    }).catch(onError)
    queues.set(sid, queued)
    void queued.finally(() => { if (queues.get(sid) === queued) queues.delete(sid) })
    return queued
  }
}
