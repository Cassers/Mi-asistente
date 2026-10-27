import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ROOT } from './setup.mjs'
import { launchPlan, start } from './start-project.mjs'

test('native launch preserves account/global context and merges the audio plugin only at runtime', () => {
  const base = { PATH: '/bin', HOME: '/example/home', XDG_CONFIG_HOME: '/example/config',
    XDG_DATA_HOME: '/example/data', CODEX_HOME: '/example/codex', OPENCODE_CONFIG: '/example/native.json',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'chosen/model', plugin: ['existing-plugin'] }) }
  const { env, ports, external } = launchPlan(base)
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'OPENCODE_CONFIG']) assert.equal(env[key], base[key])
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config.model, 'chosen/model')
  assert.deepEqual(config.plugin, ['existing-plugin', pathToFileURL(join(ROOT, 'bridge/opencode-audio-plugin.mjs')).href])
  assert.equal(base.OPENCODE_CONFIG_CONTENT.includes('opencode-audio-plugin'), false)
  assert.equal(launchPlan(env).external, true)
  assert.deepEqual(ports, [4097, 8787, 5173]); assert.equal(external, false)
  assert.equal(env.JARVIS_RECORDING, '0'); assert.equal(env.JARVIS_AUTO_SCREEN, '0')
  assert.equal(env.VITE_BACKEND, 'bridge'); assert.equal(env.VITE_BRIDGE_URL, 'ws://127.0.0.1:8787')
  assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 40)
})

test('explicit external server is retained without changing its credentials or injecting config', () => {
  const base = { OPENCODE_URL: 'http://127.0.0.1:4107', OPENCODE_SERVER_PASSWORD: 'fixture-only',
    OPENCODE_CONFIG_CONTENT: '{"plugin":["owner-plugin"]}', PORT: '5191', JARVIS_BRIDGE_PORT: '8799' }
  const plan = launchPlan(base)
  assert.equal(plan.external, true); assert.deepEqual(plan.ports, [8799, 5191])
  assert.equal(plan.env.OPENCODE_CONFIG_CONTENT, base.OPENCODE_CONFIG_CONTENT)
  assert.equal(plan.env.OPENCODE_SERVER_PASSWORD, 'fixture-only')
  assert.equal(plan.env.JARVIS_ALLOWED_ORIGINS, 'http://localhost:5191,http://127.0.0.1:5191')
  assert.throws(() => launchPlan({ OPENCODE_URL: 'https://example.com' }), /local/)
  assert.throws(() => launchPlan({ PORT: '8787' }), /puertos/)
  assert.throws(() => launchPlan({ OC_PORT: 'NaN' }), /puertos/)
  assert.throws(() => launchPlan({ OPENCODE_CONFIG_CONTENT: '[]' }), /inválida/)
})

test('native launcher starts owned OpenCode with native cwd, then project bridge and Vite without a shell', async () => {
  const calls = [], children = [], checks = []
  const instance = await start({ root: ROOT, base: { PATH: process.env.PATH, JARVIS_OC_DIRECTORY: '/example/native-home' },
    checkPorts: async ports => checks.push(['ports', ports]), prepareAssets: async () => checks.push(['assets']),
    waitReady: async env => { assert.match(env.OPENCODE_URL, /4097$/); checks.push(['health']) },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options }); const child = new EventEmitter(); children.push(child); return child
    } })
  try {
    assert.deepEqual(checks.map(c => c[0]), ['ports', 'assets', 'health'])
    assert.equal(calls.length, 3)
    assert.equal(calls[0].options.cwd, '/example/native-home')
    assert.deepEqual(calls[0].args, ['serve', '--hostname', '127.0.0.1', '--port', '4097'])
    assert.deepEqual(calls[1].args, ['bridge/project-bridge.mjs'])
    assert.equal(calls[1].command, process.execPath)
    assert.equal(calls[2].args.at(-1), '--strictPort')
    for (const call of calls) { assert.equal(call.options.shell, false); assert.equal(call.options.env.XDG_DATA_HOME, undefined) }
  } finally { instance.stop(); for (const child of children) child.emit('exit', 0) }
})

test('external mode owns only bridge/UI children; port conflicts launch nothing', async () => {
  const calls = [], children = []
  const instance = await start({ base: { OPENCODE_URL: 'http://127.0.0.1:4107' },
    checkPorts: async ports => assert.deepEqual(ports, [8787, 5173]), prepareAssets: async () => {}, waitReady: async () => {},
    spawnProcess: (command, args) => { calls.push(args); const child = new EventEmitter(); children.push(child); return child } })
  try { assert.equal(calls.length, 2); assert.deepEqual(calls[0], ['bridge/project-bridge.mjs']) }
  finally { instance.stop(); for (const child of children) child.emit('exit', 0) }
  await assert.rejects(start({ checkPorts: async () => { throw Error('occupied fixture port') },
    prepareAssets: async () => assert.fail('no setup on conflict'), spawnProcess: () => assert.fail('no child on conflict') }), /occupied/)
})

test('a failed child shuts down only owned peers and removes signal listeners after exit', async () => {
  const children = [], signals = [], before = process.listenerCount('SIGTERM')
  const previousCode = process.exitCode
  const instance = await start({ base: { OPENCODE_URL: 'http://127.0.0.1:4107' },
    checkPorts: async () => {}, prepareAssets: async () => {}, waitReady: async () => {},
    signalProcess: (child, signal) => signals.push([child.pid, signal]),
    spawnProcess: () => { const child = new EventEmitter(); child.pid = 1000 + children.length; children.push(child); return child } })
  try {
    children[0].emit('exit', 7)
    assert.deepEqual(signals, [[1001, 'SIGTERM']])
    assert.equal(process.exitCode, 7)
    instance.stop(); assert.equal(signals.length, 1, 'shutdown is idempotent')
    children[1].emit('exit', 0)
    assert.equal(instance.children.size, 0)
    assert.equal(process.listenerCount('SIGTERM'), before)
  } finally { instance.stop(); for (const child of children) child.emit('exit', 0); process.exitCode = previousCode }
})
