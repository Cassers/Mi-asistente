import { useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { selectedProject, projectURL, subscribeProjects } from './projects'
import { timedFetch } from './timings'

export type ModelOption = { id: string; name: string; provider: string; free: boolean; cost: { input: number | null; output: number | null }; image: boolean; audio: boolean; audioReason?: string; variants: string[] }
type State = { models: ModelOption[]; model: string; variant: string; loading: boolean; error: string }
const KEY = 'assistant.model.selection'
let context = ''
const storageKey = () => context ? `${KEY}:${context}` : KEY
let state: State = { models: [], model: '', variant: '', loading: true, error: '' }
const listeners = new Set<() => void>()
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
let pending: Promise<void> | undefined
let loaded = 0
const subscribe = (fn: () => void) => { listeners.add(fn); void refreshModels(); return () => { listeners.delete(fn) } }
const snapshot = () => state
export const useModels = () => useSyncExternalStore(subscribe, snapshot)

export function chooseModel(model: string, variant = '') {
  const option = state.models.find(m => m.id === model)
  if (!option || (variant && !option.variants.includes(variant))) return
  publish({ model, variant, error: '' })
  try { localStorage.setItem(storageKey(), JSON.stringify({ model, variant })) } catch { /* works without persistence */ }
}

export function refreshModels(force = false): Promise<void> {
  const project = selectedProject()?.id || ''
  if (project !== context) {
    context = project; pending = undefined; loaded = 0
    publish({ models: [], model: '', variant: '', loading: true, error: '' })
  }
  if (pending) return pending
  if (!force && Date.now() - loaded < 30000) return Promise.resolve()
  pending = (async () => {
    try {
      const res = await timedFetch('model.catalog', projectURL(`${BRIDGE_HTTP_URL}/models`), { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error('catalogue unavailable')
      const data = await res.json() as { models: ModelOption[]; defaultModel: string }
      if (project !== context) return
      if (!Array.isArray(data.models) || !data.models.length) throw new Error('empty catalogue')
      let saved = { model: state.model, variant: state.variant }
      if (!saved.model) {
        try { saved = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {} } catch { /* ignore corrupt local preference */ }
      }
      const option = data.models.find(m => m.id === (saved.model || data.defaultModel))
      if (!option) {
        publish({ models: data.models, model: '', variant: '', loading: false,
          error: 'El modelo guardado o predeterminado no está disponible. Elige uno del catálogo; no se cambió a otro modelo.' })
        loaded = Date.now()
        return
      }
      publish({ models: data.models, model: option.id, variant: option.variants.includes(saved.variant) ? saved.variant : '', loading: false, error: '' })
      loaded = Date.now()
    } catch {
      if (project === context) publish({ loading: false, error: 'No se pudo verificar el catálogo o el modelo elegido. Reintenta; no se cambió a otro modelo.' })
    } finally { if (project === context) pending = undefined }
  })()
  return pending
}

export async function currentModelSelection() {
  // The bridge validates the actual current provider catalogue before sending.
  // A UI refresh belongs to browsing/recovery, not the voice dispatch path.
  if (context !== (selectedProject()?.id || '') || !loaded || state.error || !state.model) await refreshModels()
  if (state.error || !state.model) throw new Error(state.error || 'Catálogo de modelos no disponible.')
  if (state.model === 'native/default') return {}
  return { model: state.model, variant: state.variant }
}

let watchedProject = ''
subscribeProjects(() => {
  const id = selectedProject()?.id || ''
  if (id === watchedProject) return
  watchedProject = id
  void refreshModels(true)
})
