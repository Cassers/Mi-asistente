import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionEvents } from './session-events.mjs'
import { Permissions } from './permissions.mjs'

test('child permissions reach exactly their parent dialog and keep native one-use approval', async () => {
  const sent = [], replies = [], foreign = []
  const permissions = new Permissions({ session: () => 'root', reply: async (...args) => replies.push(args), publish: rows => sent.push(rows) })
  const dispatch = sessionEvents({ workspace: '/workspace', handlers: new Map([
    ['root', ev => permissions.receive(ev.properties)], ['other', ev => foreign.push(ev)],
  ]), getSession: async id => ({ id, parentID: 'root', directory: '/workspace' }) })
  await dispatch({ type: 'permission.asked', properties: { id: 'permit', sessionID: 'child', permission: 'edit', patterns: ['Agentes/example/PROMPT.md'] } })
  assert.equal(foreign.length, 0)
  assert.equal(replies.length, 0, 'delegation never grants permission by itself')
  assert.equal(sent.at(-1)[0].metadata.subagentSessionID, 'child')
  assert.equal(await permissions.respond('permit', 'once'), true)
  assert.deepEqual(replies, [['permit', 'once']])
})

test('foreign directories, unowned sessions, wrong IDs and cycles cannot reach another chat', async () => {
  for (const getSession of [
    async id => ({ id, parentID: 'root', directory: '/foreign' }),
    async id => ({ id, directory: '/workspace' }),
    async () => ({ id: 'wrong', parentID: 'root', directory: '/workspace' }),
    async id => ({ id, parentID: id, directory: '/workspace' }),
  ]) {
    const events = []
    const dispatch = sessionEvents({ workspace: '/workspace', handlers: new Map([['root', ev => events.push(ev)]]), getSession })
    await dispatch({ type: 'permission.asked', properties: { sessionID: 'child', id: 'p' } })
    assert.equal(events.length, 0)
  }
})

test('child text/idle are ignored; permission event ordering survives slow ownership checks', async () => {
  const events = [], handlers = new Map([['root', ev => events.push(ev)]])
  let reads = 0, finish
  const dispatch = sessionEvents({ workspace: '/workspace', handlers, getSession: async id => {
    reads++
    if (reads === 1) await new Promise(ok => { finish = ok })
    return { id, parentID: 'root', directory: '/workspace' }
  } })
  await dispatch({ type: 'session.idle', properties: { sessionID: 'child' } })
  await dispatch({ type: 'message.part.delta', properties: { sessionID: 'child', delta: 'private internal text' } })
  assert.equal(reads, 0)
  const asking = dispatch({ type: 'permission.asked', properties: { sessionID: 'child' } })
  const replying = dispatch({ type: 'permission.replied', properties: { sessionID: 'child' } })
  await Promise.resolve(); finish()
  await Promise.all([asking, replying])
  assert.deepEqual(events.map(ev => ev.type), ['permission.asked', 'permission.replied'])
  const stale = dispatch({ type: 'permission.asked', properties: { sessionID: 'child' } })
  handlers.delete('root'); await stale
  assert.equal(events.length, 2, 'disconnected owner receives nothing')
})
