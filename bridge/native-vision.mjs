import { supportsVoice } from './model-catalog.mjs'

/** Share read-only inspection within one request, after any history repair.
 * Never shared across turns: native model/config changes remain visible. */
export function turnInspection(api) {
  const reads = new Map()
  return (method, path, ...args) => {
    if (method !== 'GET' || args.length || !(/^\/(?:config|agent|provider)$/.test(path) || /^\/session\/[^/]+\/message$/.test(path))) return api(method, path, ...args)
    if (!reads.has(path)) reads.set(path, Promise.resolve().then(() => api(method, path)))
    return reads.get(path)
  }
}

/** Inspect native choices for optional capture only; never override their resolution. */
export async function nativeVision(api, session, continuation = {}) {
  return nativeInput(api, session, continuation, 'image')
}

export async function nativeAudio(api, session, continuation = {}) {
  return nativeInput(api, session, continuation, 'audio')
}

async function nativeInput(api, session, continuation, modality) {
  const resolved = await nativeModel(api, session, continuation)
  return modality === 'audio' ? supportsVoice(resolved?.model, resolved?.providerID) : resolved?.model?.capabilities?.input?.[modality] === true
}

export async function nativeModel(api, session, continuation = {}) {
  const [config, agents, messages, catalog] = await Promise.all([
    api('GET', '/config'), api('GET', '/agent'), api('GET', `/session/${session.id}/message`), api('GET', '/provider'),
  ])
  const agentName = continuation.agent || config.default_agent
  const agent = agentName ? agents.find(a => a.name === agentName) : agents.find(a => a.mode !== 'subagent' && !a.hidden)
  const last = [...messages].reverse().find(m => m.info?.role === 'user')?.info.model
  const reference = continuation.model || agent?.model || session.model || last || config.model
  let providerID, modelID
  if (typeof reference === 'string') { const slash = reference.indexOf('/'); providerID = reference.slice(0, slash); modelID = reference.slice(slash+1) }
  else { providerID = reference?.providerID; modelID = reference?.modelID || reference?.id }
  if (!providerID || !modelID) return null // unknown native default: don't guess another model
  const provider = catalog.all?.find(p => p.id === providerID)
  const model = provider?.models?.[modelID]
  return model ? { providerID, modelID, model } : null
}

/** Restore native selections made in another client, including plan mode and variant. */
export async function nativeContinuation(api, session) {
  const messages = await api('GET', `/session/${session.id}/message`)
  const last = [...messages].reverse().find(message => message.info?.role === 'user')?.info
  if (!last) return {}
  const choices = {}
  if (typeof last.agent === 'string') choices.agent = last.agent
  const model = session.model || last.model
  if (model?.providerID && (model.modelID || model.id)) choices.model = { providerID: model.providerID, modelID: model.modelID || model.id }
  const variant = session.model?.variant || last.model?.variant || last.variant
  if (typeof variant === 'string' && variant) choices.variant = variant
  return choices
}
