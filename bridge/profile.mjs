import { readFile, lstat } from 'node:fs/promises'
import { normalizeProfile } from '../shared/profile.mjs'

const FILE = new URL('../opencode/workspace/ME/CONFIG.json', import.meta.url)
export async function readProfile(file = FILE) {
  const info = await lstat(file)
  if (!info.isFile() || info.size > 16384) throw new Error('Configuración inválida; no se leyó.')
  return normalizeProfile(JSON.parse(await readFile(file, 'utf8')))
}
