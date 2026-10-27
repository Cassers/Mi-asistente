import { useSyncExternalStore } from 'react'

export type VoiceInputMode = 'direct' | 'clip' | 'transcript'
const KEY = 'assistant.voice.input-mode'
let mode: VoiceInputMode = 'direct'
let status = ''
try {
  const saved = localStorage.getItem(KEY)
  if (saved === 'transcript') mode = 'transcript'
  else if (saved === 'clip') localStorage.setItem(KEY, 'direct')
} catch { /* Works without storage. */ }
const listeners = new Set<() => void>()
export const currentVoiceInputMode = () => mode
export function setVoiceInputMode(value: string) {
  if (value !== 'direct' && value !== 'clip' && value !== 'transcript') return
  mode = value === 'clip' ? 'direct' : value
  status = ''
  try { localStorage.setItem(KEY, mode) } catch { /* Never persist audio. */ }
  listeners.forEach(fn => fn())
}
export const subscribeVoiceInputMode = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const useVoiceInputMode = () => useSyncExternalStore(subscribeVoiceInputMode, currentVoiceInputMode, currentVoiceInputMode)
export function reportVoiceInput(message: string) { status = message.slice(0, 300); listeners.forEach(fn => fn()) }
export const useVoiceInputStatus = () => useSyncExternalStore(subscribeVoiceInputMode, () => status, () => status)
