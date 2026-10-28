import { useSyncExternalStore } from 'react'
import { selectedProject, subscribeProjects, type Application } from './projects'

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
// Keep OpenCode's saved preference; Codex is explicitly browser-dictation only.
export const currentVoiceInputMode = (application: Application | undefined = selectedProject()?.application): VoiceInputMode => application === 'codex' ? 'transcript' : mode
export function setVoiceInputMode(value: string, application: Application | undefined = selectedProject()?.application) {
  if (application === 'codex') return
  if (value !== 'direct' && value !== 'clip' && value !== 'transcript') return
  mode = value === 'clip' ? 'direct' : value
  effectiveMode = currentVoiceInputMode()
  status = ''
  try { localStorage.setItem(KEY, mode) } catch { /* Never persist audio. */ }
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
