import { spawn } from 'node:child_process'

export class WhisperError extends Error {
  constructor(status, message) { super(message); this.name = 'WhisperError'; this.status = status }
}

/** Kill only this operation's child, and settle after its pipes/process close. */
export function runWhisperProcess(command, args, { input, signal, timeout = 15000, maxOutput = 1024 * 1024,
  outputError = new WhisperError(502, 'La salida del proceso local excedió el límite.'),
  failure = 'Falló el proceso local de transcripción.' } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { reject(new WhisperError(503, 'No se pudo iniciar el ejecutable local.')); return }
    let failureReason, size = 0, ended = false, force
    const chunks = []
    const stop = error => {
      if (ended || failureReason) return
      failureReason = error
      child.kill('SIGTERM')
      force = setTimeout(() => child.kill('SIGKILL'), 250)
      force.unref()
    }
    const abort = () => stop(signal.reason || new DOMException('Cancelado.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new WhisperError(504, 'El proceso local excedió el tiempo permitido.')), timeout)
    timer.unref()
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > maxOutput) stop(outputError)
      else if (!failureReason) chunks.push(chunk)
    })
    // Native diagnostics may contain recognized speech. Never persist/forward them.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => { failureReason ||= new WhisperError(503, 'No se pudo iniciar el ejecutable local.') })
    child.once('close', code => {
      ended = true; clearTimeout(timer); clearTimeout(force)
      signal?.removeEventListener('abort', abort)
      if (failureReason) reject(failureReason)
      else if (code !== 0) reject(new WhisperError(422, failure))
      else resolve(Buffer.concat(chunks))
    })
    if (signal?.aborted) abort()
    child.stdin.end(input)
  })
}
