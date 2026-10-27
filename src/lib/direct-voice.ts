import { SPEECH_LANG } from '../config'
import { startVad, type Vad } from './vad'
import { markUtteranceAudio, takeUtteranceAudio, resetUtteranceAudio, type VoiceClip } from './utterance-audio'
import { currentProfile, wakePattern } from './profile'
import { reportVoiceInput } from './voice-input-mode'
import { createVoiceTiming } from './voice-timing'
import type { Voice, VoiceHandlers } from './voice'

export type DirectVoiceDiagnostics = {
  running: boolean
  captions: 'starting' | 'available' | 'unavailable' | 'stopped'
  segment: 'idle' | 'speaking' | 'quiet' | 'held'
  segments: number
  sent: number
  wakes: number
  mode: ReturnType<VoiceHandlers['mode']>
  error: 'capture' | 'vad' | null
}
const emptyDiagnostics = (): DirectVoiceDiagnostics => ({
  running: false, captions: 'stopped', segment: 'idle', segments: 0, sent: 0, wakes: 0, mode: 'deaf', error: null,
})
let diagnostics = emptyDiagnostics()
/** Metadata only; no captions, transcript, clip, user name or provider error text. */
export function getDirectVoiceDiagnostics(): DirectVoiceDiagnostics { return { ...diagnostics } }

export type ClipHandlers = VoiceHandlers & { onClip?: (clip: VoiceClip, traceId?: string) => void }

/** Pauses dispatch PCM, not recognizer text. The optional browser recognizer
 * supplies wake activation and captions only; it never decides an audio turn. */
export async function startDirectVoice(h: ClipHandlers): Promise<Voice> {
  const diag = emptyDiagnostics()
  diagnostics = diag
  diag.mode = h.mode()
  diag.captions = 'starting'
  const timing = createVoiceTiming()
  let stopped = false
  let epoch = 0
  let segmentEpoch = 0
  let active = false
  let held: { clip: VoiceClip; traceId?: string } | null = null
  let vad: Vad | null = null
  let recognizer: any = null
  let browserDisabled = false
  let restart: ReturnType<typeof setTimeout> | undefined
  let caption = ''
  let wakeOnlyGreeting: RegExp | null = null

  const deliver = (item: { clip: VoiceClip; traceId?: string }) => {
    diag.segment = 'idle'
    if (h.onClip) { diag.sent++; h.onClip(item.clip, item.traceId) }
  }
  const activate = () => {
    const mode = h.mode()
    if (!held || mode === 'wake' || mode === 'deaf') return
    const item = held
    held = null
    deliver(item)
  }
  const closeBrowser = () => {
    if (restart) clearTimeout(restart)
    restart = undefined
    const old = recognizer
    recognizer = null
    diag.captions = stopped ? 'stopped' : browserDisabled ? 'unavailable' : 'starting'
    if (!old) return
    old.onstart = null; old.onresult = null; old.onend = null; old.onerror = null; old.onspeechstart = null
    try { old.abort() } catch { /* optional captions already stopped */ }
  }
  const browser = () => {
    if (stopped || browserDisabled || recognizer) return
    const Ctor = typeof window === 'undefined' ? undefined
      : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!Ctor) {
      browserDisabled = true
      diag.captions = 'unavailable'
      reportVoiceInput('Audio directo activo. El dictado visual no está disponible; activa la escucha con Espacio.')
      return
    }
    try {
      const rec = new Ctor()
      recognizer = rec
      const mine = epoch
      const current = () => !stopped && mine === epoch && recognizer === rec
      rec.continuous = true
      rec.interimResults = true
      rec.lang = currentProfile().language || SPEECH_LANG
      rec.onstart = () => { if (current()) diag.captions = 'available' }
      rec.onspeechstart = () => { if (current()) caption = '' }
      rec.onresult = (event: any) => {
        if (!current() || h.mode() === 'deaf') return
        let interim = '', fresh = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript as string
          if (event.results[i].isFinal) fresh += ` ${text}`
          else interim += ` ${text}`
        }
        if (h.mode() === 'wake' && h.requireGreeting?.()) {
          const incoming = `${fresh} ${interim}`.trim()
          if (/^hola\b/iu.test(incoming) || !/^hola\b/iu.test(caption.trim())) caption = ''
        }
        caption += fresh
        const full = `${caption} ${interim}`.replace(/\s+/g, ' ').trim()
        if (!full) return
        h.onPartial(full)
        if (h.mode() !== 'wake') {
          if (wakeOnlyGreeting) {
            const greeting = wakeOnlyGreeting.exec(full)
            const rest = greeting ? full.slice(greeting.index + greeting[0].length).replace(/^[\s,.:;!?-]+/, '').trim() : full
            if (rest) {
              wakeOnlyGreeting = null
              h.onSpeechStart()
              activate()
            }
          }
          return
        }
        const pattern = wakePattern(currentProfile(), h.requireGreeting?.() ? 'greeting' : 'any')
        const match = pattern.exec(full)
        if (!match) return
        // Wake text is for activation only. App must not submit it as a question.
        const trailing = full.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, '').trim()
        // An interim wake can lag behind audio already containing the question.
        // Do not reset VAD/PCM. A recognized greeting alone activates input but
        // keeps its clip local until further words establish a question.
        if (h.requireGreeting?.() && !trailing) {
          wakeOnlyGreeting = pattern
        }
        diag.wakes++
        h.onWake(trailing)
        if (wakeOnlyGreeting && held) diag.segment = 'held'
        else activate()
      }
      rec.onerror = (event: any) => {
        if (!current()) return
        if (event.error === 'aborted' || event.error === 'no-speech') return
        browserDisabled = true
        closeBrowser()
        reportVoiceInput('Audio directo activo sin dictado visual. Puedes activar la escucha con Espacio.')
      }
      rec.onend = () => {
        if (!current()) return
        recognizer = null
        diag.captions = 'starting'
        restart = setTimeout(browser, 80)
      }
      rec.start()
    } catch {
      closeBrowser()
      browserDisabled = true
      diag.captions = 'unavailable'
      reportVoiceInput('Audio directo activo sin dictado visual. Puedes activar la escucha con Espacio.')
    }
  }

  try {
    vad = await startVad({
      onStart() {
        if (stopped) return
        // A confirmed activation authorizes the buffered prefix. If captions
        // lag past a six-second boundary, the next speech onset is continuation:
        // preserve that whole prefix before sending its new clip.
        const prefix = wakeOnlyGreeting ? held : null
        wakeOnlyGreeting = null
        held = null // Unaddressed standby audio remains local/discarded.
        caption = ''
        segmentEpoch = epoch
        const mode = h.mode()
        active = mode !== 'deaf'
        diag.mode = mode
        diag.segment = active ? 'speaking' : 'idle'
        if (active) { diag.segments++; diag.error = null }
        if (!active) { timing.cancel(); resetUtteranceAudio(); return }
        timing.onset()
        markUtteranceAudio(mode === 'wake', true)
        if (mode === 'guard') timing.mark('voice.interruption')
        if (mode === 'command' || mode === 'guard') {
          h.onSpeechStart()
          if (prefix) {
            deliver(prefix)
            // More speech is already active. Preserve the prefix through the
            // ordered direct-audio lane without starting an answer to it alone.
            h.onSpeechStart()
          }
        }
      },
      onQuiet() {
        if (stopped || !active || segmentEpoch !== epoch) return
        timing.endpoint()
        diag.segment = 'quiet'
      },
      onResume() {
        if (stopped || !active || segmentEpoch !== epoch) return
        timing.endpointed('cancelled')
        diag.segment = 'speaking'
      },
      onBoundary(reason) {
        if (stopped || !active || segmentEpoch !== epoch) return
        timing.endpointed(reason === 'silence' ? 'ok' : 'cancelled')
      },
      onEnd() {
        if (stopped || !active || segmentEpoch !== epoch) return
        active = false
        diag.segment = 'idle'
        // PCM-only VAD invokes this synchronously at the pause/max-duration
        // boundary, before the next speech onset can replace the selection.
        const clip = takeUtteranceAudio()
        if (!clip) {
          timing.cancel('error')
          diag.error = 'capture'
          h.onError('No se pudo capturar el audio completo. Vuelve a decirlo; no se enviará el dictado como sustituto.')
          return
        }
        const mode = h.mode()
        if (mode === 'deaf') { timing.cancel(); return }
        const traceId = timing.dispatch()
        const item = { clip, traceId }
        if (mode === 'wake' || wakeOnlyGreeting) { held = item; diag.segment = 'held' }
        else deliver(item)
      },
      onLevel() { if (!stopped) diag.mode = h.mode() },
      onError(message) { if (!stopped) { diag.running = false; diag.error = 'vad'; diag.segment = 'idle'; timing.cancel('error'); h.onError(message) } },
    }, { pcmOnly: true, maxSegmentMs: 6000, guard: () => h.mode() === 'guard' })
    if (stopped) { vad.stop(); return { stop() {}, live: () => false } }
    diag.running = vad.live()
    browser()
  } catch (error) {
    stopped = true
    diag.running = false; diag.error = 'vad'; diag.segment = 'idle'; diag.captions = 'stopped'
    timing.cancel('error')
    closeBrowser()
    vad?.stop()
    throw error
  }

  return {
    live: () => !stopped && (vad?.live() ?? false),
    reset() {
      if (stopped) return
      epoch++
      active = false; held = null; caption = ''; wakeOnlyGreeting = null
      diag.segment = 'idle'; diag.error = null
      timing.cancel()
      vad?.reset?.()
      closeBrowser()
      resetUtteranceAudio()
      browser()
    },
    stop() {
      if (stopped) return
      stopped = true
      epoch++
      active = false; held = null; caption = ''; wakeOnlyGreeting = null
      diag.running = false; diag.segment = 'idle'; diag.mode = 'deaf'
      timing.cancel()
      closeBrowser()
      vad?.stop()
    },
  }
}
