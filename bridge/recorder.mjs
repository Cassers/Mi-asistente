import { mkdir, writeFile, rename, unlink, statfs } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { HISTORY_ROOT, CLIP_SECONDS, pruneHistory } from './history-store.mjs'
import { monitorOutputs } from './monitor-outputs.mjs'

const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const TARGET_FPS = 2
export const frameDelayMs = (elapsedMs, fps = TARGET_FPS) => Math.max(0, 1000 / fps - elapsedMs)

export class Recorder {
  constructor(root = HISTORY_ROOT, timing = null) {
    this.root = root
    this.timing = timing
    this.state = { active: false, root, fps: 0, targetFps: TARGET_FPS, retentionMinutes: 30, audio: ['mic', 'system'], error: '' }
    this.children = new Set()
    this.queue = Promise.resolve()
    this.maintenance = setInterval(() => {
      if (this.pruning) return
      this.pruning = this.measure('history.prune', () => pruneHistory(this.root)).catch((err) => { this.state.error = `Retención: ${err.message}` })
        .finally(() => { this.pruning = null })
    }, 10000)
    this.maintenance.unref()
  }
  snapshot() { return { ...this.state, updatedAt: Date.now() } }
  async measure(name, work) {
    let span
    try { span = this.timing?.start(name) } catch { /* Observer only. */ }
    try { const value = await work(); try { span?.end() } catch {} return value }
    catch (error) { try { span?.end(error.name === 'AbortError' ? 'cancelled' : 'error') } catch {} throw error }
  }
  async publish() {
    return this.measure('history.publish', async () => {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const tmp = join(this.root, 'status.json.part')
    await writeFile(tmp, JSON.stringify(this.snapshot()), { mode: 0o600 })
    await rename(tmp, join(this.root, 'status.json'))
    })
  }
  setActive(on) {
    this.queue = this.queue.catch(() => {}).then(() => this.measure('history.toggle', () => on ? this.start() : this.stop()))
    return this.queue
  }
  async start() {
    if (this.state.active) return
    const output = (await monitorOutputs()).principal
    if (!output) throw new Error('Monitor principal no disponible')
    const mic = (await run('pactl', ['get-default-source'], { timeout: 3000 })).stdout.trim()
    const sink = (await run('pactl', ['get-default-sink'], { timeout: 3000 })).stdout.trim()
    if (!mic || mic.endsWith('.monitor') || !sink) throw new Error('No hay micrófono/salida predeterminados válidos')
    this.session = join(this.root, `session-${Date.now()}-${randomBytes(4).toString('hex')}`)
    await mkdir(join(this.session, 'frames'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.session, 'audio'), { mode: 0o700 })
    this.state = { ...this.state, active: true, fps: 0, frames: 0, startedAt: Date.now(), error: '', monitor: output }
    this.controller = new AbortController()
    await writeFile(join(this.session, 'session.json'), JSON.stringify({ ...this.state, mic, system: `${sink}.monitor` }), { mode: 0o600 })
    for (const [name, source] of [['mic', mic], ['system', `${sink}.monitor`]]) {
      const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'pulse', '-i', source,
        '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'segment',
        '-segment_time', String(CLIP_SECONDS), '-reset_timestamps', '1', '-strftime', '1',
        join(this.session, 'audio', `${name}-%s.ogg`)], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.children.add(child)
      let error = ''
      child.stderr.on('data', (data) => { error = (error + data.toString()).slice(-300) })
      child.on('error', (err) => { this.state.error = `Audio ${name}: ${err.message}` })
      child.on('exit', (code) => {
        this.children.delete(child)
        if (this.state.active) this.state.error = `Audio ${name} detenido (${code}): ${error}`
      })
    }
    await this.publish()
    this.loop = this.captureLoop(output, this.controller.signal).catch((err) => {
      if (!this.controller.signal.aborted) { this.state.error = err.message; void this.setActive(false) }
    })
  }
  async captureLoop(output, signal) {
    let lastHousekeeping = 0
    let measuredAt = Date.now()
    let measuredFrames = 0
    let failures = 0
    while (!signal.aborted) {
      const started = Date.now()
      const file = join(this.session, 'frames', `screen-${started}-${this.state.frames}.png`)
      try {
        await this.measure('history.frame', async () => {
          await run('grim', ['-t', 'png', '-l', '1', '-o', output, file + '.part'], { timeout: 3000, signal })
          await rename(file + '.part', file)
        })
        this.state.frames++
        measuredFrames++
        failures = 0
        if (this.state.error.startsWith('Captura:')) this.state.error = ''
      } catch (err) {
        await unlink(file + '.part').catch(() => {})
        if (signal.aborted) break
        this.state.error = `Captura: ${err.message}`
        // Hotplug can rename a connector mid-session. Resolve the same logical
        // principal monitor again, never broaden capture to the whole desktop.
        if (/unknown output/i.test(err.message)) {
          const connected = await monitorOutputs().catch(() => ({}))
          if (connected.principal) { output = connected.principal; this.state.monitor = output }
        }
        if (++failures >= 3) throw err
      }
      const now = Date.now()
      if (now - measuredAt >= 2000) {
        this.state.fps = Math.round(measuredFrames * 10000 / (now - measuredAt)) / 10
        measuredAt = now; measuredFrames = 0
        await this.publish()
      }
      if (now - lastHousekeeping >= 10000) {
        lastHousekeeping = now
        const disk = await statfs(this.root)
        if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('Grabación pausada: menos de 2 GB libres')
      }
      await sleep(frameDelayMs(Date.now() - started, this.state.targetFps))
    }
  }
  async stop() {
    this.state.active = false
    this.controller?.abort()
    await this.loop
    await Promise.all([...this.children].map((child) => new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGINT')
    })))
    this.state.fps = 0
    await this.publish()
  }
}
