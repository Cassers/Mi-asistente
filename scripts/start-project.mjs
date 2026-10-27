import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ROOT } from './setup.mjs'
import { assertPortsFree } from './start.mjs'
import { localServer } from '../bridge/projects.mjs'

export function launchPlan(base = process.env, root = ROOT) {
  const external = Boolean(base.OPENCODE_URL)
  const ports = [base.OC_PORT ?? '4097', base.JARVIS_BRIDGE_PORT ?? '8787', base.PORT ?? '5173'].map(Number)
  const ownedPorts = external ? ports.slice(1) : ports
  if (ownedPorts.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ownedPorts).size !== ownedPorts.length) {
    throw new Error('Elige puertos diferentes entre 1024 y 65535.')
  }
  const [ocPort, bridgePort, facePort] = ports
  // Native accounts, XDG directories and project configuration belong to the user.
  const env = { ...base, OPENCODE_URL: localServer(base.OPENCODE_URL || `http://127.0.0.1:${ocPort}`),
    PORT: String(facePort), JARVIS_BRIDGE_PORT: String(bridgePort),
    JARVIS_ALLOWED_ORIGINS: `http://localhost:${facePort},http://127.0.0.1:${facePort}`,
    JARVIS_RECORDING: base.JARVIS_RECORDING ?? '0', JARVIS_AUTO_SCREEN: base.JARVIS_AUTO_SCREEN ?? '0',
    VITE_BACKEND: 'bridge', VITE_BRIDGE_URL: `ws://127.0.0.1:${bridgePort}` }
  if (!external) {
    let config
    try { config = JSON.parse(base.OPENCODE_CONFIG_CONTENT || '{}') }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT debe contener JSON válido.') }
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.plugin !== undefined && !Array.isArray(config.plugin))) {
      throw new Error('Configuración de plugins OpenCode inválida.')
    }
    const plugin = pathToFileURL(join(root, 'bridge/opencode-audio-plugin.mjs')).href
    const plugins = [...(config.plugin || [])]
    if (!plugins.some(entry => (Array.isArray(entry) ? entry[0] : entry) === plugin)) plugins.push(plugin)
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugin: plugins })
    env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString('hex')
  }
  return { env, ports: ownedPorts, external, ocPort, facePort,
    serverDirectory: base.JARVIS_OC_DIRECTORY || homedir() }
}

export async function vendorAssets(root) {
  const from = join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), to = join(root, 'public/mediapipe')
  try { await access(from) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  await mkdir(to, { recursive: true })
  await cp(from, to, { recursive: true, force: false, errorOnExist: false })
}

async function ready(env, stopped) {
  const headers = env.OPENCODE_SERVER_PASSWORD ? {
    authorization: 'Basic ' + Buffer.from(`${env.OPENCODE_SERVER_USERNAME || 'opencode'}:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64'),
  } : {}
  for (let attempt = 0; attempt < 100 && !stopped(); attempt++) {
    try {
      const response = await fetch(`${env.OPENCODE_URL}/global/health`, { headers, redirect: 'error', signal: AbortSignal.timeout(500) })
      if (response.status === 401) throw new Error('OpenCode solicita la contraseña del servidor local.')
      if (response.ok && (await response.json()).healthy === true) return
    } catch (error) { if (error.message.includes('contraseña')) throw error }
    await new Promise(ok => setTimeout(ok, 200))
  }
  if (!stopped()) throw new Error('OpenCode no estuvo disponible a tiempo.')
}

export async function start({ root = ROOT, base = process.env, spawnProcess = spawn,
  checkPorts = assertPortsFree, prepareAssets = vendorAssets, waitReady = ready,
  signalProcess = (child, signal) => {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } } = {}) {
  const plan = launchPlan(base, root), { env } = plan
  await checkPorts(plan.ports)
  await prepareAssets(root)
  const children = new Set()
  let stopping = false, forceTimer
  const handlers = new Map()
  const signalChild = (child, signal) => {
    if (!child.pid) return
    try {
      signalProcess(child, signal)
    } catch (error) { if (error.code !== 'ESRCH') console.error('No se pudo cerrar un proceso propio.') }
  }
  const cleanup = () => {
    clearTimeout(forceTimer)
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  const stop = (code = 0) => {
    if (stopping) return
    stopping = true; process.exitCode = code
    for (const child of children) signalChild(child, 'SIGTERM')
    forceTimer = setTimeout(() => {
      for (const child of children) signalChild(child, 'SIGKILL')
    }, 3000).unref()
    if (!children.size) cleanup()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => stop()
    handlers.set(signal, handler); process.once(signal, handler)
  }
  const run = (name, command, args, cwd = root) => {
    const child = spawnProcess(command, args, { cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore'] })
    children.add(child)
    // Native logs can include account information, plugin config or credentials.
    child.once('error', () => { console.error(`${name}: no se pudo iniciar.`); children.delete(child); stop(1); if (!children.size) cleanup() })
    child.once('exit', (code, signal) => {
      children.delete(child)
      if (!stopping) { console.error(`${name} terminó (${code ?? signal}); cerrando sus compañeros.`); stop(code || 1) }
      if (!children.size) cleanup()
    })
    return child
  }
  try {
    if (!plan.external) {
      // Resolve the installed platform executable, avoiding pnpm shell/.cmd wrappers.
      const require = createRequire(join(root, 'package.json'))
      const packageFile = require.resolve('opencode-ai/package.json')
      const pkg = JSON.parse(await readFile(packageFile, 'utf8'))
      run('OpenCode', join(dirname(packageFile), pkg.bin.opencode), ['serve', '--hostname', '127.0.0.1', '--port', String(plan.ocPort)], plan.serverDirectory)
    }
    await waitReady(env, () => stopping)
    if (!stopping) {
      run('Bridge', process.execPath, ['bridge/project-bridge.mjs'])
      run('Interfaz', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(plan.facePort), '--strictPort'])
      console.log(`Abre http://127.0.0.1:${plan.facePort} en Chrome. Elige Codex u OpenCode y una carpeta. Ctrl+C cierra esta instancia.`)
      if (plan.external) console.log('Servidor OpenCode externo: su propietario debe cargar el plugin de audio si necesita clips directos.')
    }
  } catch (error) { stop(1); throw error }
  return { stop, children, plan }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.loadEnvFile(join(ROOT, '.env.local')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  start().catch(() => { console.error('No se pudo iniciar el cliente. Comprueba puertos, dependencias y el servidor OpenCode.'); process.exitCode = 1 })
}
