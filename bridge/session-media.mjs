import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/** OpenCode resolves local image attachments; keep files alive during async ingestion. */
export async function sessionMedia({ retentionMs = 30 * 60 * 1000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-session-screen-'))
  const timers = new Set()
  let closed = false
  return {
    async attach(image, { signal } = {}) {
      signal?.throwIfAborted()
      if (closed) throw new Error('Session closed')
      const path = join(dir, `${randomUUID()}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`)
      await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600, signal })
      if (closed || signal?.aborted) {
        await rm(path, { force: true })
        signal?.throwIfAborted()
        throw new Error('Session closed')
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        void rm(path, { force: true }).catch(() => {})
      }, retentionMs)
      timer.unref()
      timers.add(timer)
      return pathToFileURL(path).href
    },
    async close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
