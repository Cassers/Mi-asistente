import { createHash } from 'node:crypto'

export const AUDIO_META = 'miAsistenteAudio'
export const PURPOSE_HEADER = 'x-mi-asistente-audio-purpose'
const pattern = /\[mi-asistente-audio:([a-f0-9]{64})\]/g
const MAX_MP3 = 512000
export const audioMarker = data => `[mi-asistente-audio:${createHash('sha256').update(data).digest('hex')}]`

function audioValue(value) {
  if (!value || value.format !== 'mp3' || typeof value.data !== 'string' || value.data.length > Math.ceil(MAX_MP3 * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('Audio directo inválido.')
  const bytes = Buffer.from(value.data, 'base64')
  if (!bytes.length || bytes.length > MAX_MP3 || !(bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff)) throw new Error('Audio directo MP3 inválido.')
  return { data: value.data, format: 'mp3' }
}

/** Keep the audio in native part metadata, outside tokenized text and UI prose.
 * This avoids the SDK's unsupported Responses file-part conversion in every
 * native path (including title generation and compaction), without a transcript. */
export function storeAudioParts(parts, registry) {
  for (let i=0; i<parts.length; i++) {
    const part = parts[i]
    if (part.type !== 'file' || part.mime !== 'audio/mpeg' || !/^mi-asistente-voice-[\w-]+\.mp3$/.test(part.filename || '')) continue
    const prefix = 'data:audio/mpeg;base64,'
    if (!part.url?.startsWith(prefix)) throw new Error('El audio directo debe estar incluido en el mensaje.')
    const value = audioValue({ data: part.url.slice(prefix.length), format: 'mp3' })
    const marker = audioMarker(value.data)
    registry.set(marker, value)
    parts[i] = { id: part.id, sessionID: part.sessionID, messageID: part.messageID,
      type: 'text', text: marker, synthetic: true, metadata: { [AUDIO_META]: value } }
  }
}

export function restoreAudioParts(messages, registry) {
  const next = new Map()
  for (const message of messages) for (const part of message.parts || []) {
    if (message.info?.role !== 'user' || part.type !== 'text' || !part.synthetic || !part.metadata?.[AUDIO_META]) continue
    const value = audioValue(part.metadata[AUDIO_META])
    const marker = audioMarker(value.data)
    if (part.text !== marker) throw new Error('El marcador no corresponde a su audio.')
    next.set(marker, value)
  }
  // Preserve mappings for in-flight parallel requests and their retries.
  for (const [key, value] of next) { registry.delete(key); registry.set(key, value) }
  // Other sessions can still be between their transform and HTTP request.
  // Retain these references for the native project instance's lifetime; its
  // dispose hook releases the registry. Arbitrary LRU eviction loses audio
  // needed by concurrent requests, retries and native compaction.
}

function endpoint(input) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (url.hostname === 'opencode.ai' && /^\/inference\/(?:go\/)?openai\/v1\/responses$/.test(url.pathname)) return 'responses'
  if (url.hostname === 'opencode.ai' && /^\/inference\/(?:go\/)?openai\/v1\/chat\/completions$/.test(url.pathname)) return 'chat'
  if ((url.hostname === 'opencode.ai' && /^\/inference\/(?:go\/)?google\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(url.pathname)) ||
      (url.hostname === 'generativelanguage.googleapis.com' && /^\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(url.pathname))) return 'google'
  return null
}

function split(text, kind, registry, auxiliary) {
  const pieces = []; let from = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > from) pieces.push(kind === 'google' ? { text: text.slice(from, match.index) } : { type: kind === 'responses' ? 'input_text' : 'text', text: text.slice(from, match.index) })
    if (auxiliary) {
      pieces.push(kind === 'google' ? { text: '[Audio adjunto, sin transcripción]' } : { type: kind === 'responses' ? 'input_text' : 'text', text: '[Audio adjunto, sin transcripción]' })
    } else {
      const value = registry.get(match[0])
      if (!value) throw new Error('No se encontró el audio original de este mensaje. Vuelve a enviar el clip.')
      pieces.push(kind === 'google' ? { inlineData: { mimeType: 'audio/mpeg', data: value.data } }
        : { type: 'input_audio', input_audio: value })
    }
    from = match.index + match[0].length
  }
  if (!from) return null
  if (from < text.length) pieces.push(kind === 'google' ? { text: text.slice(from) } : { type: kind === 'responses' ? 'input_text' : 'text', text: text.slice(from) })
  return pieces
}

export function audioFetch(original, registry) {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const auxiliary = headers.get(PURPOSE_HEADER) === 'auxiliary'
    headers.delete(PURPOSE_HEADER)
    if (typeof init?.body !== 'string' || !init.body.includes('[mi-asistente-audio:')) return original(input, { ...init, headers })
    const kind = endpoint(input)
    if (!kind) throw new Error('Esta conexión no admite enviar el audio directamente; no se sustituyó por dictado.')
    const body = JSON.parse(init.body)
    const convert = content => typeof content === 'string' ? split(content, kind, registry, auxiliary) || content : Array.isArray(content)
      ? content.flatMap(part => typeof part.text === 'string' ? split(part.text, kind, registry, auxiliary) || [part] : [part]) : content
    if (kind === 'google') for (const item of body.contents || []) item.parts = convert(item.parts)
    else for (const item of kind === 'responses' ? body.input || [] : body.messages || []) {
      if (typeof item === 'object' && item) item.content = convert(item.content)
    }
    return original(input, { ...init, headers, body: JSON.stringify(body), redirect: 'error' })
  }
}
