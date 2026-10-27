import { randomUUID } from 'node:crypto'
import { encodeMP3 } from './voice-input.mjs'
import { nativeModel } from './native-vision.mjs'
import { audioEndpoint } from './audio-route.mjs'

/** No transcript/provider preflight: encode locally, then let native OpenCode
 * make the actual conversation request with its original context and tools. */
export async function directAudio({ api, session, selection, clip, signal, measure = (_name, fn) => fn(), encode = encodeMP3 }) {
  const model = await measure('audio.model', () => nativeModel(api, session, selection))
  if (!model?.model?.capabilities?.input?.audio) throw new Error('El modelo seleccionado no acepta audio. Elige uno compatible o activa explícitamente el modo dictado.')
  audioEndpoint(model)
  const config = await api('GET', '/config')
  if (!config.plugin?.some(entry => String(Array.isArray(entry) ? entry[0] : entry).endsWith('/opencode-audio-plugin.mjs'))) {
    throw new Error('Este servidor OpenCode necesita el adaptador de audio directo. Inícialo con el lanzador actualizado de la aplicación.')
  }
  signal?.throwIfAborted()
  const mp3 = await measure('audio.encode', () => encode(clip, { signal }))
  signal?.throwIfAborted()
  return { type: 'file', mime: 'audio/mpeg', filename: `mi-asistente-voice-${randomUUID()}.mp3`, url: 'data:audio/mpeg;base64,' + mp3.toString('base64') }
}
