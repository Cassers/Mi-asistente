import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, symlink, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Projects, NativeConversations, localServer, nativeClient } from './projects.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-projects-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'project')
  await mkdir(directory)
  const calls = []
  const client = (server, path, credentials) => async (method, route) => {
    calls.push({ server, path, credentials, method, route })
    if (route === '/global/health') return { healthy: true }
    if (route === '/path') return { directory: path }
    throw new Error(`Unexpected native request: ${method} ${route}`)
  }
  const file = join(root, 'state/projects.json')
  return { root, directory, file, calls, projects: new Projects({ file, client, ...options }) }
}

test('local server accepts HTTP loopback only, without credentials, path, query or fragment', () => {
  for (const [value, expected] of [['http://localhost:4097/', 'http://localhost:4097'], ['http://127.0.0.1:4096', 'http://127.0.0.1:4096'], ['http://[::1]:4096/', 'http://[::1]:4096']]) {
    assert.equal(localServer(value), expected)
  }
  for (const value of ['https://localhost:4096', 'http://example.com', 'http://localhost.evil.test', 'http://192.168.1.2', 'http://0.0.0.0:4096', 'http://user:secret@localhost:4096', 'http://localhost:4096/path', 'http://localhost:4096/?x=1', 'http://localhost:4096/#x', 'garbage']) {
    assert.throws(() => localServer(value), /local|inválida/)
  }
})

test('registry canonicalizes symlinks, keeps exact directories distinct, stores no credentials', async t => {
  const f = await fixture(t, { password: 'default-test-secret', username: 'default-test-user' })
  const alias = join(f.root, 'alias')
  await symlink(f.directory, alias)
  const first = await f.projects.open({ directory: alias, password: 'ephemeral-test-secret', username: 'ephemeral-test-user' })
  const again = await f.projects.open({ directory: join(f.directory, '.') })
  assert.equal(first.directory, await realpath(f.directory))
  assert.equal(first.id, again.id)
  const nested = join(f.directory, 'nested')
  await mkdir(nested)
  const second = await f.projects.open({ directory: nested })
  assert.notEqual(first.id, second.id)
  assert.equal((await f.projects.list()).length, 2)
  assert.equal((await f.projects.get(second.id)).directory, nested)
  assert.deepEqual(f.calls[0].credentials, { username: 'ephemeral-test-user', password: 'ephemeral-test-secret' })
  const persisted = await readFile(f.file, 'utf8')
  assert.doesNotMatch(persisted, /secret|password|username|test-user/)
  assert.equal((await stat(f.file)).mode & 0o777, 0o600)
  assert.deepEqual((await new Projects({ file: f.file }).list()).map(p => p.id).sort(), [first.id, second.id].sort())
})

test('invalid paths, unhealthy server and wrong native directory cannot register projects', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'file'), 'not a directory')
  for (const directory of ['relative', '', '/missing-test-project', f.directory + '\0bad', join(f.root, 'file')]) {
    await assert.rejects(f.projects.open({ directory }))
  }
  for (const client of [() => async () => ({ healthy: false }), () => async (_method, route) => route === '/global/health' ? { healthy: true } : { directory: f.root }]) {
    const projects = new Projects({ file: f.file, client })
    await assert.rejects(projects.open({ directory: f.directory }), /disponible|carpeta/)
    assert.deepEqual(await projects.list(), [])
  }
})

test('unreadable registry is preserved and missing canonical directory cannot reconnect', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'state'))
  await writeFile(f.file, '{broken')
  await assert.rejects(f.projects.open({ directory: f.directory }), /ilegible/)
  assert.equal(await readFile(f.file, 'utf8'), '{broken')
  await rm(f.file)
  const projects = new Projects({ file: f.file, client: () => async (_method, route) => route === '/global/health' ? { healthy: true } : { directory: f.directory } })
  const opened = await projects.open({ directory: f.directory })
  await rm(f.directory, { recursive: true })
  await assert.rejects(projects.get(opened.id), /carpeta cambió/)
})

test('native conversations independently verify exact-directory ownership, even with unscoped API', async () => {
  const sessions = [
    { id: 'ses_ours', directory: '/project', time: { updated: 2 } },
    { id: 'ses_child', directory: '/project', parentID: 'ses_ours' },
    { id: 'ses_nested', directory: '/project/nested' },
    { id: 'ses_prefix', directory: '/project-other' },
    { id: 'ses_archived', directory: '/project', time: { updated: 99, archived: 100 } },
  ]
  const mutations = []
  const conversations = new NativeConversations(async (method, route) => {
    if (method !== 'GET') mutations.push([method, route])
    if (new URL(route, 'http://localhost').pathname === '/session') return sessions
    if (route === '/session/status') return {}
    return sessions.find(s => route.endsWith('/' + s.id))
  }, '/project')
  assert.deepEqual((await conversations.list()).map(s => s.id), ['ses_ours'])
  assert.equal((await conversations.open('ses_ours')).id, 'ses_ours')
  for (const id of ['ses_nested', 'ses_prefix']) {
    await assert.rejects(conversations.open(id), /otra carpeta/)
    await assert.rejects(conversations.remove(id), /otra carpeta/)
  }
  await assert.rejects(conversations.open('../ses_ours'), /inválida/)
  assert.deepEqual(mutations, [])
})

for (const directory of ['/tmp/fake project & exact', '/tmp/Proyectos/日本語 🚀/café 100%']) {
test(`native client scopes HTTP query and encoded header: ${directory}`, async t => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://localhost')
    calls.push({ url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.setHeader('content-type', url.pathname === '/event' ? 'text/event-stream' : 'application/json')
    res.end(url.pathname === '/event' ? ': heartbeat\n\n' : JSON.stringify({ directory: url.searchParams.get('directory') }))
  })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const api = nativeClient(`http://127.0.0.1:${server.address().port}`, directory, { username: 'test', password: 'fake-password' })
  assert.equal((await api('GET', '/path')).directory, directory)
  await api('GET', '/session?limit=1000&roots=true')
  await api('POST', '/session', { title: 'Native' })
  await (await api.events(new AbortController().signal)).text()
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('directory'), directory)
    assert.equal(call.headers['x-opencode-directory'], encodeURIComponent(directory))
    assert.equal(decodeURIComponent(call.headers['x-opencode-directory']), directory)
    assert.equal(call.headers.authorization, 'Basic ' + Buffer.from('test:fake-password').toString('base64'))
    assert.equal(call.url.searchParams.has('password'), false)
  }
  assert.equal(calls[1].url.pathname, '/session')
  assert.equal(calls[1].url.searchParams.get('limit'), '1000')
  assert.equal(calls[1].url.searchParams.get('roots'), 'true')
  assert.deepEqual(JSON.parse(calls[2].body), { title: 'Native' })
})
}

test('Codex shares a canonical folder with OpenCode under a separate ID and persists no credentials', async t => {
  const verified = []
  const f = await fixture(t, { codex: { verify: async path => { verified.push(path) } } })
  const openCode = await f.projects.open({ directory: f.directory })
  const alias = join(f.root, 'codex-alias'); await symlink(f.directory, alias)
  const codex = await f.projects.open({ directory: alias, application: 'codex', serverURL: 'https://should-not-be-used.invalid', password: 'do-not-forward' })
  assert.equal(codex.directory, openCode.directory)
  assert.notEqual(codex.id, openCode.id)
  assert.equal(codex.application, 'codex'); assert.equal(codex.serverURL, '')
  assert.deepEqual(verified, [await realpath(f.directory)])
  const saved = await readFile(f.file, 'utf8')
  assert.doesNotMatch(saved, /do-not-forward|password|invalid/)
  const restored = await new Projects({ file: f.file }).list()
  assert.equal(restored.length, 2)
  assert.equal(restored.find(p => p.id === codex.id).application, 'codex')
  assert.throws(() => f.projects.api(codex), /usa Codex/)
})

test('failed Codex verification and unknown applications leave the existing registry intact', async t => {
  const f = await fixture(t, { codex: { verify: async () => { throw Error('Codex no está conectado') } } })
  const previous = await f.projects.open({ directory: f.directory })
  const saved = await readFile(f.file, 'utf8')
  await assert.rejects(f.projects.open({ directory: f.directory, application: 'codex' }), /Codex/)
  await assert.rejects(f.projects.open({ directory: f.directory, application: 'not-an-app' }), /Aplicación/)
  assert.equal(await readFile(f.file, 'utf8'), saved)
  assert.deepEqual((await f.projects.list()).map(p => p.id), [previous.id])
})
