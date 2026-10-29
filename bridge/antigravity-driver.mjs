import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
const exec = promisify(execFile)

/** Official CLI headless protocol: text only, native Ask permissions soft-denied. */
export class AntigravityDriver {
  constructor({ command = process.env.JARVIS_ANTIGRAVITY_CLI || 'agy', spawnProcess = spawn, runCommand = exec } = {}) { Object.assign(this, { command, spawnProcess, runCommand }) }
  async verify() { try { await this.runCommand(this.command, ['--version'], { timeout: 5000, maxBuffer: 4096 }); return true } catch { throw new Error('Antigravity CLI (agy) no está instalada o no responde. El IDE por sí solo no ofrece esta conexión.') } }
  async models() { return [] } // No stable machine-readable catalog in the installed CLI's documented help. Preserve native default.
  async run({ directory, id, resume, content, signal, onSession, onText, onTool }) {
    if (content.some(p => p.type !== 'text')) throw new Error('Antigravity CLI admite solo texto por su interfaz programática.')
    const args = ['--input-format','stream-json','--output-format','stream-json', ...(resume ? ['--conversation',id] : [])]
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|JARVIS_)/.test(key) && key !== 'CODEX_THREAD_ID'))
    const child = this.spawnProcess(this.command, args, { cwd: directory, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] })
    let result, parseError, nativeID, streamed = false, seenSession = false, chain = Promise.resolve(), bytes = 0, timer
    const input = createInterface({ input: child.stdout })
    const kill = sig => { try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig) } catch {} }
    const abort = () => { kill('SIGINT'); timer = setTimeout(() => kill('SIGKILL'), 3000); timer.unref() }
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    child.stderr.on('data', () => {}) // Native diagnostics can contain private paths/account data.
    child.stdin.on('error', () => {})
    input.on('line', raw => {
      bytes += Buffer.byteLength(raw)
      if (bytes > 16 * 1024 * 1024) { parseError = new Error('Antigravity excedió el tamaño de respuesta.'); kill('SIGTERM'); return }
      chain = chain.then(async () => {
        const frame = JSON.parse(raw)
        if (frame.event === 'init') { if (frame.init?.cwd !== directory || resume && frame.conversation_id !== id) throw new Error('Antigravity abrió otra conversación o carpeta.'); await onSession(frame.conversation_id); nativeID = frame.conversation_id; seenSession = true }
        if (frame.event === 'step_update' && frame.step_update?.step_type === 'agent_response' && typeof frame.step_update.text_delta === 'string') { streamed = true; onText(frame.step_update.text_delta) }
        if (frame.event === 'step_update' && frame.step_update?.step_type === 'tool') onTool(frame.step_update.tool_name || 'tool')
        if (frame.event === 'result') result = frame.result
      }).catch(() => { parseError = new Error('Antigravity devolvió un protocolo inválido.'); kill('SIGTERM') })
    })
    try {
      const exit = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('Antigravity no pudo iniciarse.'))); child.once('close', (code) => resolve(code)) })
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: content.map(p => ({ type: 'text', text: p.text })) } }) + '\n')
      const code = await exit; await chain
      if (signal.aborted) return
      if (parseError) throw parseError
      if (!seenSession || result?.conversation_id !== nativeID || code !== 0 || result?.status !== 'SUCCESS') throw new Error('Antigravity no completó el turno. Revisa su autenticación y los permisos nativos en agy.')
      if (!streamed && typeof result.response === 'string') onText(result.response)
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); input.close() }
  }
}
