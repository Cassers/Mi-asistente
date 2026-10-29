import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

export const WHISPER_BUILD_TIMEOUT = 30 * 60 * 1000
export const WHISPER_RELEASE = 'v1.9.5'
export const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
const upstream = 'https://github.com/ggml-org/whisper.cpp.git'
const root = fileURLToPath(new URL('../', import.meta.url))
export const whisperSource = join(root, '.runtime/whisper.cpp')

export async function runWhisperSetupProcess(command, args, { capture = false, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], detached: grouped })
    let output = '', stopped = false, stopReason,  force, code, closed = false
    const signal = name => {
      if (!child.pid) return
      try { if (grouped) process.kill(-child.pid, name); else child.kill(name) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const finish = () => {
      clearTimeout(timer)
      process.off('SIGINT', stop); process.off('SIGTERM', stop)
      if (stopReason === 'timeout') reject(new Error(command + ' excedió el tiempo máximo (' + timeout / 1000 + ' s). Puedes reanudar desde la caché; no se instaló nada global.'))
      else if (stopped) reject(new Error(command + (stopReason === 'output' ? ' excedió el límite de salida.' : ' fue cancelado.')))
      else if (code !== 0) reject(new Error(command + ' falló (código ' + code + '). Revisa sus dependencias; no se instaló nada global.'))
      else resolve(output.trim())
    }
    const stop = (reason = 'cancelled') => {
      if (stopped) return
      stopped = true; stopReason = reason; signal('SIGTERM')
      // A build owns compiler descendants too; wait for group escalation before exiting.
      force = setTimeout(() => { signal('SIGKILL'); force = null; if (closed) finish() }, 500)
    }
    const timer = setTimeout(() => stop('timeout'), timeout)
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    if (capture) child.stdout.on('data', chunk => { output += chunk; if (output.length > 16384) stop('output') })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { code = value; closed = true; if (!force) finish() })
  })
}
export async function setupWhisper({ cuda = false, jobs = 2, architecture } = {}) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw Error('Usa --jobs=1 a --jobs=4.')
  if (architecture && !/^\d{2,3}$/.test(architecture)) throw Error('Arquitectura CUDA inválida.')
  for (const [command, args] of [['git', ['--version']], ['cmake', ['--version']], [process.env.CXX || 'c++', ['--version']], ...(cuda ? [['nvcc', ['--version']]] : [])]) await runWhisperSetupProcess(command, args, { capture: true, timeout: 5000 })
  await mkdir(join(root, '.runtime'), { recursive: true })
  try { await access(join(whisperSource, '.git')) }
  catch {
    // Refuse an existing destination. Fetch the exact commit, not a moving branch.
    await mkdir(whisperSource)
    await runWhisperSetupProcess('git', ['-C', whisperSource, 'init'])
    await runWhisperSetupProcess('git', ['-C', whisperSource, 'remote', 'add', 'origin', upstream])
    await runWhisperSetupProcess('git', ['-C', whisperSource, 'fetch', '--depth', '1', 'origin', WHISPER_COMMIT], { timeout: 120000 })
    await runWhisperSetupProcess('git', ['-C', whisperSource, 'checkout', '--detach', WHISPER_COMMIT])
  }
  const remote = await runWhisperSetupProcess('git', ['-C', whisperSource, 'remote', 'get-url', 'origin'], { capture: true })
  if (remote !== upstream) throw Error('El runtime existente no procede del repositorio oficial esperado.')
  const status = await runWhisperSetupProcess('git', ['-C', whisperSource, 'status', '--porcelain', '--untracked-files=no'], { capture: true })
  if (status) throw Error('El runtime tiene cambios locales; no se sobrescribió.')
  await runWhisperSetupProcess('git', ['-C', whisperSource, 'checkout', '--detach', WHISPER_COMMIT])
  const head = await runWhisperSetupProcess('git', ['-C', whisperSource, 'rev-parse', 'HEAD'], { capture: true })
  if (head !== WHISPER_COMMIT) throw Error('La versión de whisper.cpp no coincide con el commit fijado.')
  const build = join(whisperSource, 'build')
  await runWhisperSetupProcess('cmake', ['-S', whisperSource, '-B', build, '-DCMAKE_BUILD_TYPE=Release',
    '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DGGML_CUDA=' + (cuda ? 'ON' : 'OFF'),
    ...(architecture ? ['-DCMAKE_CUDA_ARCHITECTURES=' + architecture] : []),
    ...(process.env.CUDAToolkit_ROOT ? ['-DCUDAToolkit_ROOT=' + process.env.CUDAToolkit_ROOT] : []),
    ...(process.env.CUDAToolkit_TARGET_DIR ? ['-DCUDAToolkit_TARGET_DIR=' + process.env.CUDAToolkit_TARGET_DIR] : []),
    ...(process.env.CUDAHOSTCXX ? ['-DCMAKE_CUDA_HOST_COMPILER=' + process.env.CUDAHOSTCXX] : []),
  ])
  await runWhisperSetupProcess('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '--parallel', String(jobs)], { timeout: WHISPER_BUILD_TIMEOUT })
  const cli = join(build, 'bin/whisper-cli')
  await runWhisperSetupProcess(cli, ['--help'], { capture: true, timeout: 10000 })
  await writeFile(join(whisperSource, 'mi-asistente-build.json'), JSON.stringify({ release: WHISPER_RELEASE, commit: WHISPER_COMMIT, cuda, architecture, jobs, builtAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  console.log('Whisper preparado en .runtime/whisper.cpp/build/bin/whisper-cli (' + (cuda ? 'CUDA' : 'CPU') + '). No se descargó ningún modelo.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.some(a => a !== '--cuda' && !/^--jobs=[1-4]$/.test(a) && !/^--cuda-arch=\d{2,3}$/.test(a))) throw Error('Uso: pnpm whisper:setup [--cuda] [--cuda-arch=89] [--jobs=2]')
  setupWhisper({ cuda: args.includes('--cuda'), jobs: Number(args.find(a => a.startsWith('--jobs='))?.split('=')[1] || 2),
    architecture: args.find(a => a.startsWith('--cuda-arch='))?.split('=')[1] }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
