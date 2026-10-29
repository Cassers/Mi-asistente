import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, flush } from './codex-test-fixture.mjs'

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] })
const agent = (id, text) => ({ id, type: 'agentMessage', text })
const ask = (text = 'mensaje') => ({ type: 'ask', id: 'ask-1', text, audioMode: 'transcript' })

test('fresh native thread skips unavailable history/resume; first turn materializes and reconnect hydrates the same id', async t => {
  const f = await fixture(t), state = await f.runtime.open('new')
  assert.deepEqual(f.runtime.transcript(state), [])
  assert.equal(state.historyAvailable, false)
  assert.equal(await f.runtime.open(state.id), state)
  await f.runtime.hydrate(state)
  assert.equal(f.rpc.calls.some(c => ['thread/resume','thread/turns/list'].includes(c.method)), false)
  await f.runtime.interrupt(state)
  await f.runtime.ask(state, ask('first'))
  const turnId = state.liveTurn
  f.rpc.history.set(state.id, [{ id: turnId, items: [user('first-user','first'), agent('first-agent','answer')] }])
  f.rpc.threads.get(state.id).status = { type: 'idle' }
  f.rpc.event('turn/completed', { threadId: state.id, turn: { id: turnId, status: 'completed', items: [] } })
  assert.equal(await f.runtime.open(state.id), state)
  assert.equal(f.runtime.transcript(state)[1].text, 'answer')
  await f.runtime.ask(state, ask('second'))
  assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 2)
  assert.equal(f.rpc.calls.filter(c => c.method === 'thread/start').length, 1)
})

test('empty thread trust is process-local and cannot bypass native cwd checks or replace a lost stored id', async t => {
  const f = await fixture(t), state = await f.runtime.open('new')
  f.rpc.threads.get(state.id).cwd = '/tmp'
  await assert.rejects(f.runtime.open(state.id), /carpeta/)
  await assert.rejects(f.runtime.ask(state, ask()), /carpeta/)
  f.rpc.threads.get(state.id).cwd = f.directory
  f.rpc.closed = true; f.rpc.emit('closed')
  const replacement = await f.manager.runtime(f.directory), rpc = f.transports[1]
  rpc.threads.set(state.id, rpc.thread(state.id)); rpc.unmaterialized.add(state.id)
  await assert.rejects(replacement.open(state.id), /rollout/)
  await assert.rejects(replacement.open(state.id), /rollout/)
  assert.equal(rpc.calls.filter(c => c.method === 'thread/read').length, 2)
  assert.equal(rpc.calls.some(c => ['thread/start','turn/start','thread/turns/list'].includes(c.method)), false)
  assert.equal(replacement.threads.has(state.id), false)
})

test('native start/resume must return an absolute matching cwd and the requested id before gaining local trust', async t => {
  const f = await fixture(t)
  for (const patch of [{ cwd: '.' }, { cwd: '/tmp' }, { parentThreadId: 'parent' }, { id: null }]) {
    f.rpc.handlers.set('thread/start', () => ({ thread: f.rpc.thread('invalid', patch) }))
    await assert.rejects(f.runtime.open('new'), /fuera/)
  }
  f.rpc.handlers.set('thread/resume', () => ({ thread: f.rpc.thread('thr-b') }))
  await assert.rejects(f.runtime.open('thr-a'), /fuera/)
  assert.equal(f.runtime.threads.size, 0)
})

test('default opens coalesce across initial/repeated connections; explicit new stays explicit', async t => {
  const f = await fixture(t)
  const [a,b] = await Promise.all([f.runtime.open(), f.runtime.open()])
  assert.equal(a, b); assert.equal(await f.runtime.open(), a)
  assert.equal(f.rpc.calls.filter(c => c.method === 'thread/start').length, 1)
  assert.notEqual(await f.runtime.open('new'), a)
})

test('ephemeral native-created metadata keeps its in-memory transcript without requesting unsupported history', async t => {
  const f = await fixture(t)
  f.rpc.handlers.set('thread/start', () => {
    const thread = f.rpc.thread('ephemeral', { ephemeral: true })
    f.rpc.threads.set(thread.id, thread); f.rpc.unmaterialized.add(thread.id)
    return { thread }
  })
  const state = await f.runtime.open('new')
  await f.runtime.ask(state, ask('ephemeral user'))
  const turnId = state.liveTurn
  f.rpc.event('item/completed', { threadId: state.id, turnId, item: user('u', 'ephemeral user') })
  f.rpc.event('turn/completed', { threadId: state.id, turn: { id: turnId, status: 'completed', items: [agent('a', 'ephemeral answer')] } })
  f.rpc.threads.get(state.id).status = { type: 'idle' }
  assert.equal(await f.runtime.open(state.id), state)
  assert.deepEqual(f.runtime.transcript(state).map(row => row.text), ['ephemeral user', 'ephemeral answer'])
  assert.equal(f.rpc.calls.some(c => ['thread/resume','thread/turns/list'].includes(c.method)), false)
})

test('manager caches canonical cwd, verifies metadata without turns/secrets and paginates native models with costs/efforts', async t => {
  const f = await fixture(t)
  await symlink(f.directory, join(f.directory, 'alias'))
  assert.equal(await f.manager.runtime(join(f.directory, 'alias')), f.runtime)
  const verified = await f.manager.verify(f.directory)
  assert.equal(verified.authenticated, true)
  assert.doesNotMatch(JSON.stringify(verified), /private|secret|api_key|mcp_servers/)
  assert.ok(f.rpc.calls.every(c => !/^(thread|turn)\//.test(c.method)))
  const models = await f.manager.models(f.directory)
  assert.deepEqual(models.map(m => m.id), ['codex-text','codex-image'])
  assert.deepEqual(models[0].variants, ['medium','ultra'])
  assert.deepEqual(models[0].cost, { input: null, output: null })
  assert.equal(models[1].image, true); assert.equal(models[1].audio, true)
  assert.equal(f.rpc.started, 1)
  f.rpc.handlers.set('account/read', () => ({ account: null, requiresOpenaiAuth: true }))
  await assert.rejects(f.manager.verify(f.directory), /codex login/)
  f.rpc.handlers.set('account/read', () => ({ account: null, requiresOpenaiAuth: false }))
  assert.equal((await f.manager.verify(f.directory)).authenticated, false)
})

test('thread list excludes foreign/child/archived metadata and resume/archive check membership before native action', async t => {
  const f = await fixture(t)
  f.rpc.threads.set('child', f.rpc.thread('child', { parentThreadId: 'thr-a' }))
  f.rpc.threads.set('foreign', f.rpc.thread('foreign', { cwd: '/tmp' }))
  f.rpc.threads.set('archived', f.rpc.thread('archived', { archived: true }))
  assert.deepEqual((await f.runtime.list()).map(row => row.id), ['thr-a','thr-b'])
  await assert.rejects(f.runtime.open('foreign'), /carpeta/)
  await assert.rejects(f.runtime.open('child'), /subagente/)
  assert.equal(f.rpc.calls.filter(c => c.method === 'thread/resume').length, 0)
  const state = await f.runtime.open('thr-a')
  assert.deepEqual(f.rpc.calls.find(c => c.method === 'thread/resume').params, { threadId: 'thr-a', excludeTurns: true })
  await f.runtime.archive(state)
  assert.ok(f.rpc.calls.some(c => c.method === 'thread/archive'))
  assert.ok(!f.rpc.calls.some(c => c.method === 'thread/delete'))
})

test('full paginated history preserves stable ids, deduplicates anchors and refreshes cached final text', async t => {
  const f = await fixture(t)
  f.rpc.history.set('thr-a', [
    { id: 'turn-old', itemsView: 'full', items: [user('u1','pregunta'), agent('a1','respuesta')] },
    { id: 'turn-last', itemsView: 'full', items: [agent('a1','respuesta completa'), user('u2','segunda')] },
  ])
  const state = await f.runtime.open('thr-a')
  assert.deepEqual(f.runtime.transcript(state).map(row => row.id), ['thr-a:u1','thr-a:a1','thr-a:u2'])
  assert.equal(f.runtime.transcript(state)[1].text, 'respuesta completa')
  f.rpc.history.get('thr-a')[1].items[0].text = 'respuesta corregida'
  await f.runtime.hydrate(state)
  assert.equal(f.runtime.transcript(state)[1].text, 'respuesta corregida')
})

test('text keeps native configuration; explicit model/effort validated, invalid direct/preserveOnly inputs rejected before turns', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  for (const patch of [{ audioMode: 'direct' }, { preserveOnly: true }, { audioMode: 'clip', audio: { data: 'bad' } }]) await assert.rejects(f.runtime.ask(state, { ...ask(), ...patch }), /clip|Audio directo/i)
  await assert.rejects(f.runtime.ask(state, { ...ask(), model: 'not-native' }), /catálogo/)
  await assert.rejects(f.runtime.ask(state, { ...ask(), model: 'codex-text', variant: 'made-up' }), /pensamiento/)
  await f.runtime.ask(state, ask())
  const params = f.rpc.calls.find(c => c.method === 'turn/start').params
  for (const key of ['cwd','model','effort','approvalPolicy','sandboxPolicy','baseInstructions','developerInstructions']) assert.equal(Object.hasOwn(params,key), false)
  assert.deepEqual(params.input, [{ type: 'text', text: 'mensaje', text_elements: [] }])
  await f.runtime.interrupt(state)
  await f.runtime.ask(state, { ...ask(), model: 'codex-text', variant: 'ultra' })
  assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').at(-1).params.effort, 'ultra')
})

test('streaming correlates turn/item ids and reconciles final agent text without duplicating speech', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, frame => frames.push(frame))
  await f.runtime.ask(state, ask())
  const turnId = state.liveTurn
  f.rpc.event('item/agentMessage/delta', { threadId: 'thr-b', turnId, itemId: 'wrong', delta: 'NO' })
  f.rpc.event('item/agentMessage/delta', { threadId: state.id, turnId: 'wrong-turn', itemId: 'wrong', delta: 'NO' })
  f.rpc.event('item/agentMessage/delta', { threadId: state.id, turnId, itemId: 'a', delta: 'Hola' })
  f.rpc.event('item/completed', { threadId: state.id, turnId, item: agent('a','Hola mundo') })
  f.rpc.event('turn/completed', { threadId: state.id, turn: { id: turnId, status: 'completed', items: [agent('a','Hola mundo')] } })
  assert.equal(frames.filter(frame => frame.type === 'text').map(frame => frame.delta).join(''), 'Hola mundo')
  assert.equal(frames.filter(frame => frame.type === 'done').length, 1)
  assert.equal(frames.find(frame => frame.type === 'done').text, 'Hola mundo')
})

test('RPC notifications preceding turn/start response are correlated after acceptance', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, frame => frames.push(frame))
  f.rpc.handlers.set('turn/start', () => {
    f.rpc.event('turn/started', { threadId: state.id, turn: { id: 'fast-turn' } })
    f.rpc.event('item/agentMessage/delta', { threadId: state.id, turnId: 'fast-turn', itemId: 'fast-item', delta: 'rápido' })
    f.rpc.event('turn/completed', { threadId: state.id, turn: { id: 'fast-turn', status: 'completed', items: [] } })
    return { turn: { id: 'fast-turn' } }
  })
  await f.runtime.ask(state, ask())
  assert.equal(frames.find(frame => frame.type === 'done').text, 'rápido')
  assert.equal(state.op, null)
})

test('runtime owns approvals over detach; same native IDs, manual reset, input cancellation and MCP decline never hang', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  const detach = f.runtime.subscribe(state, frame => frames.push(frame))
  await f.runtime.ask(state, ask())
  const p = { threadId: state.id, turnId: state.liveTurn, itemId: 'cmd-1' }
  f.rpc.server('item/commandExecution/requestApproval', 17, { ...p, command: 'echo hi' })
  await flush()
  const permission = [...state.policy.pending.keys()][0]
  detach()
  assert.equal(f.rpc.replies.length, 0)
  assert.equal(state.policy.pending.size, 1)
  f.runtime.subscribe(state, frame => frames.push(frame))
  await state.policy.respond(permission, 'once')
  assert.deepEqual(f.rpc.replies.at(-1), { id: 17, result: { decision: 'accept' } })
  state.policy.setMode('total', true)
  f.rpc.server('item/tool/requestUserInput', 'secret', { ...p, questions: [{ id: 'q', isSecret: true, question: 'secret' }] })
  await flush()
  assert.equal(f.rpc.replies.length, 1, 'total must not answer user or secret questions')
  const input = [...state.ordinary.keys()][0]
  f.runtime.answerInput(state, input, {})
  assert.deepEqual(f.rpc.replies.at(-1), { id: 'secret', result: { answers: {} } })
  f.rpc.server('mcpServer/elicitation/request', 'mcp', { threadId: state.id, turnId: null, serverName: 'fixture-mcp', mode: 'form', message: 'consent' })
  await flush()
  assert.deepEqual(f.rpc.replies.at(-1), { id: 'mcp', result: { action: 'decline', content: null, _meta: null } })
  assert.equal(state.ordinary.size, 0)
  assert.ok(frames.some(frame => frame.type === 'status_error' && /MCP/.test(frame.message)))
  f.rpc.server('item/tool/call', 'unsupported', p)
  await flush(); assert.ok(f.rpc.rejected.includes('unsupported'))
})

test('native busy guard and explicit stop wait for completion rather than RPC acknowledgement', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  f.rpc.threads.get(state.id).status = { type: 'active' }
  await assert.rejects(f.runtime.ask(state, ask()), /otro cliente/)
  f.rpc.threads.get(state.id).status = { type: 'idle' }
  await f.runtime.ask(state, ask())
  f.rpc.handlers.set('turn/interrupt', () => ({}))
  await assert.rejects(f.runtime.interrupt(state), /no confirmó/)
  assert.ok(state.liveTurn, 'RPC acceptance cannot mark the native turn idle')
  assert.ok(state.op)
})

test('screens are capability-gated and mapped to native image input without replacing instructions', async t => {
  const screens = []
  const f = await fixture(t, { autoScreen: true, screen: async (text, options) => { screens.push(text); options.onState('attached'); return { parts: [{ type: 'file', url: 'data:image/png;base64,AA==' }], context: 'captura actual' } } })
  const state = await f.runtime.open('thr-a')
  await f.runtime.ask(state, ask()); assert.equal(screens.length, 0)
  await f.runtime.interrupt(state)
  await f.runtime.ask(state, { ...ask(), model: 'codex-image' })
  const params = f.rpc.calls.filter(c => c.method === 'turn/start').at(-1).params
  assert.equal(screens.length, 1); assert.deepEqual(params.input[1], { type: 'image', url: 'data:image/png;base64,AA==' })
  assert.equal(params.developerInstructions, undefined)
})

test('crashed cached transport is evicted; reconnect resumes native ID and never replays an inference', async t => {
  const f = await fixture(t)
  await f.runtime.open('thr-a')
  f.rpc.closed = true; f.rpc.emit('closed')
  const replacement = await f.manager.runtime(f.directory)
  assert.notEqual(replacement, f.runtime)
  assert.equal(f.transports.length, 2)
  await replacement.open('thr-a')
  assert.equal(f.transports[1].calls.filter(c => c.method === 'thread/resume').length, 1)
  assert.equal(f.transports[1].calls.filter(c => c.method === 'turn/start').length, 0)
  f.rpc.emit('closed')
  assert.equal(await f.manager.runtime(f.directory), replacement, 'old closure cannot evict replacement')
})

test('native request capabilities isolate runtime, thread and RPC id type; stale ids cannot authorize a new runtime', async t => {
  const old = await fixture(t), current = await fixture(t)
  const oldState = await old.runtime.open('thr-a'), state = await current.runtime.open('thr-a')
  const request = { threadId: 'thr-a', turnId: 'native-turn', itemId: 'command', command: 'echo approval' }
  old.rpc.server('item/commandExecution/requestApproval', 17, request)
  current.rpc.server('item/commandExecution/requestApproval', 17, request)
  await flush()
  const oldId = [...oldState.policy.pending.keys()][0], currentId = [...state.policy.pending.keys()][0]
  assert.ok(oldId); assert.ok(currentId)
  assert.notEqual(oldId, currentId)
  assert.equal(await state.policy.respond(oldId, 'once'), false)
  await assert.rejects(current.runtime.answerApproval(state, oldId, 'once'), /otra conversación/)
  assert.equal(current.rpc.replies.length, 0, 'a stale client id must never approve reused RPC number 17')
  assert.equal(state.policy.pending.size, 1)

  current.rpc.server('item/tool/requestUserInput', '17', { ...request, questions: [{ id: 'q' }] })
  await flush()
  const stringId = [...state.ordinary.keys()][0]
  assert.notEqual(stringId, currentId, 'string and numeric RPC IDs are distinct')
  assert.notEqual(current.runtime.requestKey('thr-b', 17), currentId, 'the native thread is part of the capability')
  current.rpc.event('serverRequest/resolved', { threadId: state.id, requestId: '17' })
  assert.equal(state.ordinary.size, 0)
  assert.equal(state.policy.pending.size, 1, 'resolving string 17 cannot resolve numeric 17')

  await state.policy.respond(currentId, 'once')
  assert.deepEqual(current.rpc.replies, [{ id: 17, result: { decision: 'accept' } }])
  old.rpc.event('serverRequest/resolved', { threadId: oldState.id, requestId: 17 })
  assert.equal(oldState.policy.pending.size, 0)
  assert.equal(old.runtime.requests.has(oldId), false)
})


test('explicit screen opt-in overrides launcher off and attaches a fresh image to each native turn', async t => {
  let captures = 0
  const f = await fixture(t, { autoScreen: false, screen: async (text, options) => {
    options.onState('attached')
    return { parts: [{ type: 'file', url: 'data:image/png;base64,' + Buffer.from('fixture-' + ++captures).toString('base64') }], context: 'captura actual' }
  } })
  const state = await f.runtime.open('thr-a')
  for (const screen of [true, true, false]) {
    await f.runtime.ask(state, { ...ask(), model: 'codex-image', screen })
    const params = f.rpc.calls.filter(c => c.method === 'turn/start').at(-1).params
    assert.equal(params.input.filter(part => part.type === 'image').length, screen ? 1 : 0)
    if (screen) assert.equal(Buffer.from(params.input.find(part => part.type === 'image').url.split(',')[1], 'base64').toString(), 'fixture-' + captures)
    assert.equal(params.developerInstructions, undefined)
    await f.runtime.interrupt(state)
  }
  assert.equal(captures, 2)
  await f.runtime.ask(state, { ...ask(), model: 'codex-text', screen: true })
  assert.equal(captures, 2, 'text-only models must never trigger capture')
})
