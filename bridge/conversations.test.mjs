import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Conversations } from './conversations.mjs'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'jarvis-conversations-test-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const calls = [], sessions = new Map()
  let next = 0
  const api = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'POST' && path === '/session') {
      const session = { id: `ses_${++next}`, directory: workspace, title: body.title }
      sessions.set(session.id, session); return session
    }
    const id = path.split('/')[2]
    if (method === 'GET' && sessions.has(id)) return sessions.get(id)
    if (method === 'POST' && path.endsWith('/abort')) return true
    if (method === 'DELETE') return sessions.delete(id)
    throw new Error('Unexpected API call')
  }
  return { workspace, calls, sessions, api, registry: new Conversations(api, workspace) }
}

test('saved chat survives a registry restart; disconnect never deletes it', async (t) => {
  const f = await fixture(t)
  const first = await f.registry.open('new', 'owner1')
  await f.registry.release(first.id, 'owner1')
  const again = await new Conversations(f.api, f.workspace).open(undefined, 'owner2')
  assert.equal(again.id, first.id); assert.equal(again.resumed, true)
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.path === '/session').length, 1)
  assert.equal(f.calls.some((c) => c.method === 'DELETE'), false)
  assert.equal((await stat(f.registry.file)).mode & 0o777, 0o600)
})

test('new chat and explicit previous chat selection remain distinct', async (t) => {
  const f = await fixture(t)
  const a = await f.registry.open('new', 'one'); await f.registry.release(a.id, 'one')
  const b = await f.registry.open('new', 'two'); await f.registry.release(b.id, 'two')
  assert.notEqual(a.id, b.id)
  assert.equal((await f.registry.open(a.id, 'three')).id, a.id)
  assert.equal((await f.registry.list()).length, 2)
})

test('unknown IDs and concurrent owners are rejected before sending chat content', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.registry.open('ses_foreign', 'one'), /no pertenece/)
  assert.equal(f.calls.length, 0)
  const chat = await f.registry.open('new', 'one')
  const results = await Promise.allSettled([f.registry.open(chat.id, 'two'), f.registry.open(chat.id, 'three')])
  assert.ok(results.every((r) => r.status === 'rejected'))
  await f.registry.release(chat.id, 'other')
  assert.equal(f.registry.leases.size, 1)
})

test('release completes abort and visual cleanup before reconnect can acquire lease', async (t) => {
  const f = await fixture(t)
  const chat = await f.registry.open('new', 'one')
  let cleaned = false
  const release = f.registry.release(chat.id, 'one', async () => {
    assert.equal(f.calls.at(-1).path, `/session/${chat.id}/abort`)
    await new Promise((r) => setTimeout(r, 10)); cleaned = true
  })
  const acquire = f.registry.open(chat.id, 'two').then((result) => { assert.equal(cleaned, true); return result })
  await release
  assert.equal((await acquire).id, chat.id)
})

test('registered session with a different workspace cannot be resumed or deleted', async (t) => {
  const f = await fixture(t)
  const chat = await f.registry.open('new', 'one'); await f.registry.release(chat.id, 'one')
  f.sessions.get(chat.id).directory = '/tmp/unrelated-project'
  await assert.rejects(f.registry.open(chat.id, 'two'), /otro espacio/)
  assert.equal(f.calls.some((c) => c.method === 'DELETE'), false)
})

test('only the explicit current owner can delete a saved conversation', async (t) => {
  const f = await fixture(t)
  const chat = await f.registry.open('new', 'one')
  await assert.rejects(f.registry.remove(chat.id, 'other'), /no tienes abierta/)
  await f.registry.remove(chat.id, 'one')
  assert.deepEqual(await f.registry.list(), [])
  await assert.rejects(f.registry.open(chat.id, 'one'), /no pertenece/)
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1)
})

test('corrupt registry fails closed and is never overwritten', async (t) => {
  const f = await fixture(t)
  await mkdir(f.registry.dir)
  await writeFile(f.registry.file, '{invalid')
  await assert.rejects(f.registry.open('new', 'one'), /ilegible/)
  assert.equal(await readFile(f.registry.file, 'utf8'), '{invalid')
  assert.equal(f.calls.length, 0)
})
