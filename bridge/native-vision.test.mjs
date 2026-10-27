import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeVision, nativeContinuation, nativeModel, turnInspection } from './native-vision.mjs'

test('vision follows native agent, session and prior model choices without selecting a substitute', async () => {
  for (const [config, agents, session, messages, image] of [
    [{ default_agent: 'teacher', model: 'p/text' }, [{ name: 'teacher', model: { providerID: 'p', modelID: 'vision' } }], {}, [], true],
    [{ model: 'p/vision' }, [], { model: { providerID: 'p', modelID: 'text' } }, [], false],
    [{}, [], {}, [{ info: { role: 'user', model: { providerID: 'p', modelID: 'vision' } } }], true],
    [{ model: 'p/vision' }, [], {}, [], true],
    [{}, [], {}, [], false],
  ]) {
    const calls = []
    const api = async (method, path) => {
      calls.push({ method, path })
      if (path === '/config') return config
      if (path === '/agent') return agents
      if (path === '/provider') return { all: [{ id: 'p', models: { vision: { capabilities: { input: { image: true } } }, text: { capabilities: { input: { image: false } } } } }] }
      return messages
    }
    assert.equal(await nativeVision(api, { id: 'ses_test', ...session }), image)
    assert.ok(calls.every(c => c.method === 'GET'), 'only inspect, no prompt or model config writes')
  }
})

test('continuing native chat retains plan agent, model and reasoning; new chat inherits project defaults', async () => {
  assert.deepEqual(await nativeContinuation(async () => [], { id: 'ses_empty' }), {})
  const choices = await nativeContinuation(async () => [
    { info: { role: 'user', agent: 'build', model: { providerID: 'p', modelID: 'old' } } },
    { info: { role: 'user', agent: 'plan', model: { providerID: 'p', modelID: 'chosen' }, variant: 'high' } },
    { info: { role: 'assistant' } },
  ], { id: 'ses_chat' })
  assert.deepEqual(choices, { agent: 'plan', model: { providerID: 'p', modelID: 'chosen' }, variant: 'high' })
  const modern = await nativeContinuation(async () => [{ info: { role: 'user', agent: 'plan', model: { providerID: 'p', id: 'chosen', variant: 'max' } } }], { id: 'ses_chat', model: { providerID: 'p', id: 'saved', variant: 'medium' } })
  assert.deepEqual(modern, { agent: 'plan', model: { providerID: 'p', modelID: 'saved' }, variant: 'medium' })
})

test('one turn shares native inspection for continuation, vision and audio; next turn reads fresh data', async () => {
  const calls = [], session = { id: 'ses_inspection' }
  let chosen = 'first'
  const api = async (method, path) => {
    calls.push([method, path])
    if (path === '/config') return { default_agent: 'teacher' }
    if (path === '/agent') return [{ name: 'teacher' }]
    if (path === '/provider') return { all: [{ id: 'p', models: { first: { capabilities: { input: { image: true, audio: true } } }, second: { capabilities: { input: { image: false } } } } }] }
    return [{ info: { role: 'user', agent: 'teacher', model: { providerID: 'p', modelID: chosen } } }]
  }
  const inspect = turnInspection(api)
  const continuation = await nativeContinuation(inspect, session)
  const [vision, audioModel] = await Promise.all([nativeVision(inspect, session, continuation), nativeModel(inspect, session, continuation)])
  assert.equal(vision, true); assert.equal(audioModel.modelID, 'first')
  for (const path of ['/config', '/agent', '/provider', '/session/ses_inspection/message']) assert.equal(calls.filter(c => c[1] === path).length, 1, path)
  chosen = 'second'
  const next = turnInspection(api)
  assert.equal((await nativeContinuation(next, session)).model.modelID, 'second')
  assert.equal(await nativeVision(next, session), false)
  assert.equal(calls.filter(c => c[1] === '/provider').length, 2)
})

test('inspection cache never memoizes session checks, statuses, writes or explicit request options', async () => {
  const calls = []
  const api = async (...args) => { calls.push(args); return calls.length }
  const inspect = turnInspection(api)
  for (const [method, path, ...args] of [['GET', '/session/ses_test'], ['GET', '/session/status'], ['POST', '/session/ses_test/abort', {}], ['GET', '/provider', undefined, { signal: AbortSignal.timeout(1000) }]]) {
    const before = calls.length
    await inspect(method, path, ...args); await inspect(method, path, ...args)
    assert.equal(calls.length - before, 2, path)
  }
})
