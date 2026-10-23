import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, initialize, runtimeEnv } from './setup.mjs'

export function portsFrom(env) {
  const ports = [env.OC_PORT ?? '4097', env.JARVIS_BRIDGE_PORT ?? '8787', env.PORT ?? '5173'].map(Number)
  if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== 3) {
    throw new Error('Elige tres puertos diferentes entre 1024 y 65535.')
  }
  return ports
}

export async function assertPortsFree(ports) {
  const probes = []
  try {
    for (const port of ports) {
      const server = createServer(); probes.push(server)
      await new Promise((ok, reject) => {
        server.once('error', () => reject(new Error(`Puerto ${port} ocupado; no se detuvo ningún proceso.`)))
        server.listen(port, '127.0.0.1', ok)
      })
    }
  } finally { await Promise.all(probes.map(server => new Promise(ok => server.close(ok)))) }
}

export async function start() {
  try { process.loadEnvFile(join(ROOT, '.env.local')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const [ocPort, bridgePort, facePort] = portsFrom(process.env)
  // Refuse conflicts before launching children. Never kill unrelated listeners.
  await assertPortsFree([ocPort, bridgePort, facePort])
  const { workspace } = await initialize()
  const password = randomBytes(24).toString('hex')
  const env = { ...runtimeEnv(), OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_URL: `http://127.0.0.1:${ocPort}`, PORT: String(facePort),
    JARVIS_BRIDGE_PORT: String(bridgePort), JARVIS_BRIDGE_HOST: '127.0.0.1',
    JARVIS_ALLOWED_ORIGINS: `http://localhost:${facePort},http://127.0.0.1:${facePort}`,
    VITE_BACKEND: 'bridge', VITE_BRIDGE_URL: `ws://127.0.0.1:${bridgePort}` }
  const children = new Set()
  let stopping = false
  const signalChild = (child, signal) => {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal) // Only groups this launcher created.
    } catch (error) { if (error.code !== 'ESRCH') console.error(error.message) }
  }
  const stop = (code = 0) => {
    if (stopping) return
    stopping = true; process.exitCode = code
    for (const child of children) signalChild(child, 'SIGTERM')
    setTimeout(() => {
      for (const child of children) signalChild(child, 'SIGKILL')
      process.exit(code)
    }, 3000).unref()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop())
  const run = (name, command, args, cwd = ROOT) => {
    const child = spawn(command, args, { cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => {
      // OpenCode may print its credentials at startup. Do not echo the password.
      process.stdout.write(`[${name}] ${data.toString().replaceAll(password, '[oculto]')}`)
    })
    child.once('error', error => { console.error(`${name}: ${error.message}`); stop(1) })
    child.once('exit', (code, signal) => {
      if (!stopping) { console.error(`${name} terminó (${code ?? signal}); cerrando sus compañeros.`); stop(code || 1) }
      children.delete(child)
    })
    return child
  }
  run('opencode', join(ROOT, 'node_modules/.bin/opencode'), ['serve', '--hostname', '127.0.0.1', '--port', String(ocPort)], workspace)
  try {
    let healthy = false
    for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
      try {
        const response = await fetch(`${env.OPENCODE_URL}/global/health`, {
          headers: { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') },
          signal: AbortSignal.timeout(500),
        })
        if (response.ok) { healthy = true; break }
      } catch { /* not listening yet */ }
      await new Promise(ok => setTimeout(ok, 200))
    }
    if (!healthy) throw new Error('OpenCode no estuvo disponible a tiempo. Revisa su salida.')
    if (stopping) return
    run('bridge', process.execPath, ['bridge/opencode-bridge.mjs'])
    run('interfaz', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(facePort), '--strictPort'])
    console.log(`Abre http://127.0.0.1:${facePort} en Google Chrome. Ctrl+C detiene solo esta instancia.`)
    console.log(`Captura automática: ${env.JARVIS_AUTO_SCREEN === '0' ? 'apagada' : 'activa'}; historial: ${env.JARVIS_RECORDING === '0' ? 'pausado' : 'activo'}.`)
  } catch (error) { console.error(error.message); stop(1) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  start().catch(error => { console.error(error.message); process.exitCode = 1 })
}
