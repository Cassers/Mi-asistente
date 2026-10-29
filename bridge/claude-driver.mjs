import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export class ClaudeDriver {
  constructor({ api = sdk, command = process.env.JARVIS_CLAUDE_CLI || 'claude', runCommand = exec, env = process.env } = {}) { Object.assign(this, { api, command, runCommand, env }) }
  async verify() { try { await this.runCommand(this.command, ['--version'], { timeout: 5000, maxBuffer: 4096 }); return true } catch { throw new Error('Claude Code no está instalado o no responde. Instálalo e inicia sesión en su cliente nativo.') } }
  options(directory) { return { cwd: directory, pathToClaudeCodeExecutable: this.command, settingSources: ['user','project','local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
    env: Object.fromEntries(Object.entries(this.env).filter(([key]) => !/^(OPENCODE_|JARVIS_)/.test(key) && !['CODEX_THREAD_ID','CLAUDECODE'].includes(key))) } }
  async models(directory, signal) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, 8000); timer.unref()
    let release; const wait = new Promise(resolve => { release = resolve })
    const prompt = { [Symbol.asyncIterator]() { return this }, async next() { await wait; return { done: true } }, async return() { release(); return { done: true } } }
    const query = this.api.query({ prompt, options: { ...this.options(directory), abortController: controller } })
    try { return (await query.supportedModels()).map(m => ({ id: m.value, name: m.displayName, provider: 'Claude Code', free: false, cost: { input: null, output: null },
      image: /^(claude-|opus\b|sonnet\b|haiku\b)/.test(m.resolvedModel || m.value), audio: false, variants: m.supportedEffortLevels || [] })) }
    catch { throw new Error('Claude Code no pudo cargar su catálogo nativo. Revisa la instalación o autenticación en su cliente.') }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); release(); query.close(); await prompt.return?.() }
  }
  async list(directory) { const rows = []; for (let offset = 0;; offset += 100) { const page = await this.api.listSessions({ dir: directory, includeWorktrees: false, limit: 100, offset }); rows.push(...page.filter(s => s.cwd === directory)); if (page.length < 100) return rows } }
  info(directory, id) { return this.api.getSessionInfo(id, { dir: directory }) }
  history(directory, id) { return this.api.getSessionMessages(id, { dir: directory }) }
  async run({ directory, id, resume, content, model, effort, signal, onSession, onText, onTool, permission }) {
    let release; const wait = new Promise(resolve => { release = resolve })
    const prompt = (async function* () { yield { type: 'user', session_id: id, parent_tool_use_id: null, message: { role: 'user', content } }; await wait })()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort()
    const query = this.api.query({ prompt, options: { ...this.options(directory), ...(resume ? { resume: id } : { sessionId: id }),
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), abortController: controller, includePartialMessages: true, permissionMode: 'default', canUseTool: permission } })
    let result = false, partial = false
    try { for await (const frame of query) {
      if (frame.type === 'system' && frame.subtype === 'init') await onSession(frame.session_id)
      if (frame.type === 'stream_event' && frame.event?.type === 'content_block_delta' && frame.event.delta?.type === 'text_delta') { partial = true; onText(frame.event.delta.text) }
      if (frame.type === 'assistant') {
        for (const block of frame.message.content || []) { if (block.type === 'text' && !partial) onText(block.text); if (block.type === 'tool_use') onTool(block.name) }
        partial = false
      }
      if (frame.type === 'result') { result = true; if (frame.is_error || frame.subtype !== 'success') throw new Error('Claude Code no completó el turno.'); break }
    }
    if (!result && !signal.aborted) throw new Error('Claude Code cerró antes de confirmar el resultado.')
    } finally { signal.removeEventListener('abort', abort); release(); query.close(); await prompt.return?.() }
  }
}
