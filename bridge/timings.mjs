import { mkdir, readFile, appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTimings, validTiming } from '../shared/timings.mjs'

/** Bounded local metadata only. I/O runs behind the application, never on its critical path. */
export class TimingStore {
  constructor(directory, { limit = 2000, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.directory = directory; this.limit = limit; this.maxBytes = maxBytes
    this.events = new Map(); this.pending = []; this.writing = false; this.dropped = 0; this.persistence = 'ok'
    this.loaded = this.load()
  }
  async load() {
    try {
      for (const name of ['timings.previous.jsonl', 'timings.jsonl']) {
        const path = join(this.directory, name)
        const info = await stat(path).catch(() => null)
        if (!info || info.size > this.maxBytes + 16384) continue
        const text = await readFile(path, 'utf8')
        for (const line of text.split('\n')) {
          try {
            const event = validTiming(JSON.parse(line))
            if (event && event.phase === 'end' && event.at >= Date.now() - 86400000 && !this.events.has(event.source + ':' + event.id)) this.remember(event)
          } catch { /* An interrupted final append is not an application failure. */ }
        }
      }
    } catch { this.persistence = 'error' }
  }
  remember(event) {
    const key = event.source + ':' + event.id
    if (this.events.get(key)?.phase === 'end') return
    this.events.delete(key); this.events.set(key, event)
    while (this.events.size > this.limit) {
      const oldest = [...this.events].reduce((old, item) => item[1].at < old[1].at ? item : old)
      this.events.delete(oldest[0])
    }
  }
  add(value, source) {
    const event = validTiming(value, source)
    if (!event) return false
    if (this.events.get(event.source + ':' + event.id)?.phase === 'end') return true
    this.remember(event)
    if (event.phase === 'end') {
      if (this.pending.length >= 240) { this.dropped++; return true }
      this.pending.push(event)
      if (!this.writing) void this.write()
    }
    return true
  }
  async write() {
    this.writing = true
    await this.loaded
    let inFlight = 0
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      while (this.pending.length) {
        const batch = this.pending.splice(0, 24)
        inFlight = batch.length
        const file = join(this.directory, 'timings.jsonl')
        const bytes = (await stat(file).catch(() => null))?.size || 0
        if (bytes >= this.maxBytes) await rename(file, join(this.directory, 'timings.previous.jsonl'))
        await appendFile(file, batch.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
        inFlight = 0
      }
      this.persistence = 'ok'
    } catch { this.dropped += inFlight + this.pending.length; this.pending = []; this.persistence = 'error' }
    finally { this.writing = false }
  }
  async snapshot() {
    await this.loaded
    return { events: [...this.events.values()].filter(e => e.at >= Date.now() - 86400000).sort((a,b) => a.at-b.at),
      persistence: this.persistence, dropped: this.dropped, limit: this.limit }
  }
  recorder(emit = () => {}) {
    return createTimings({ source: 'bridge', uuid: randomUUID, emit: event => { this.add(event, 'bridge'); emit(event) } })
  }
}
