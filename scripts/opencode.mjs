import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, initialize, runtimeEnv } from './setup.mjs'

const { workspace } = await initialize()
const args = process.argv.slice(2)
// pnpm versions differ in whether the optional separator reaches the script.
if (args[0] === '--') args.shift()
const child = spawn(join(ROOT, 'node_modules/.bin/opencode'), args, {
  cwd: workspace, env: runtimeEnv(), stdio: 'inherit', shell: false,
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
