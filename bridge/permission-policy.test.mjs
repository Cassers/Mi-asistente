import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { limitedReadAllowed } from './permission-policy.mjs'
import { Permissions } from './permissions.mjs'

test('limited mode allows exact own configuration reads only, not globs, secrets, traversal or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-limited-permissions-'))
  try {
    await mkdir(join(root, 'workspace/ME'), { recursive: true })
    await writeFile(join(root, 'workspace/ME/CONFIG.json'), '{}')
    await writeFile(join(root, 'outside.json'), '{}')
    const workspace = join(root, 'workspace')
    const read = patterns => limitedReadAllowed({ permission: 'read', patterns }, workspace)
    assert.equal(await read(['ME/CONFIG.json']), true)
    assert.equal(await read([join(workspace, 'ME/CONFIG.json')]), true)
    for (const patterns of [[], ['*'], ['ME/*'], ['ME/../ME/CONFIG.json'], ['.env'], ['ME/OTHER.md'], [join(root, 'outside.json')], ['ME/CONFIG.json', '.env'], [null]]) assert.equal(await read(patterns), false)
    assert.equal(await limitedReadAllowed({ permission: 'edit', patterns: ['ME/CONFIG.json'] }, workspace), false)
    await rm(join(workspace, 'ME/CONFIG.json'))
    await symlink(join(root, 'outside.json'), join(workspace, 'ME/CONFIG.json'))
    assert.equal(await read(['ME/CONFIG.json']), false)
    await rm(join(workspace, 'ME'), { recursive: true })
    await mkdir(join(root, 'other')); await writeFile(join(root, 'other/CONFIG.json'), '{}')
    await symlink(join(root, 'other'), join(workspace, 'ME'))
    assert.equal(await read(['ME/CONFIG.json']), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('manual by default; mode escalation never approves old pending requests or replayed events', async () => {
  const replies = []
  const queue = new Permissions({ session: () => 's', reply: async (...args) => replies.push(args), publish() {} })
  const old = { id: 'old', sessionID: 's', permission: 'bash' }
  queue.receive(old)
  assert.equal(queue.mode, 'manual')
  assert.equal(queue.setMode('total'), false)
  assert.equal(queue.setMode('total', true), true)
  await queue.receive(old)
  assert.deepEqual(replies, [])
  await queue.receive({ ...old, id: 'new' })
  assert.deepEqual(replies, [['new', 'once']])
  assert.equal(queue.autoApproved, 1)
  await queue.receive({ ...old, id: 'foreign', sessionID: 'other' })
  assert.equal(replies.length, 1)
  assert.equal(queue.setMode('always', true), false)
  const fresh = new Permissions({ session: () => 's', reply() {}, publish() {} })
  assert.deepEqual(fresh.snapshot(), { mode: 'manual', autoApproved: 0 })
})

test('returning to Manual and cancellation invalidate slow policy checks', async () => {
  let release
  const replies = []
  const queue = new Permissions({ session: () => 's', reply: async (...args) => replies.push(args), publish() {}, readAllowed: () => new Promise(resolve => { release = resolve }) })
  queue.setMode('limited')
  const job = queue.receive({ id: 'p', sessionID: 's', permission: 'read', patterns: ['ME/CONFIG.json'] })
  queue.setMode('manual')
  release(true); await job
  assert.deepEqual(replies, [])
  assert.equal(queue.pending.has('p'), true)
  queue.setMode('limited')
  const next = queue.receive({ id: 'p2', sessionID: 's', permission: 'read', patterns: ['ME/CONFIG.json'] })
  await queue.rejectAll(); release(true); await next
  assert.ok(replies.every(([, reply]) => reply === 'reject'))
})

test('limited mode delegates read check, leaves edits pending; failed auto approval returns Manual without retries', async () => {
  const modes = [], replies = []
  const queue = new Permissions({ session: () => 's', reply: async (...args) => { replies.push(args); throw Error('offline') },
    publish() {}, publishMode: state => modes.push(state), readAllowed: async req => req.permission === 'read' })
  queue.setMode('limited')
  await queue.receive({ id: 'edit', sessionID: 's', permission: 'edit' })
  assert.equal(replies.length, 0)
  await queue.receive({ id: 'read', sessionID: 's', permission: 'read' })
  assert.equal(queue.mode, 'manual')
  assert.equal(queue.pending.has('read'), true)
  assert.match(modes.at(-1).error, /Manual/)
  await queue.receive({ id: 'read', sessionID: 's', permission: 'read' })
  assert.equal(replies.length, 1)
})
