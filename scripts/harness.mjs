import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, lstat, rename, rm, open } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { initialize, ROOT } from './setup.mjs'

const run = promisify(execFile)
export const SOURCE = Object.freeze({ url: 'https://github.com/Cassers/Mi-agente-agent-system.git',
  revision: 'c2d2722e681477df9b6e80ab988c14049486a4b7' })
const INSTRUCTION = 'SYSTEM/OPENCODE-HARNESS.md'
const AGENT = 'arquitecto-skills'
const json = value => JSON.stringify(value, null, 2) + '\n'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const paths = root => ({ workspace: join(root, 'opencode/workspace'),
  config: join(root, 'opencode/xdg/opencode/opencode.json'), receipt: join(root, 'opencode/harness-state.json') })

/** Reject symlinked parents/files, including the runtime root, before writes. */
async function safePath(root, file) {
  const rel = relative(resolve(root), resolve(file))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Ruta fuera del módulo')
  for (let current = resolve(file); ; current = dirname(current)) {
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (info?.isSymbolicLink()) throw new Error(`No se siguen enlaces simbólicos: ${relative(root, current)}`)
    if (current === resolve(root)) break
  }
}
async function optional(file) {
  try { return await readFile(file, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}
async function atomic(root, file, content) {
  await safePath(root, file)
  const temporary = file + '.harness-part'
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
  try { await rename(temporary, file) }
  finally { await rm(temporary, { force: true }) }
}
async function withLock(root, action) {
  const lock = join(root, 'opencode/harness.lock')
  await safePath(root, lock)
  const handle = await open(lock, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Otra instalación está en curso; revisa opencode/harness.lock si se interrumpió.')
    throw error
  })
  try { return await action() }
  finally { await handle.close(); await rm(lock, { force: true }) }
}

/** Pinned public Git objects only. No checkout, hooks, installers or scripts run. */
export async function downloadSource() {
  const stage = await mkdtemp(join(tmpdir(), 'assistant-harness-source-'))
  const git = args => run('git', ['-c', 'core.hooksPath=/dev/null', '-C', stage, ...args],
    { timeout: 60000, maxBuffer: 5 * 1024 * 1024 })
  try {
    await git(['init', '-q'])
    await git(['fetch', '--quiet', '--depth=1', SOURCE.url, SOURCE.revision])
    if ((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== SOURCE.revision) throw new Error('Revisión inesperada')
    const entries = (await git(['ls-tree', '-rz', '--full-tree', SOURCE.revision])).stdout.split('\0').filter(Boolean)
    const files = new Map()
    for (const entry of entries) {
      const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry)
      if (!match) throw new Error('El origen contiene archivos no regulares')
      const name = match[2]
      if (!/^(SYSTEM\/|Agentes\/|ME\/SKILLS\/)/.test(name)) continue
      if (name.split('/').some(part => part === '..' || part === '.')) throw new Error('Ruta upstream inválida')
      files.set(name, (await git(['show', `${SOURCE.revision}:${name}`])).stdout)
    }
    return files
  } finally { await rm(stage, { recursive: true, force: true }) }
}

export async function harnessStatus(root = ROOT) {
  const p = paths(root)
  await safePath(root, p.receipt); await safePath(root, p.config)
  const receipt = JSON.parse(await optional(p.receipt) || 'null')
  const config = JSON.parse(await optional(p.config) || '{}')
  return { installed: !!receipt, enabled: !!receipt && config.instructions?.includes(INSTRUCTION) === true &&
    same(config.agent?.[AGENT], receipt.agent), revision: receipt?.revision ?? null }
}

export async function installHarness({ root = ROOT, loadSource = downloadSource } = {}) {
  // Check before initialize() can copy through a symlinked runtime directory.
  const p = paths(root)
  await safePath(root, p.receipt); await safePath(root, p.config)
  for (const name of ['ME/CONFIG.json', 'ME/IDENTITY.md', 'ME/USER.md', 'ME/MEMORIES/GENERAL.md',
    'ME/SKILLS/INDEX.md', 'AGENTS.md', 'SYSTEM/README.md']) await safePath(root, join(p.workspace, name))
  for (const name of ['data', 'state', 'cache']) await safePath(root, join(root, 'opencode', name, 'probe'))
  await initialize(root)
  return withLock(root, async () => {
    const configRaw = await readFile(p.config, 'utf8'), config = JSON.parse(configRaw)
    if (!config || Array.isArray(config) || (config.agent !== undefined &&
      (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent)))) throw new Error('Configuración inválida; no se sobrescribió')
    const receipt = JSON.parse(await optional(p.receipt) || 'null')
    if (receipt && (await harnessStatus(root)).enabled) return { ...(await harnessStatus(root)), changed: false }
    if (config.agent?.[AGENT] || config.instructions?.includes(INSTRUCTION)) throw new Error('Conflicto con una configuración existente; no se sobrescribió')
    if (config.instructions !== undefined && !Array.isArray(config.instructions)) throw new Error('instructions debe ser una lista')
    const source = await loadSource()
    for (const required of ['SYSTEM/ORCHESTRATOR.md', 'SYSTEM/PROTOCOL.md', 'SYSTEM/REGISTRY.md',
      'ME/SKILLS/CUSTOM/orquestar-agentes/SKILL.md', 'Agentes/arquitecto-skills/PROMPT.md',
      'Agentes/arquitecto-skills/SKILLS/INDEX.md']) {
      if (!source.has(required)) throw new Error(`Falta en la plantilla: ${required}`)
    }
    const plan = new Map()
    for (const [name, content] of source) {
      if (!/^(SYSTEM\/|Agentes\/|ME\/SKILLS\/)/.test(name)) continue
      if (name.split('/').some(part => part === '..' || part === '.')) throw new Error('Ruta upstream inválida')
      const target = name === 'SYSTEM/README.md' ? 'SYSTEM/HARNESS-README.md'
        : name === 'ME/SKILLS/INDEX.md' ? 'ME/SKILLS/HARNESS.md' : name
      plan.set(join(p.workspace, target), content)
    }
    for (const name of ['OPENCODE-HARNESS.md', 'ARQUITECTO-OPENCODE.md']) {
      plan.set(join(p.workspace, 'SYSTEM', name), await readFile(new URL(`../templates/harness/${name}`, import.meta.url), 'utf8'))
    }
    // Entire plan checked first: never overwrite user skills, agents or registry.
    for (const [file, content] of plan) {
      await safePath(root, file)
      const existing = await optional(file)
      if (existing !== null && existing !== content) throw new Error(`Conflicto: ${relative(p.workspace, file)}; no se activó ni sobrescribió`)
    }
    const agent = { description: 'Mantener contratos, skills y prompts del sistema de agentes según el encargo autorizado.',
      mode: 'subagent', prompt: `{file:${join(p.workspace, 'SYSTEM/ARQUITECTO-OPENCODE.md')}}`,
      permission: { task: 'deny', 'jarvis_desktop_*': 'deny' } }
    for (const [file, content] of plan) {
      await safePath(root, file); await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST' || await optional(file) !== content) throw error }
    }
    // Receipt before activation permits recovery if interrupted between the two writes.
    const nextReceipt = { revision: SOURCE.revision, source: SOURCE.url, agent, instruction: INSTRUCTION }
    await atomic(root, p.receipt, json(nextReceipt))
    if (await readFile(p.config, 'utf8') !== configRaw) throw new Error('La configuración cambió mientras se instalaba; no se activó')
    const next = { ...config, instructions: [...(config.instructions || []), INSTRUCTION], agent: { ...config.agent, [AGENT]: agent } }
    await atomic(root, p.config, json(next))
    return { ...(await harnessStatus(root)), changed: true }
  })
}

export async function disableHarness(root = ROOT) {
  const p = paths(root)
  const status = await harnessStatus(root)
  if (!status.installed) return status
  return withLock(root, async () => {
  const receipt = JSON.parse(await readFile(p.receipt, 'utf8'))
  const configRaw = await readFile(p.config, 'utf8'), config = JSON.parse(configRaw)
  if (config.agent?.[AGENT] && !same(config.agent[AGENT], receipt.agent)) throw new Error('El agente fue personalizado; no se sobrescribió. Desactívalo manualmente.')
  const next = { ...config, instructions: (config.instructions || []).filter(file => file !== INSTRUCTION), agent: { ...config.agent } }
  delete next.agent[AGENT]
  if (await readFile(p.config, 'utf8') !== configRaw) throw new Error('La configuración cambió; no se desactivó')
  await atomic(root, p.config, json(next))
  return harnessStatus(root)
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  try {
    if (args.length > 1 || args.some(arg => !['--status', '--disable'].includes(arg))) throw new Error('Uso: pnpm harness:install [--status | --disable]')
    const result = args[0] === '--status' ? await harnessStatus() : args[0] === '--disable' ? await disableHarness() : await installHarness()
    console.log(JSON.stringify(result, null, 2))
    if (!args[0]) console.log('Reinicia pnpm start para cargar el orquestador y su subagente. No se modificó tu perfil ni se ejecutaron instaladores upstream.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
