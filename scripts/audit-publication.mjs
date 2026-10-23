import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
if (!files.length) throw new Error('No hay archivos en el índice para revisar.')
const forbidden = /^(?:opencode\/|recordings\/|node_modules\/|dist\/|logs\/)|(?:^|\/)(?:cookie|auth\.json)$|\.log$|^\.env(?!\.example$)/
const patterns = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9_-]{32,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/home\/[^/\n]+\/Proyectos\//,
]
let failed = false
for (const file of files) {
  if (forbidden.test(file)) { console.error(`Archivo privado/runtime en el índice: ${file}`); failed = true; continue }
  // Known upstream audio/image assets are binary; never treat their bytes as logs.
  if (/\.(mp3|png|jpg|webp|wasm)$/.test(file)) continue
  const content = execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 5 * 1024 * 1024 }).toString('utf8')
  if (patterns.some(pattern => pattern.test(content))) {
    console.error(`Revisar posible dato privado en: ${file}`); failed = true
  }
}
const profile = JSON.parse(readFileSync(new URL('../templates/workspace/ME/CONFIG.json', import.meta.url), 'utf8'))
if (profile.configured || profile.name || profile.userName || profile.address || profile.wakeWord) {
  console.error('La plantilla contiene un perfil configurado.'); failed = true
}
if (failed) process.exitCode = 1
else console.log(`Auditoría básica aprobada: ${files.length} archivos; sin runtime ni coincidencias privadas conocidas. No sustituye revisión humana.`)
