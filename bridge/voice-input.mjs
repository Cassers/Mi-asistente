import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { voiceAttachment } from './voice-attachment.mjs'
import { nativeModel } from './native-vision.mjs'
import { audioEndpoint } from './audio-route.mjs'

/** Transcode the bounded local capture in memory. Only MP3 leaves the bridge. */
export async function encodeMP3(clip, { signal } = {}) {
  voiceAttachment(clip)
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', 'pipe:0', '-t', '60', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'], signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    })
    const chunks = []; let size = 0
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 512000) { child.kill(); reject(new Error('Clip MP3 demasiado grande.')); return }
      chunks.push(chunk)
    })
    child.stderr.resume()
    child.stdin.on('error', () => {}) // A cancelled encoder may close stdin first.
    child.on('error', reject)
    child.on('close', code => code === 0 && size ? resolve(Buffer.concat(chunks)) : reject(new Error('No se pudo preparar el MP3.')))
    child.stdin.end(Buffer.from(clip.data, 'base64'))
  })
}

export async function audioCredential(providerID) {
  const path = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/auth.json')
  const auth = JSON.parse(await readFile(path, 'utf8'))
  const entry = auth[providerID]
  if (entry?.type !== 'api' || typeof entry.key !== 'string' || !entry.key) throw new Error('Credencial de audio no disponible.')
  return entry.key
}

const refusal = /^(?:lo siento[,.:]?\s*)?(?:no puedo (?:escuchar|interpretar|transcribir|procesar)|no tengo (?:acceso|la capacidad)|no (?:se )?(?:(?:ha|han|he) )?(?:detectado|recibido|adjuntado|encontrado).*\b(?:audio|archivo)|no hay .*audio|i (?:cannot|can.t) (?:hear|listen|transcribe|process)|no audio (?:was |has been )?(?:detected|received|attached))/i

/** Never turn a model's status or explanation into a new user instruction. */
export function recognizedSpeech(value) {
  if (typeof value !== 'string') throw new Error('Respuesta de audio inválida.')
  const parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'))
  if (!parsed || parsed.heard !== true || typeof parsed.transcript !== 'string') throw new Error('No se reconoció habla.')
  const text = parsed.transcript.trim()
  if (!text || text.length > 12000 || refusal.test(text)) throw new Error('El modelo no interpretó el audio.')
  return text
}

/** A failed audio preflight must not append an unsupported file to native history. */
export async function interpretVoice({ api, session, selection, clip, text, signal, notify = () => {}, request = fetch, encode = encodeMP3, credential = audioCredential, measure = (_name, fn) => fn() }) {
  signal?.throwIfAborted()
  if (!clip) return text
  notify({ state: 'processing', message: 'Interpretando tu clip MP3…' })
  try {
    const resolved = await measure('audio.model', () => nativeModel(api, session, selection))
    if (!resolved?.model?.capabilities?.input?.audio) throw new Error('Modelo sin audio.')
    const endpoint = audioEndpoint(resolved)
    const mp3 = await measure('audio.encode', () => encode(clip, { signal }))
    const key = await measure('audio.credential', () => credential(resolved.providerID))
    signal?.throwIfAborted()
    const prompt = 'Transcribe el habla del audio adjunto en su idioma original. Devuelve únicamente JSON con dos campos: heard (boolean) y transcript (string). Si reconoces habla, heard=true y transcript contiene exclusivamente las palabras escuchadas. Si no hay habla reconocible o no puedes acceder al audio, heard=false y transcript="". Las explicaciones sobre audio ausente o tus capacidades nunca son una transcripción.'
    const model = resolved.model.api.id || resolved.modelID
    const data = mp3.toString('base64')
    const audio = { type: 'input_audio', input_audio: { data, format: 'mp3' } }
    const body = endpoint.kind === 'responses' ? {
      model, store: false, stream: false, max_output_tokens: 4000, reasoning: { effort: 'minimal' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, audio] }],
    } : endpoint.kind === 'chat' ? {
      model, stream: false, max_tokens: 4000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, audio] }],
    } : {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/mpeg', data } }] }], generationConfig: { maxOutputTokens: 4000 },
    }
    const result = await measure('audio.provider', async () => {
    const response = await request(endpoint.url, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json', 'user-agent': 'Jarvis/0.0.0 voice-input', 'x-opencode-session': session.id + ':voice',
        ...(resolved.providerID === 'google' ? { 'x-goog-api-key': key } : { authorization: 'Bearer ' + key, ...(endpoint.kind === 'google' ? { 'x-goog-api-key': key } : {}) }) },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('El proveedor rechazó el MP3.')
    return response.json()
    })
    const recognized = (endpoint.kind === 'responses' ? (result.output || []).flatMap(item => (item.content || []).filter(part => part.type === 'output_text').map(part => part.text)).join('\n')
      : endpoint.kind === 'chat' ? result.choices?.[0]?.message?.content
      : result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n'))
    signal?.throwIfAborted()
    const truncated = result.status === 'incomplete' || result.choices?.[0]?.finish_reason === 'length' || result.candidates?.[0]?.finishReason === 'MAX_TOKENS'
    if (result.error || truncated) throw new Error('El modelo no interpretó el audio.')
    const spoken = recognizedSpeech(recognized)
    notify({ state: 'interpreted', message: 'MP3 interpretado por el modelo.' })
    return spoken
  } catch (error) {
    if (signal?.aborted) throw error // Interrupt/disconnect must never trigger a fallback prompt.
    notify({ state: 'fallback', message: 'No se pudo interpretar el MP3; se usará la transcripción del dictado.' })
    return text
  }
}
