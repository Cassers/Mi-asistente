import { access, stat, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWhisperProcess, WhisperError } from './whisper-process.mjs'
export { WhisperError } from './whisper-process.mjs'

export const WHISPER_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxSeconds: 120 })
const TYPES = Object.freeze({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/ogg': 'ogg', 'audio/webm': 'matroska,webm', 'audio/mp4': 'mov',
  'audio/x-m4a': 'mov', 'audio/aac': 'aac',
})
const LANGUAGES = new Set(('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue').split(' '))
const format = contentType => {
  if (typeof contentType !== 'string' || contentType.length > 180) throw new WhisperError(415, 'Indica un tipo de audio compatible.')
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (!TYPES[type]) throw new WhisperError(415, 'Formato no compatible. Usa WAV, MP3, FLAC, Ogg, WebM, MP4/M4A o AAC.')
  return TYPES[type]
}
const languageCode = value => {
  const code = value === undefined || value === '' ? 'auto' : value
  if (typeof code !== 'string' || (code !== 'auto' && !LANGUAGES.has(code))) throw new WhisperError(400, 'Idioma inválido. Usa auto o un código de idioma compatible, como es o en.')
  return code
}
async function executable(value, env) {
  const candidates = isAbsolute(value) || value.includes('/') ? [resolve(value)] : (env.PATH || '').split(delimiter).filter(Boolean).map(dir => resolve(dir, value))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate } catch {}
  }
  return null
}
export async function detectWhisper(env = process.env) {
  const localCLI = fileURLToPath(new URL('../.runtime/whisper.cpp/build/bin/whisper-cli', import.meta.url))
  const cli = env.JARVIS_WHISPER_CLI ? await executable(env.JARVIS_WHISPER_CLI, env)
    : await executable(localCLI, env) || await executable('whisper-cli', env)
  if (!cli) return { available: false, reason: 'Falta whisper-cli de whisper.cpp. Configura JARVIS_WHISPER_CLI y vuelve a comprobar.' }
  const model = env.JARVIS_WHISPER_MODEL || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'), 'voxtype/models/ggml-large-v3-turbo.bin')
  try {
    if (!isAbsolute(model) || !(await stat(model)).isFile() || (await stat(model)).size < 1024) throw Error()
    await access(model, constants.R_OK)
  } catch { return { available: false, reason: 'Falta un modelo GGML legible. Configura JARVIS_WHISPER_MODEL y vuelve a comprobar.' } }
  const ffmpeg = await executable(env.JARVIS_WHISPER_FFMPEG || 'ffmpeg', env)
  if (!ffmpeg) return { available: false, reason: 'Falta FFmpeg para preparar el audio local.' }
  return { available: true, cli, model: resolve(model), ffmpeg }
}
async function readBytes(source, maxBytes, signal) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    if (!source.length) throw new WhisperError(400, 'El archivo de audio está vacío.')
    if (source.length > maxBytes) throw new WhisperError(413, 'El audio supera el límite de bytes.')
    return Buffer.from(source)
  }
  if (!source || !source[Symbol.asyncIterator]) throw new WhisperError(400, 'Envía bytes de audio, no una ruta ni una URL.')
  const chunks = []; let size = 0
  // Do not destroy IncomingMessage on overflow: the HTTP caller still returns 413.
  const iterator = source.iterator ? source.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]()
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = iterator.next()
      const result = await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        next.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
        if (signal.aborted) aborted()
      })
      if (result.done) break
      if (!Buffer.isBuffer(result.value) && !(result.value instanceof Uint8Array)) throw new WhisperError(400, 'Envía bytes de audio.')
      size += result.value.length
      if (size > maxBytes) throw new WhisperError(413, 'El audio supera el límite de bytes.')
      chunks.push(result.value)
    }
  } finally {
    // return() can wait forever behind a stalled iterator.next(). Do not await it.
    void iterator.return?.().catch(() => {})
  }
  if (!size) throw new WhisperError(400, 'El archivo de audio está vacío.')
  return Buffer.concat(chunks)
}
function pcmWave(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
function validatePCM(pcm, maxSeconds) {
  const samples = pcm.length / 2
  if (!samples || !Number.isInteger(samples)) throw new WhisperError(422, 'El archivo no contiene audio decodificable.')
  if (samples > maxSeconds * 16000) throw new WhisperError(413, 'El audio supera la duración permitida.')
  // AC energy rejects silence, DC offsets and isolated clicks before Whisper can hallucinate.
  let audible = 0
  for (let at = 0; at + 320 <= samples; at += 320) {
    let sum = 0, squares = 0
    for (let i = at; i < at + 320; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v; squares += v * v }
    if (Math.sqrt(Math.max(0, squares / 320 - (sum / 320) ** 2)) >= 0.002) audible += 320
  }
  if (audible < 1600) throw new WhisperError(422, 'Audio vacío, silencioso o demasiado débil. No se generó una transcripción.')
}
function transcriptJSON(raw) {
  let value
  try { value = JSON.parse(raw) } catch { throw new WhisperError(502, 'Whisper no produjo una respuesta JSON válida.') }
  if (!Array.isArray(value.transcription) || value.transcription.length > 4096 || value.transcription.some(s => typeof s?.text !== 'string')) throw new WhisperError(502, 'Whisper devolvió una transcripción inválida.')
  const text = value.transcription.map(s => s.text).join('').trim()
  if (text.length > 32000) throw new WhisperError(502, 'La transcripción supera el límite de salida.')
  if (!text || !/[\p{L}\p{N}]/u.test(text) || /^(?:\s|\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>)+$/.test(text)) throw new WhisperError(422, 'Whisper no reconoció palabras. Revisa el audio e inténtalo de nuevo.')
  const language = value.result?.language
  return { text, ...(LANGUAGES.has(language) ? { language } : {}) }
}

export class Whisper {
  constructor({ env = process.env, detect = () => detectWhisper(env), run = runWhisperProcess,
    limits = WHISPER_LIMITS, tempRoot = tmpdir(), readTimeout = 15000, decodeTimeout = 15000, transcriptionTimeout = 180000 } = {}) {
    Object.assign(this, { detect, run, limits, tempRoot, readTimeout, decodeTimeout, transcriptionTimeout })
    this.current = null; this.closed = false
  }
  async availability() {
    const runtime = await this.detect()
    return { engine: 'whisper', available: !this.closed && runtime.available,
      ...(runtime.available ? { model: basename(runtime.model) } : { reason: runtime.reason }),
      ...(this.closed ? { reason: 'El puente se está cerrando.' } : {}), ...this.limits, formats: Object.keys(TYPES) }
  }
  async transcribe(source, { contentType, language, contentLength, signal } = {}) {
    const demuxer = format(contentType), code = languageCode(language)
    if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) > this.limits.maxBytes)) throw new WhisperError(413, 'El audio supera el límite de bytes.')
    if (this.closed) throw new WhisperError(503, 'El puente se está cerrando.')
    if (this.current) throw new WhisperError(409, 'Whisper está ocupado. Espera a que termine o cancela y vuelve a intentarlo.')
    signal?.throwIfAborted()
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const current = { controller }; this.current = current
    current.done = this.perform(source, { demuxer, code, signal: combined })
    try { return await current.done }
    finally { if (this.current === current) this.current = null }
  }
  async perform(source, { demuxer, code, signal }) {
    let folder
    try {
      const runtime = await this.detect()
      if (!runtime.available) throw new WhisperError(503, runtime.reason)
      signal.throwIfAborted()
      const readController = new AbortController()
      const readTimer = setTimeout(() => readController.abort(new WhisperError(408, 'Se agotó el tiempo para recibir el audio.')), this.readTimeout)
      let audio
      try { audio = await readBytes(source, this.limits.maxBytes, AbortSignal.any([signal, readController.signal])) }
      finally { clearTimeout(readTimer) }
      signal.throwIfAborted()
      folder = await mkdtemp(join(this.tempRoot, 'mi-asistente-whisper-'))
      const encoded = join(folder, 'upload.audio')
      await writeFile(encoded, audio, { mode: 0o600, flag: 'wx' })
      signal.throwIfAborted()
      const pcm = await this.run(runtime.ffmpeg, [
        '-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-err_detect', 'explode',
        '-protocol_whitelist', 'file', '-format_whitelist', demuxer, '-f', demuxer === 'matroska,webm' ? 'matroska' : demuxer,
        ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
        '-i', encoded, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
      ], { signal, timeout: this.decodeTimeout, maxOutput: this.limits.maxSeconds * 32000,
        outputError: new WhisperError(413, 'El audio supera la duración permitida.'), failure: 'Audio dañado o no compatible. No se pudo decodificar.' })
      validatePCM(pcm, this.limits.maxSeconds)
      signal.throwIfAborted()
      const wav = join(folder, 'input.wav'), output = join(folder, 'result')
      await writeFile(wav, pcmWave(pcm), { mode: 0o600, flag: 'wx' })
      await this.run(runtime.cli, ['--model', runtime.model, '--file', wav, '--language', code, '--threads', '4',
        '--output-json', '--output-file', output, '--no-prints', '--no-timestamps'],
      { signal, timeout: this.transcriptionTimeout, maxOutput: 256 * 1024, failure: 'Whisper no pudo transcribir el audio. Revisa el modelo y vuelve a intentarlo.' })
      signal.throwIfAborted()
      let raw
      try {
        if ((await stat(output + '.json')).size > 256 * 1024) throw Error()
        raw = await readFile(output + '.json', 'utf8')
      } catch { throw new WhisperError(502, 'Whisper no generó una salida JSON válida dentro del límite.') }
      return { ...transcriptJSON(raw), engine: 'whisper', model: basename(runtime.model) }
    } finally { if (folder) await rm(folder, { recursive: true, force: true }) }
  }
  async close() {
    this.closed = true
    const current = this.current
    current?.controller.abort(new DOMException('El puente se está cerrando.', 'AbortError'))
    await current?.done.catch(() => {})
  }
}
