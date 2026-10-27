/** Ephemeral mono PCM. Shared microphone only; no disk, storage, or extra permission. */
export type VoiceClip = { mime: 'audio/wav'; data: string }
type CaptureMode = 'wake' | 'command' | 'guard' | 'deaf'
type CaptureDiagnostic = { status: 'idle' | 'ready' | 'overflow' | 'missing'; durationMs: number }
const MAX_SECONDS = 60
const PRE_ROLL_SECONDS = 0.25
// Selection only, never a recognizer endpoint. Keep quiet/low speech rather than
// using a speech/noise classifier: only trim samples that quantize to PCM16 zero.
const PCM_ZERO = 0.5 / 32768
const CANDIDATE_GAP_SECONDS = 2
let context: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let mute: GainNode | null = null
let chunks: Float32Array[] = []
let samples = 0
let total = 0
let floor = 0
let armedAt: number | null = null
let startSample: number | null = null
let firstActivity: number | null = null
let candidate: number | null = null
let lastActivity: number | null = null
let ambiguous = false
let incomplete = false
let lastCapture: CaptureDiagnostic = { status: 'idle', durationMs: 0 }

/** Last extraction outcome, including across a wake reset. Never contains audio/text. */
export function captureDiagnostics(): CaptureDiagnostic { return { ...lastCapture } }
export function resetUtteranceAudio() {
  chunks = []; samples = 0; total = 0; floor = 0
  armedAt = null; startSample = null; firstActivity = null
  candidate = null; lastActivity = null; ambiguous = false; incomplete = false
}
export function stopUtteranceAudio() {
  if (processor) processor.onaudioprocess = null
  processor?.disconnect(); source?.disconnect(); mute?.disconnect()
  if (context) void context.close().catch(() => {})
  context = null; processor = null; source = null; mute = null
  resetUtteranceAudio()
  lastCapture = { status: 'idle', durationMs: 0 }
}
/** A trusted listening boundary. Re-arming a held utterance cannot cut its prefix. */
export function armUtteranceAudio() {
  if (!context || armedAt !== null || startSample !== null) return
  armedAt = total
  floor = total
  firstActivity = null
  candidate = null; lastActivity = null; ambiguous = false; incomplete = false
}
export async function startUtteranceAudio(stream: MediaStream, mode?: () => CaptureMode) {
  stopUtteranceAudio()
  const current = new AudioContext()
  context = current
  try {
    source = current.createMediaStreamSource(stream)
    processor = current.createScriptProcessor(4096, 1, 1)
    mute = current.createGain(); mute.gain.value = 0
    source.connect(processor); processor.connect(mute); mute.connect(current.destination)
    processor.onaudioprocess = event => {
      if (context !== current) return
      if (mode?.() === 'deaf') { resetUtteranceAudio(); return }
      const pcm = new Float32Array(event.inputBuffer.getChannelData(0))
      for (let i = 0; i < pcm.length; i++) {
        if (Math.abs(pcm[i]) <= PCM_ZERO) continue
        const at = total + i
        if (candidate === null || lastActivity !== null && at - lastActivity > current.sampleRate * CANDIDATE_GAP_SECONDS) {
          ambiguous = lastActivity !== null
          candidate = at
        }
        lastActivity = at
        if (firstActivity === null && (armedAt !== null || startSample !== null)) firstActivity = at
      }
      chunks.push(pcm); samples += pcm.length; total += pcm.length
      // Trim partial chunks too: even an unusually large callback stays bounded.
      const excess = () => samples - current.sampleRate * MAX_SECONDS
      while (excess() > 0 && chunks.length) {
        const first = chunks[0], remove = Math.min(first.length, excess())
        if (remove === first.length) chunks.shift()
        else chunks[0] = first.slice(remove)
        samples -= remove
      }
    }
    await current.resume()
  } catch (error) { if (context === current) stopUtteranceAudio(); throw error }
}
/** Raw NEW wake onset may replace an unaddressed snippet, while preserving the
 * passive PCM candidate already received before the browser delivered its event.
 * Other marks (interims, continuations, App wake dispatch) only freeze once. */
export function markUtteranceAudio(newWake = false, localSegment = false) {
  if (!context) return
  if (localSegment) {
    // Unlike late browser callbacks, local VAD confirms onset immediately.
    // Continuous room noise must not anchor a new clip to minutes-old PCM.
    startSample = Math.max(floor, total - Math.floor(context.sampleRate * PRE_ROLL_SECONDS))
    armedAt = null
    firstActivity = startSample
    incomplete = false
    return
  }
  if (!newWake && startSample !== null) return
  if (armedAt !== null) { startSample ??= armedAt; return }
  const previous = startSample
  const recent = lastActivity !== null && total - lastActivity <= context.sampleRate * CANDIDATE_GAP_SECONDS
  if (recent && candidate !== null) {
    // A late callback after multiple unmarked activity runs cannot prove which
    // run began the request. Fail closed instead of exporting only its tail.
    incomplete = ambiguous && previous === null || newWake && previous !== null && candidate <= previous
    startSample = Math.max(floor, candidate - Math.floor(context.sampleRate * PRE_ROLL_SECONDS))
    firstActivity = candidate
    if (newWake && previous !== null && candidate > previous) floor = startSample
  } else {
    startSample = Math.max(floor, total - Math.floor(context.sampleRate * PRE_ROLL_SECONDS))
    firstActivity = null
    incomplete = false
  }
}

export function pcmWav(input: Float32Array, sampleRate: number): Uint8Array {
  const count = Math.floor(input.length * 16000 / sampleRate)
  const bytes = new Uint8Array(44 + count * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, count * 2, true)
  for (let i = 0; i < count; i++) {
    const at = i * sampleRate / 16000
    const left = Math.floor(at), fraction = at - left
    const value = Math.max(-1, Math.min(1, input[left] * (1 - fraction) + (input[left + 1] ?? input[left]) * fraction))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}
export function takeUtteranceAudio(): VoiceClip | undefined {
  const current = context
  const boundary = startSample ?? armedAt
  const activity = firstActivity
  const failed = incomplete
  const selectedStart = current && boundary !== null && activity !== null
    ? Math.max(floor, boundary, activity - Math.floor(current.sampleRate * PRE_ROLL_SECONDS)) : null
  const durationMs = current && selectedStart !== null ? (total - selectedStart) * 1000 / current.sampleRate : 0
  const oldest = total - samples
  const available = current && selectedStart !== null && !failed && selectedStart >= oldest && durationMs < MAX_SECONDS * 1000
  // Dispatch consumes the boundary even when encoding is impossible. Never
  // resend an old turn on a later mark or retry after an overflow fallback.
  floor = total
  startSample = null; armedAt = null; firstActivity = null
  candidate = null; lastActivity = null; ambiguous = false; incomplete = false
  if (current && selectedStart !== null && (selectedStart < oldest || durationMs >= MAX_SECONDS * 1000)) {
    lastCapture = { status: 'overflow', durationMs }; return
  }
  if (!available || durationMs < 150) { lastCapture = { status: 'missing', durationMs }; return }
  const pcm = new Float32Array(total - selectedStart)
  let at = oldest, offset = 0
  for (const chunk of chunks) {
    const skip = Math.max(0, selectedStart - at)
    if (skip < chunk.length) { const part = chunk.subarray(skip); pcm.set(part, offset); offset += part.length }
    at += chunk.length
  }
  const bytes = pcmWav(pcm, current.sampleRate)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  lastCapture = { status: 'ready', durationMs }
  return { mime: 'audio/wav', data: btoa(binary) }
}
