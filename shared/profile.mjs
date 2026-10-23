/** Public preferences only. Never place credentials, prompts or private memory here. */
export const DEFAULT_PROFILE = Object.freeze({
  configured: false, name: '', userName: '', address: '', style: 'Claro y directo',
  wakeWord: '', speechRate: 1.2, language: 'es-CO', timeZone: 'America/Bogota',
})

export function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const clean = (key, max) => typeof p[key] === 'string' ? Array.from(p[key], ch => ch.charCodeAt(0) < 32 ? ' ' : ch).join('').trim().slice(0, max) : DEFAULT_PROFILE[key]
  const profile = { configured: p.configured === true, name: clean('name', 60),
    userName: clean('userName', 80), address: clean('address', 80), style: clean('style', 500),
    wakeWord: clean('wakeWord', 60), speechRate: Number(p.speechRate),
    language: clean('language', 35), timeZone: clean('timeZone', 80) }
  if (!Number.isFinite(profile.speechRate) || profile.speechRate < 0.5 || profile.speechRate > 2) profile.speechRate = 1.2
  try { new Intl.Locale(profile.language) } catch { profile.language = DEFAULT_PROFILE.language }
  try { new Intl.DateTimeFormat('es', { timeZone: profile.timeZone }) } catch { profile.timeZone = DEFAULT_PROFILE.timeZone }
  return profile
}

export const displayName = profile => profile.name || 'Asistente'
export const wakeWord = profile => profile.wakeWord || profile.name || 'asistente'

/** Literal names, including accents/spaces; no regular-expression injection. */
export function wakePattern(profile, kind = 'any') {
  const name = wakeWord(profile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = '(?:(?:hey|hi|ok|okay|oye|ey|hola)[\\s,.:;!?-]+)?'
  const phrase = `${prefix}${name}(?![\\p{L}\\p{N}_])`
  return new RegExp(kind === 'bare' ? `^${phrase}[\\s,.!?]*$`
    : kind === 'leading' ? `^${phrase}[\\s,.:;!?-]*` : `(?<![\\p{L}\\p{N}_])${phrase}`, 'iu')
}
