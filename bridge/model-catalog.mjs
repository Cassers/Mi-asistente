import { audioEndpoint } from './audio-route.mjs'

/** Supports an MP3 trial, with a transcript fallback if the provider rejects it. */
export function supportsVoice(model, providerID) {
  if (model?.capabilities?.input?.audio !== true) return false
  try { audioEndpoint({ model, modelID: model.id, providerID }); return true } catch { return false }
}

export function availableModels(catalog) {
  const connected = new Set(catalog?.connected || [])
  return (catalog?.all || []).filter(p => connected.has(p.id)).flatMap(provider => Object.values(provider.models || {}).filter(m =>
    typeof m.id === 'string' && m.status !== 'deprecated' &&
    m.capabilities?.input?.text === true && m.capabilities?.output?.text === true,
  ).map(m => ({
    id: `${provider.id}/${m.id}`, name: m.name || m.id, provider: provider.name || provider.id,
    free: provider.id === 'opencode' && m.id.endsWith('-free') && m.cost?.input === 0 && m.cost?.output === 0 && Object.values(m.cost?.cache || {}).every(cost => cost === 0),
    cost: { input: Number.isFinite(m.cost?.input) ? m.cost.input : null, output: Number.isFinite(m.cost?.output) ? m.cost.output : null },
    image: m.capabilities.input.image === true, audio: supportsVoice(m, provider.id),
    ...(m.capabilities.input.audio === true && !supportsVoice(m, provider.id) ? { audioReason: 'Esta conexión no tiene una ruta directa de audio habilitada; se usará la transcripción del dictado.' } : {}),
    variants: Object.entries(m.variants || {}).filter(([, value]) => !value?.disabled).map(([key]) => key),
  }))).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
}

export function selectModel(catalog, id, variant = '') {
  const selected = availableModels(catalog).find(m => m.id === id)
  if (!selected) throw new Error('El modelo no está disponible en los proveedores conectados a OpenCode. No se envió la pregunta ni se cambió de modelo.')
  if (typeof variant !== 'string' || (variant && !selected.variants.includes(variant))) {
    throw new Error('Ese nivel de pensamiento no está disponible para el modelo elegido. No se envió la pregunta.')
  }
  const slash = selected.id.indexOf('/')
  return { ...selected, model: { providerID: selected.id.slice(0, slash), modelID: selected.id.slice(slash + 1) }, ...(variant ? { variant } : {}) }
}
