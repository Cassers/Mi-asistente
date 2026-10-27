import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { CodexRpc } from './codex-rpc.mjs'
const fixture = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url))
const rpc = t => { const client = new CodexRpc({ cwd: '/tmp', command: process.execPath, args: [fixture], requestTimeoutMs: 1500 }); t.after(() => client.close()); return client }

test('real fake subprocess initializes, correlates concurrent requests and decodes split Unicode without exposing native errors', async t => {
  const client = rpc(t), requests = []
  client.on('request', value => requests.push(value))
  await client.start()
  assert.deepEqual(await Promise.all([client.request('echo', { a: 1 }), client.request('echo', { a: 2 })]), [{ a: 1 }, { a: 2 }])
  const nativeRequest = new Promise(resolve => client.once('request', resolve))
  assert.equal(await client.request('split'), 'español 🙂')
  await nativeRequest
  assert.equal(requests[0].id, 'native-approval')
  client.respond(requests[0].id, { answers: {} })
  await assert.rejects(client.request('error'), error => error.code === -32000 && !/private|TOKEN|sk-/.test(JSON.stringify(error) + error.message))
})
test('timeout and process death reject pending requests; no automatic resend', async t => {
  const client = rpc(t); await client.start(); client.requestTimeoutMs = 25
  await assert.rejects(client.request('never'), /no confirmó/)
  client.requestTimeoutMs = 1500
  await assert.rejects(client.request('crash'), /terminó|entrada/)
  assert.equal(client.pending.size, 0)
})
test('malformed and unbounded stdout fail closed', async t => {
  for (const method of ['invalid','large']) {
    const client = rpc(t); await client.start(); client.maxFrameBytes = 1000
    await assert.rejects(client.request(method), /inválido|tamaño/)
    assert.equal(client.closed, true)
  }
})

test('close after failure still waits for the owned process group and kills a launcher descendant', { skip: process.platform !== 'linux' }, async t => {
  for (const failure of [false, true]) {
    const client = rpc(t); await client.start()
    const { pid } = await client.request('descendant')
    if (failure) await assert.rejects(client.request('invalid'))
    await Promise.all([client.close(), client.close()])
    assert.notEqual(client.child.exitCode ?? client.child.signalCode, null)
    const deadline = Date.now() + 2000
    while (true) {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
      if (!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) break
      assert.ok(Date.now() < deadline, 'owned descendant must not keep running after close')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
})

test('fake subprocess account/config/model handshake needs no thread or inference and strips bridge credentials', async t => {
  const { spawn } = await import('node:child_process')
  const { CodexManager } = await import('./codex-runtime.mjs')
  let environment
  const manager = new CodexManager({ rpc: { command: process.execPath, args: [fixture], requestTimeoutMs: 1500,
    env: { PATH: process.env.PATH, CODEX_HOME: '/native-home', CODEX_THREAD_ID: 'parent', OPENAI_API_KEY: 'fake-native-key', OPENCODE_SERVER_PASSWORD: 'bridge-only', JARVIS_PORT: 'fake' },
    spawnProcess(command, args, options) { environment = options.env; return spawn(command, args, options) } } })
  t.after(() => manager.close())
  assert.equal((await manager.verify('/tmp')).model, 'fake-model')
  assert.equal((await manager.models('/tmp'))[0].id, 'fake-model')
  assert.equal(environment.CODEX_HOME, '/native-home'); assert.equal(environment.OPENAI_API_KEY, 'fake-native-key')
  assert.equal(environment.OPENCODE_SERVER_PASSWORD, undefined); assert.equal(environment.JARVIS_PORT, undefined); assert.equal(environment.CODEX_THREAD_ID, undefined)
  const runtime = await manager.runtime('/tmp')
  assert.equal(runtime.threads.size, 0)
})
