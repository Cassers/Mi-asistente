import { useSyncExternalStore } from 'react'
import { SPEECH_RATE } from '../config'
import { currentProfile, useProfile } from './profile'

const KEY = 'assistant.speech.rate'
const valid = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2
let override: number | null = null
try {
  const stored = localStorage.getItem(KEY)
  if (stored !== null && valid(Number(stored))) override = Number(stored)
} catch { /* private browsing/storage disabled */ }
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function currentSpeechRate() {
  if (override !== null) return override
  const profile = currentProfile()
  return profile.configured ? profile.speechRate : SPEECH_RATE
}
export function useSpeechRate() {
  useProfile() // profile changes refresh the fallback until a browser override is chosen
  return useSyncExternalStore(subscribe, currentSpeechRate)
}
export function setSpeechRate(value: number) {
  if (!valid(value)) return
  override = Math.round(value * 100) / 100
  try { localStorage.setItem(KEY, String(override)) } catch { /* session override still works */ }
  listeners.forEach(fn => fn())
}
export function resetSpeechRate() {
  override = null
  try { localStorage.removeItem(KEY) } catch { /* ignore unavailable storage */ }
  listeners.forEach(fn => fn())
}
