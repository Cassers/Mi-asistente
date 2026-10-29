import { useSyncExternalStore } from 'react'
import { selectedProject, subscribeProjects, type Application } from './projects'

export type VoiceInputMode = 'direct' | 'clip' | 'transcript' | 'whisper'
const KEY = 'assistant.voice.input-mode'
const preferences = new Map<Application, VoiceInputMode>()
for (const application of ['opencode', 'codex', 'claude', 'antigravity'] as const) {
  let mode: VoiceInputMode = application === 'opencode' ? 'direct' : 'transcript'
  try {
    const key = application === 'opencode' ? KEY : `${KEY}:${application}`
    const saved = localStorage.getItem(key)
    if (saved === 'transcript' || saved === 'whisper') mode = saved
    else if (saved === 'clip' && application === 'opencode') localStorage.setItem(key, 'direct')
  } catch { /* Works without storage. */ }
  preferences.set(application, mode)
}
let status = ''
const listeners = new Set<() => void>()
export const currentVoiceInputMode = (application: Application = selectedProject()?.application || 'opencode'): VoiceInputMode => preferences.get(application) || 'transcript'
export function setVoiceInputMode(value: string, application: Application = selectedProject()?.application || 'opencode') {
  if (value !== 'direct' && value !== 'clip' && value !== 'transcript' && value !== 'whisper') return
  if (application !== 'opencode' && (value === 'direct' || value === 'clip')) return
  const mode = value === 'clip' ? 'direct' : value
  // An unchanged native default should not create or overwrite OpenCode storage.
  if (preferences.get(application) === mode) {
    if (status) { status = ''; listeners.forEach(fn => fn()) }
    return
  }
  preferences.set(application, mode)
  effectiveMode = currentVoiceInputMode()
  status = ''
  try { localStorage.setItem(application === 'opencode' ? KEY : `${KEY}:${application}`, mode) } catch { /* Never persist audio. */ }
  listeners.forEach(fn => fn())
}
export const subscribeVoiceInputMode = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const useVoiceInputMode = (application?: Application) => useSyncExternalStore(subscribeVoiceInputMode, () => currentVoiceInputMode(application), () => currentVoiceInputMode(application))
let effectiveMode = currentVoiceInputMode()
subscribeProjects(() => {
  const next = currentVoiceInputMode()
  if (next === effectiveMode) return
  effectiveMode = next
  status = ''
  listeners.forEach(fn => fn())
})
export function reportVoiceInput(message: string) { status = message.slice(0, 300); listeners.forEach(fn => fn()) }
export const useVoiceInputStatus = () => useSyncExternalStore(subscribeVoiceInputMode, () => status, () => status)
