import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))

async function copyMissing(source, target) {
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await copyMissing(from, to)
    else {
      try { await copyFile(from, to, constants.COPYFILE_EXCL) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
  }
}

export async function initialize(root = ROOT) {
  await copyMissing(join(root, 'templates/workspace'), join(root, 'opencode/workspace'))
  for (const name of ['xdg', 'data', 'state', 'cache']) {
    await mkdir(join(root, 'opencode', name), { recursive: true, mode: 0o700 })
  }
  const configFile = join(root, 'opencode/xdg/opencode/opencode.json')
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
  const config = JSON.parse(await readFile(join(root, 'templates/opencode.json'), 'utf8'))
  config.mcp = { jarvis_desktop: { type: 'local', enabled: true, timeout: 270000,
    command: [process.execPath, join(root, 'bridge/desktop-mcp.mjs')] } }
  try { await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  // Vendor missing dependency assets locally; delete public/mediapipe after upgrading it.
  const wasm = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
  try { await access(wasm); await copyMissing(wasm, join(root, 'public/mediapipe')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return { root, workspace: join(root, 'opencode/workspace'), configFile }
}

export function runtimeEnv(root = ROOT, base = process.env) {
  const env = { ...base }
  // Do not inherit another assistant's injected config/permissions/identity.
  for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key]
  return { ...env,
    XDG_CONFIG_HOME: join(root, 'opencode/xdg'), XDG_DATA_HOME: join(root, 'opencode/data'),
    XDG_STATE_HOME: join(root, 'opencode/state'), XDG_CACHE_HOME: join(root, 'opencode/cache'),
    OPENCODE_CONFIG: join(root, 'opencode/xdg/opencode/opencode.json'),
    OPENCODE_ENABLE_EXA: '1',
    JARVIS_RECORDING: base.JARVIS_RECORDING ?? '0', JARVIS_AUTO_SCREEN: base.JARVIS_AUTO_SCREEN ?? '0',
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await initialize()
  console.log('Preparado. Tu perfil y datos existentes no se sobrescribieron. Ejecuta pnpm start.')
}
