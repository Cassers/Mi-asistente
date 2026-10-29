import { useEffect, useSyncExternalStore } from 'react'
import { BACKEND, BRIDGE_HTTP_URL } from '../config'

export type WhisperCapabilities = {
  engine: 'whisper'; available: boolean; model?: string; reason?: string
  maxBytes: number; maxSeconds: number; formats: string[]
}
type Discovery = { state: 'unknown' | 'loading' | 'ready' | 'unavailable'; capabilities: WhisperCapabilities | null; error: string }
let discovery: Discovery = { state: 'unknown', capabilities: null, error: '' }
let probing: Promise<WhisperCapabilities> | undefined
let discoveryRevision = 0
let scope = 0
const requests = new Set<AbortController>()
const listeners = new Set<() => void>()
const invalidations = new Set<() => void>()
const notify = () => listeners.forEach(fn => fn())
export const whisperSnapshot = () => discovery
export const whisperScope = () => scope
export function subscribeWhisper(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function subscribeWhisperInvalidation(fn: () => void) { invalidations.add(fn); return () => { invalidations.delete(fn) } }

/** Invalidates local clips, never the microphone's activation/permission state. */
export function invalidateWhisper() {
  scope++
  for (const controller of requests) controller.abort()
  requests.clear()
  invalidations.forEach(fn => fn())
}

/** Called synchronously by destination/mode/transport subscriptions in App. */
export function bindWhisperScope(read: () => { destination: string; chat?: string; connected: boolean },
  subscriptions: ((fn: () => void) => () => void)[], resetCapture: () => void) {
  let previous = read()
  const check = () => {
    const next = read()
    const changed = next.destination !== previous.destination || !!previous.chat && !!next.chat && previous.chat !== next.chat
      || previous.connected && !next.connected
    previous = next
    if (changed) { invalidateWhisper(); resetCapture() }
  }
  const stops = subscriptions.map(subscribe => subscribe(check))
  return () => { stops.forEach(stop => stop()); invalidateWhisper() }
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Transcripción cancelada.', 'AbortError')
}

function capability(value: unknown): WhisperCapabilities {
  const c = value as Partial<WhisperCapabilities> | null
  if (!c || c.engine !== 'whisper' || typeof c.available !== 'boolean' || !Number.isFinite(c.maxBytes) || c.maxBytes! <= 0
    || !Number.isFinite(c.maxSeconds) || c.maxSeconds! <= 0 || !Array.isArray(c.formats) || !c.formats.every(f => typeof f === 'string' && /^[a-z0-9.+/;-]+$/i.test(f))) {
    throw new Error('El servicio local devolvió capacidades Whisper no válidas.')
  }
  return { engine: 'whisper', available: c.available, maxBytes: c.maxBytes!, maxSeconds: c.maxSeconds!, formats: c.formats,
    ...(typeof c.model === 'string' ? { model: c.model } : {}), ...(typeof c.reason === 'string' ? { reason: c.reason } : {}) }
}

export function refreshWhisper(): Promise<WhisperCapabilities> {
  if (probing) return probing
  const mine = ++discoveryRevision
  discovery = { ...discovery, state: 'loading', error: '' }; notify()
  const request = (async () => {
    try {
      if (BACKEND !== 'bridge') throw new Error('Whisper local necesita el puente local de Mi asistente.')
      const response = await fetch(`${BRIDGE_HTTP_URL}/whisper`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (!response.ok) throw new Error('Whisper local no está disponible en este puente.')
      const caps = capability(await response.json())
      if (mine === discoveryRevision) {
        discovery = { state: caps.available ? 'ready' : 'unavailable', capabilities: caps, error: caps.reason || '' }; notify()
      }
      return caps
    } catch (error) {
      if (mine === discoveryRevision) {
        discovery = { state: 'unavailable', capabilities: null, error: error instanceof Error ? error.message : 'No se pudo consultar Whisper local.' }; notify()
      }
      throw error
    }
  })()
  probing = request
  void request.finally(() => { if (probing === request) probing = undefined }).catch(() => {})
  return request
}

export function useWhisperCapabilities() {
  const value = useSyncExternalStore(subscribeWhisper, whisperSnapshot, whisperSnapshot)
  useEffect(() => { if (discovery.state === 'unknown') void refreshWhisper().catch(() => {}) }, [])
  return value
}

const mimeForExtension: Record<string, string> = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
}
const formatMime = (format: string) => {
  const normalized = format.toLowerCase().replace(/^\./, '').split(';')[0]
  return normalized.includes('/') ? normalized : mimeForExtension[normalized]
}
export function whisperAccept(caps: WhisperCapabilities | null): string {
  return caps?.formats.map(format => format.includes('/') ? format.split(';')[0] : `.${format.replace(/^\./, '')}`).join(',') || ''
}

export function validateWhisperAudio(audio: Blob, caps: WhisperCapabilities, filename = ''): string {
  if (!caps.available) throw new Error(caps.reason || 'Whisper local no está disponible. No se usará otro motor.')
  if (!audio.size) throw new Error('El archivo de audio está vacío.')
  if (audio.size > caps.maxBytes) throw new Error(`El audio supera el límite de ${(caps.maxBytes / 1048576).toFixed(1)} MB.`)
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  const actual = audio.type.toLowerCase().split(';')[0]
  const mime = actual || mimeForExtension[extension]
  const normalized = mime === 'audio/x-wav' || mime === 'audio/wave' ? 'audio/wav' : mime === 'audio/mp3' ? 'audio/mpeg' : mime
  const allowed = caps.formats.map(formatMime)
  if (!normalized || !normalized.startsWith('audio/') || !allowed.includes(normalized)) {
    throw new Error('Formato no admitido por Whisper local. Selecciona uno de los formatos indicados.')
  }
  // Keep a real recorder/file MIME, including codec parameters, on the raw body.
  return audio.type || mime
}

export async function transcribeWhisper(audio: Blob, options: { signal?: AbortSignal; language?: string; filename?: string; capabilities?: WhisperCapabilities } = {}): Promise<string> {
  const mine = scope
  cancelled(options.signal)
  const controller = new AbortController()
  requests.add(controller)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const caps = options.capabilities || discovery.capabilities || await refreshWhisper()
    cancelled(controller.signal)
    if (mine !== scope) throw new DOMException('El destino cambió.', 'AbortError')
    const mime = validateWhisperAudio(audio, caps, options.filename)
    const language = options.language || 'auto'
    if (!/^(?:auto|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(language)) throw new Error('Idioma de transcripción no válido.')
    const response = await fetch(`${BRIDGE_HTTP_URL}/whisper/transcribe?language=${encodeURIComponent(language)}`, {
      method: 'POST', headers: { 'content-type': mime }, body: audio, signal: controller.signal, redirect: 'error',
    })
    cancelled(controller.signal)
    const data = await response.json().catch(() => null)
    cancelled(controller.signal)
    if (mine !== scope) throw new DOMException('El destino cambió.', 'AbortError')
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Falló Whisper local. No se usará otro motor.')
    if (data?.engine !== 'whisper' || typeof data.text !== 'string' || !data.text.trim()) throw new Error('Whisper local no devolvió una transcripción válida.')
    return data.text.trim()
  } finally {
    requests.delete(controller)
    options.signal?.removeEventListener('abort', abort)
  }
}
