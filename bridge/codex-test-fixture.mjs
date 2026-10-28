import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexManager } from './codex-runtime.mjs'

export class FakeCodex extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; this.calls = []; this.replies = []; this.rejected = []; this.sequence = 0; this.closed = false
    this.threads = new Map([['thr-a', this.thread('thr-a')], ['thr-b', this.thread('thr-b')]])
    this.history = new Map(); this.handlers = new Map(); this.unmaterialized = new Set()
  }
  thread(id, patch = {}) { return { id, cwd: this.directory, name: id, model: 'codex-text', status: { type: 'idle' }, updatedAt: 10, ...patch } }
  async start() { this.started = (this.started || 0) + 1; return { userAgent: 'mi_asistente/0.159.0' } }
  async close() { this.closed = true; this.emit('closed') }
  respond(id, result) { this.replies.push({ id, result }) }
  reject(id) { this.rejected.push(id) }
  event(method, params) { this.emit('notification', { method, params }) }
  server(method, id, params) { this.emit('request', { method, id, params }) }
  async request(method, params = {}) {
    this.calls.push({ method, params })
    if (this.handlers.has(method)) return this.handlers.get(method)(params)
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.com' }, requiresOpenaiAuth: true }
    if (method === 'config/read') return { config: { model: 'codex-text', api_key: 'sk-private-secret', mcp_servers: { private: { env: { SECRET: 'never-forward-this' } } } } }
    if (method === 'model/list') return params.cursor ? { data: [{ model: 'codex-image', displayName: 'Vision', inputModalities: ['text','image','audio'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }
      : { data: [{ model: 'codex-text', displayName: 'Text', inputModalities: ['text'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] }], nextCursor: 'model-page-2' }
    if (method === 'thread/read') return { thread: this.threads.get(params.threadId) }
    if (method === 'thread/resume') {
      if (this.unmaterialized.has(params.threadId)) throw Object.assign(new Error('No rollout found.'), { code: -32600 })
      return { thread: this.threads.get(params.threadId), model: 'codex-text' }
    }
    if (method === 'thread/start') { const thread = this.thread('thr-new-' + ++this.sequence); this.threads.set(thread.id, thread); this.unmaterialized.add(thread.id); return { thread, model: 'codex-text' } }
    if (method === 'thread/list') return params.cursor ? { data: [...this.threads.values()].slice(1), nextCursor: null } : { data: [...this.threads.values()].slice(0,1), nextCursor: this.threads.size > 1 ? 'threads-page-2' : null }
    if (method === 'thread/turns/list') {
      if (this.unmaterialized.has(params.threadId)) throw Object.assign(new Error('Thread not materialized before first user message.'), { code: -32600 })
      const rows = this.history.get(params.threadId) || []
      return params.cursor ? { data: rows.slice(1), nextCursor: null } : { data: rows.slice(0,1), nextCursor: rows.length > 1 ? 'turns-page-2' : null }
    }
    if (method === 'thread/items/list') return { data: [], nextCursor: null }
    if (method === 'thread/archive') { this.threads.delete(params.threadId); return {} }
    if (method === 'thread/inject_items') { this.unmaterialized.delete(params.threadId); return {} }
    if (method === 'turn/start') {
      this.unmaterialized.delete(params.threadId)
      const turn = { id: 'turn-' + ++this.sequence, status: 'inProgress', items: [] }
      this.threads.get(params.threadId).status = { type: 'active' }
      return { turn }
    }
    if (method === 'turn/interrupt') {
      this.threads.get(params.threadId).status = { type: 'idle' }
      this.event('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } })
      return {}
    }
    throw new Error('Unexpected fake method: ' + method)
  }
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'))
  const transports = []
  const manager = new CodexManager({ autoScreen: false, stopTimeoutMs: 30, ...options, transportFactory: path => { const rpc = new FakeCodex(path); transports.push(rpc); return rpc } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  const runtime = await manager.runtime(directory)
  return { directory, manager, runtime, rpc: transports[0], transports }
}
export class FakeSocket extends EventEmitter {
  OPEN = 1; readyState = 1; frames = []
  send(raw) { this.frames.push(JSON.parse(raw)) }
  close() { this.readyState = 3; this.emit('close') }
  message(value) { this.emit('message', JSON.stringify(value)) }
}
export const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(setImmediate) }

export async function until(predicate) {
  const deadline = Date.now() + 2500
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fake contract event did not arrive'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
