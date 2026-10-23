import { useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { DEFAULT_PROFILE, normalizeProfile, displayName, wakeWord, wakePattern, type Profile } from '../../shared/profile.mjs'

let profile: Profile = { ...DEFAULT_PROFILE }
const listeners = new Set<() => void>()
export const currentProfile = () => profile
export { displayName, wakeWord, wakePattern }
export function useProfile() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, currentProfile)
}
export async function refreshProfile() {
  const res = await fetch(`${BRIDGE_HTTP_URL}/profile`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error('No se pudo leer la configuración del asistente.')
  const next = normalizeProfile(await res.json())
  if (JSON.stringify(next) !== JSON.stringify(profile)) {
    profile = next
    for (const cb of listeners) cb()
  }
  return profile
}
export function watchProfile() {
  void refreshProfile().catch(() => {})
  const timer = window.setInterval(() => { void refreshProfile().catch(() => {}) }, 3000)
  return () => window.clearInterval(timer)
}
