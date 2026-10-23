import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { ROOT, initialize, runtimeEnv } from './setup.mjs'
import { portsFrom, assertPortsFree } from './start.mjs'

test('a new checkout initializes an anonymous profile and portable MCP without overwriting data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-package-'))
  try {
    await cp(join(ROOT, 'templates'), join(root, 'templates'), { recursive: true })
    const { workspace, configFile } = await initialize(root)
    const profilePath = join(workspace, 'ME/CONFIG.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    assert.equal(profile.configured, false)
    assert.equal(profile.name, '')
    assert.equal(profile.userName, '')
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    assert.deepEqual(config.mcp.jarvis_desktop.command, [process.execPath, join(root, 'bridge/desktop-mcp.mjs')])
    assert.equal(config.permission['*'], 'ask')
    assert.equal(config.share, 'disabled')
    await writeFile(profilePath, '{"configured":true,"name":"Atenea"}')
    await writeFile(configFile, '{"custom":true}')
    const identity = join(workspace, 'ME/IDENTITY.md')
    await writeFile(identity, 'Mi identidad personalizada')
    await initialize(root)
    assert.equal(await readFile(profilePath, 'utf8'), '{"configured":true,"name":"Atenea"}')
    assert.equal(await readFile(configFile, 'utf8'), '{"custom":true}')
    assert.equal(await readFile(identity, 'utf8'), 'Mi identidad personalizada')
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'opencode/data'))).mode & 0o777, 0o700)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('launcher isolates credentials/config and defaults to no recording or screenshots', () => {
  const env = runtimeEnv('/example/project', {
    PATH: '/bin', OPENCODE_CONFIG: '/foreign/config', OPENCODE_CONFIG_CONTENT: 'foreign',
    OPENCODE_PERMISSION: 'allow', OPENCODE_SERVER_PASSWORD: 'old',
  })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
  assert.equal(env.OPENCODE_PERMISSION, undefined)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.equal(env.OPENCODE_CONFIG, '/example/project/opencode/xdg/opencode/opencode.json')
  assert.equal(env.XDG_DATA_HOME, '/example/project/opencode/data')
  assert.equal(env.JARVIS_RECORDING, '0')
  assert.equal(env.JARVIS_AUTO_SCREEN, '0')
  assert.equal(runtimeEnv('/example/project', { JARVIS_AUTO_SCREEN: '1' }).JARVIS_AUTO_SCREEN, '1')
})

test('documented CLI forwards flags with or without the pnpm argument separator', () => {
  for (const args of [['--version'], ['--', '--version']]) {
    const output = execFileSync(process.execPath, ['scripts/opencode.mjs', ...args], {
      cwd: ROOT, timeout: 15000, encoding: 'utf8',
    })
    assert.equal(output.trim(), '1.19.3')
  }
})

test('runtime data, keys, cookies, chats, recordings and local env are ignored', () => {
  const privatePaths = ['.env', '.env.local', '.env.production', 'opencode/workspace/ME/CONFIG.json',
    'opencode/data/opencode/auth.json', 'opencode/xdg/pulse/cookie', 'opencode/workspace/.jarvis/index.json',
    'recordings/session/audio/mic.ogg', 'logs/app.log', 'node_modules/private', 'public/mediapipe/a.wasm']
  for (const path of privatePaths) {
    assert.equal(execFileSync('git', ['check-ignore', '--no-index', path], { cwd: ROOT, encoding: 'utf8' }).trim(), path)
  }
})

test('launcher refuses occupied or conflicting ports without disturbing their listener', async () => {
  assert.throws(() => portsFrom({ PORT: '4097' }), /tres puertos/)
  assert.throws(() => portsFrom({ OC_PORT: '0' }), /tres puertos/)
  assert.throws(() => portsFrom({ OC_PORT: 'NaN' }), /tres puertos/)
  const server = createServer()
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  try {
    await assert.rejects(assertPortsFree([server.address().port]), /ocupado/)
    assert.equal(server.listening, true)
  } finally { await new Promise(ok => server.close(ok)) }
})
