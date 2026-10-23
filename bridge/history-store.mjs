import { readdir, lstat, readFile, unlink, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const HISTORY_ROOT = process.env.JARVIS_HISTORY_DIR || fileURLToPath(new URL('../recordings', import.meta.url))
export const RETENTION_MS = 30 * 60 * 1000
export const CLIP_SECONDS = 10
const SESSION = /^session-\d+-[a-f0-9]{8}$/
const FRAME = /^screen-(\d+)-\d+\.png$/
const AUDIO = /^(mic|system)-(\d+)\.ogg$/

/** Only recorder-owned, regular files are eligible for reading or deletion. */
export async function historyFiles(root = HISTORY_ROOT) {
  const files = []
  for (const session of await readdir(root).catch(() => [])) {
    if (!SESSION.test(session)) continue
    const dir = join(root, session)
    if (!(await lstat(dir)).isDirectory()) continue
    for (const kind of ['frames', 'audio']) {
      const folder = join(dir, kind)
      const folderStat = await lstat(folder).catch(() => null)
      if (!folderStat?.isDirectory()) continue
      for (const name of await readdir(folder)) {
        const match = (kind === 'frames' ? FRAME : AUDIO).exec(name)
        if (!match) continue
        const path = join(folder, name)
        // lstat excludes symlinks pointing outside the recording folder.
        const stat = await lstat(path).catch(() => null)
        if (!stat?.isFile()) continue
        const at = kind === 'frames' ? Number(match[1]) : Number(match[2]) * 1000
        files.push({ path, name, session, kind, at, end: at + (kind === 'audio' ? CLIP_SECONDS * 1000 : 0),
          source: kind === 'audio' ? match[1] : 'screen', bytes: stat.size })
      }
    }
  }
  return files.sort((a, b) => a.at - b.at)
}

export function selectWindow(files, { now = Date.now(), secondsAgo = 0, duration = 30, startTime } = {}) {
  const start = startTime ? Date.parse(startTime) : now - (secondsAgo + duration) * 1000
  if (!Number.isFinite(start)) throw new Error('Invalid start_time; use ISO 8601 with timezone')
  const end = start + duration * 1000
  return { start, end, files: files.filter((f) => f.at <= end && f.end >= start && f.end >= now - RETENTION_MS) }
}

export function sampleFrames(frames, count = 8) {
  if (frames.length <= count) return frames
  return Array.from({ length: count }, (_, i) => frames[Math.round(i * (frames.length - 1) / (count - 1))])
}

/** Retention never touches foreign files, symlinks, or the recording root. */
export async function pruneHistory(root = HISTORY_ROOT, now = Date.now()) {
  let removed = 0
  const files = await historyFiles(root)
  for (const file of files) {
    if (file.end < now - RETENTION_MS) {
      await unlink(file.path).catch((err) => { if (err.code !== 'ENOENT') throw err })
      removed++
    }
  }
  for (const session of new Set(files.filter((f) => f.end < now - RETENTION_MS).map((f) => f.session))) {
    const dir = join(root, session)
    for (const kind of ['frames', 'audio']) await rmdir(join(dir, kind)).catch(() => {})
    const names = await readdir(dir).catch(() => [])
    if (names.length === 1 && names[0] === 'session.json') {
      const path = join(dir, 'session.json')
      const stat = await lstat(path)
      if (stat.isFile()) { await unlink(path); await rmdir(dir).catch(() => {}) }
    }
  }
  return removed
}

export async function recordingStatus(root = HISTORY_ROOT) {
  try {
    const value = JSON.parse(await readFile(join(root, 'status.json'), 'utf8'))
    // A crashed recorder must not look active indefinitely.
    if (value.active && Date.now() - value.updatedAt > 10000) return { ...value, active: false, error: 'Grabador desconectado' }
    return value
  } catch { return { active: false, root, error: 'Sin historial disponible' } }
}
