import { useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

export type ModelOption = { id: string; name: string; provider: string; free: boolean; cost: { input: number | null; output: number | null }; image: boolean; audio: boolean; variants: string[] }
type State = { models: ModelOption[]; model: string; variant: string; loading: boolean; error: string }
const KEY = 'assistant.model.selection'
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
  try { localStorage.setItem(KEY, JSON.stringify({ model, variant })) } catch { /* works without persistence */ }
}

export function refreshModels(force = false): Promise<void> {
  if (pending) return pending
  if (!force && Date.now() - loaded < 30000) return Promise.resolve()
  pending = (async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/models`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error('catalogue unavailable')
      const data = await res.json() as { models: ModelOption[]; defaultModel: string }
      if (!Array.isArray(data.models) || !data.models.length) throw new Error('empty catalogue')
      let saved = { model: state.model, variant: state.variant }
      if (!saved.model) {
        try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { /* ignore corrupt local preference */ }
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
      publish({ loading: false, error: 'No se pudo verificar el catálogo o el modelo elegido. Reintenta; no se cambió a otro modelo.' })
    } finally { pending = undefined }
  })()
  return pending
}

export async function currentModelSelection() {
  await refreshModels()
  if (state.error || !state.model) throw new Error(state.error || 'Catálogo de modelos no disponible.')
  return { model: state.model, variant: state.variant }
}
