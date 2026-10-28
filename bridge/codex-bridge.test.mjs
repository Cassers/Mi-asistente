import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachCodexClient } from './codex-bridge.mjs'
import { fixture, FakeSocket, flush, until } from './codex-test-fixture.mjs'
const recorder = { snapshot: () => ({ active: false }), setActive: async () => {} }
const connect = async (f, socket = new FakeSocket(), extra = {}) => {
  const queued = [], buffer = raw => queued.push(raw)
  socket.on('message', buffer)
  const attached = await attachCodexClient(socket, { project: { directory: f.directory, name: 'Fixture', application: 'codex' }, manager: f.manager, recorder, query: new URLSearchParams({ session: 'thr-a' }), queued, buffer, ...extra })
  return { socket, ...attached }
}
test('default connections share a native empty thread through reconnect, while explicit new remains distinct', async t => {
  const f = await fixture(t), implicit = { query: new URLSearchParams() }
  const [a,b] = await Promise.all([connect(f, new FakeSocket(), implicit), connect(f, new FakeSocket(), implicit)])
  assert.equal(a.state, b.state)
  assert.deepEqual(a.socket.frames.find(frame => frame.type === 'ready').conversation.turns, [])
  a.socket.close(); b.socket.close()
  const next = await connect(f, new FakeSocket(), implicit)
  assert.equal(next.state, a.state)
  assert.equal(f.rpc.calls.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(f.rpc.calls.some(c => ['thread/resume','thread/turns/list'].includes(c.method)), false)
  next.socket.message({ type: 'ask', id: 'first', text: 'first user message', audioMode: 'transcript' })
  await until(() => f.rpc.calls.some(c => c.method === 'turn/start'))
  assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  const explicit = await connect(f, new FakeSocket(), { query: new URLSearchParams({ session: 'new' }) })
  assert.notEqual(explicit.state, next.state)
})

test('ready failure after native thread creation reuses the default without retrying a prompt', async t => {
  const f = await fixture(t), implicit = { query: new URLSearchParams() }
  f.rpc.handlers.set('thread/list', () => { throw new Error('Temporary list failure') })
  const first = await connect(f, new FakeSocket(), implicit)
  assert.equal(first.socket.readyState, 3)
  f.rpc.handlers.delete('thread/list')
  const next = await connect(f, new FakeSocket(), implicit)
  assert.ok(next.socket.frames.some(frame => frame.type === 'ready'))
  assert.equal(f.rpc.calls.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(f.rpc.calls.some(c => c.method === 'turn/start'), false)
})

test('router buffer drains exactly once after ready, detach leaves native work, reattach observes completion', async t => {
  const f = await fixture(t), socket = new FakeSocket()
  const queued = [JSON.stringify({ type: 'ask', id: 'ask-buffered', text: 'hola', audioMode: 'transcript' })]
  const buffer = raw => queued.push(raw); socket.on('message', buffer)
  const attached = await connect(f, socket, { queued, buffer })
  await until(() => f.rpc.calls.some(c => c.method === 'turn/start'))
  assert.equal(queued.length, 0)
  assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  assert.ok(socket.frames.findIndex(frame => frame.type === 'ready') < socket.frames.findIndex(frame => frame.type === 'submitted'))
  const turnId = attached.state.liveTurn
  socket.close()
  assert.equal(f.rpc.calls.filter(c => c.method === 'turn/interrupt').length, 0)
  const next = await connect(f)
  assert.equal(next.state, attached.state)
  assert.equal(next.socket.frames.find(frame => frame.type === 'ready').conversation.busy, true)
  f.rpc.event('item/agentMessage/delta', { threadId: attached.state.id, turnId, itemId: 'answer', delta: 'continúa' })
  f.rpc.event('turn/completed', { threadId: attached.state.id, turn: { id: turnId, status: 'completed', items: [] } })
  assert.equal(next.socket.frames.find(frame => frame.type === 'done').ask, 'ask-buffered')
  assert.equal(next.socket.frames.find(frame => frame.type === 'done').text, 'continúa')
  assert.doesNotMatch(JSON.stringify(next.socket.frames), /sk-private|private@example|SECRET/)
})
test('WS input cancellation answers native id; archive is recoverable and hard audio errors are visible', async t => {
  const f = await fixture(t), { socket, state } = await connect(f)
  socket.message({ type: 'ask', id: 'direct', text: 'audio', audioMode: 'direct', audio: { mime: 'audio/wav', data: 'bad' } })
  await flush()
  assert.match(socket.frames.find(frame => frame.type === 'error').message, /solo dictado/)
  f.rpc.server('item/tool/requestUserInput', 91, { threadId: state.id, turnId: 'native-turn', itemId: 'question', questions: [{ id: 'q' }] })
  await flush()
  socket.message({ type: 'user_input', id: [...state.ordinary.keys()][0], answers: {} })
  await flush()
  assert.deepEqual(f.rpc.replies.at(-1), { id: 91, result: { answers: {} } })
  socket.message({ type: 'session_delete', id: state.id })
  await until(() => socket.frames.some(frame => frame.type === 'session_deleted' || frame.type === 'session_error'))
  assert.ok(socket.frames.some(frame => frame.type === 'session_deleted' && frame.archived && frame.recoverable))
  assert.ok(f.rpc.calls.some(c => c.method === 'thread/archive'))
})

 test('pre-submit validation errors reach error handler before any done can discard the failure', async t => {
  const f = await fixture(t), { socket } = await connect(f)
  socket.message({ type: 'ask', id: 'bad-model', text: 'hola', model: 'missing', audioMode: 'transcript' })
  await until(() => socket.frames.some(frame => frame.type === 'error'))
  assert.match(socket.frames.find(frame => frame.type === 'error').message, /catálogo/)
  assert.equal(socket.frames.some(frame => frame.type === 'done'), false)
  assert.equal(f.rpc.calls.some(call => call.method === 'turn/start'), false)
})

test('Codex boundary advertises transcript-only and rejects direct, preserveOnly and attached-audio bypasses', async t => {
  const f = await fixture(t), { socket } = await connect(f)
  const ready = socket.frames.find(frame => frame.type === 'ready')
  assert.equal(ready.capabilities.directAudio, false); assert.equal(ready.capabilities.transcriptOnly, true)
  for (const patch of [{ audioMode: 'direct' }, { preserveOnly: true }, { audioMode: 'transcript', audio: { mime: 'audio/wav', data: 'old-prefix' } }]) {
    socket.message({ type: 'ask', id: 'blocked', text: 'old caption', ...patch }); await flush()
  }
  assert.equal(f.rpc.calls.some(call => ['thread/inject_items', 'turn/start'].includes(call.method)), false)
  assert.equal(socket.frames.filter(frame => frame.type === 'error').length, 3)
  socket.message({ type: 'ask', id: 'text', text: 'Fresh intentional text', audioMode: 'transcript' }); await flush()
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1)
})
