import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeProfile, DEFAULT_PROFILE } from '../shared/profile.mjs'

const FILE = new URL('../opencode/workspace/ME/CONFIG.json', import.meta.url)
export async function readProfile(file = FILE) {
  const info = await lstat(file)
  if (!info.isFile() || info.size > 16384) throw new Error('Configuración inválida; no se leyó.')
  return normalizeProfile(JSON.parse(await readFile(file, 'utf8')))
}

/** Read only the explicit public name field; never expose the identity prompt. */
export function identityName(markdown) {
  const value = markdown.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(?:nombre|name)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im)?.[1]
  if (!value) return ''
  const name = value.replace(/^\[([^\]]+)\]\([^)]*\)/, '$1').split(/\s*(?:\(|—|\s--\s)/, 1)[0]
    .replace(/[*_`]/g, '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '').trim()
  if (!name || name.length > 60 || ['<', '>', '[', ']', '{', '}'].some(char => name.includes(char)) || /^(?:pendiente|por definir|sin nombre|tu nombre|your name)$/i.test(name)) return ''
  return name
}
export function jsonIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== undefined && raw.version !== 1) return null
  // Identity preferences are public metadata, never arbitrary prompt fields.
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) return null
  const fields = ['name', 'wakeWord', 'style', 'language']
  const value = Object.fromEntries(fields.filter(key => typeof raw[key] === 'string').map(key => [key, raw[key]]))
  const normalized = normalizeProfile(value)
  const spoken = normalized.wakeWord || normalized.name.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '').trim()
  if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) return null
  return { ...value, wakeWord: spoken }
}
export async function readProjectProfile(directory) {
  let profile = { ...DEFAULT_PROFILE, configured: true }
  try { profile = { ...await readProfile(join(directory, 'ME/CONFIG.json')), configured: true } } catch { /* Optional UI metadata. */ }
  try {
    const file = join(directory, 'ME/IDENTITY.json')
    const info = await lstat(file)
    if (info.isFile() && info.size <= 16384) {
      const identity = jsonIdentity(JSON.parse(await readFile(file, 'utf8')))
      if (identity) return { ...normalizeProfile({ ...profile, ...identity }), configured: true }
    }
  } catch { /* Existing Markdown projects continue to work during migration. */ }
  if (profile.name) return profile
  try {
    const file = join(directory, 'ME/IDENTITY.md')
    const info = await lstat(file)
    if (!info.isFile() || info.size > 16384) return profile
    const name = identityName(await readFile(file, 'utf8'))
    if (name) profile = { ...profile, name }
  } catch { /* A generic project need not define an assistant identity. */ }
  return profile
}
