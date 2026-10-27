import { getMic, setMicBlocked, startAnalyser } from './audio'
import { startUtteranceAudio, stopUtteranceAudio, resetUtteranceAudio, markUtteranceAudio } from './utterance-audio'
import { startVoice, type Voice } from './voice'
import { startDirectVoice, type ClipHandlers } from './direct-voice'
import { currentVoiceInputMode, subscribeVoiceInputMode } from './voice-input-mode'
import { timingSpan, timingTrace, type TimingSpan } from './voice-timing'

/** Owns all browser voice capture. Late callbacks cannot cross an off/on cycle. */
export function createMicrophone(handlers: ClipHandlers) {
  let unsubscribe: (() => void) | undefined
  let activation: TimingSpan | undefined
  let generation = 0
  let input: Voice | null = null
  const stop = () => {
    unsubscribe?.(); unsubscribe = undefined
    activation?.end('cancelled')
    activation = undefined
    generation++
    input?.stop()
    input = null
    stopUtteranceAudio()
    setMicBlocked(true)
  }
  const owner = {
    stop,
    reset: () => { resetUtteranceAudio(); input?.reset?.() },
    live: () => input?.live() ?? false,
    commit: (): boolean => {
      const mine = generation, active = input
      const mode = handlers.mode()
      if (mine !== generation || !active || active !== input || mode !== 'command' && mode !== 'guard') return false
      return active.commit?.() ?? false
    },
    start: async (): Promise<boolean> => {
      stop()
      const activating = timingSpan('voice.activation', timingTrace())
      activation = activating
      const selectedMode = currentVoiceInputMode()
      const mine = generation
      const current = () => mine === generation
      setMicBlocked(false)
      let failed = false
      try {
        // Animation failure must not prevent speech recognition.
        await startAnalyser().catch(() => {})
        if (!current()) return false
        const stream = await getMic()
        if (!current()) return false
        const capturing = startUtteranceAudio(stream, () => current() ? handlers.mode() : 'deaf')
        if (selectedMode === 'direct') await capturing
        else await capturing.catch(() => {})
        if (!current()) return false
        const callbacks: ClipHandlers = {
          requireGreeting: () => current() && !!handlers.requireGreeting?.(),
          mode: () => current() ? handlers.mode() : 'deaf',
          onAudioStart: (continuation = false) => { if (current()) markUtteranceAudio(handlers.mode() === 'wake' && !continuation) },
          onWake: (text, traceId) => { if (current()) handlers.onWake(text, traceId) },
          onSpeechStart: () => { if (current()) { markUtteranceAudio(); handlers.onSpeechStart() } },
          onPartial: text => { if (current()) handlers.onPartial(text) },
          onUtterance: (text, traceId) => { if (current()) handlers.onUtterance(text, traceId) },
          onClip: (clip, traceId) => { if (current()) handlers.onClip?.(clip, traceId) },
          onError: message => {
            if (!current()) return
            activating.end('error')
            // A rejected direct segment is visible but does not kill capture.
            if (!input) failed = true
            handlers.onError(message)
          },
        }
        const started = await (selectedMode === 'direct' ? startDirectVoice(callbacks) : startVoice(callbacks, { browserOnly: selectedMode === 'transcript' }))
        if (!current()) { started.stop(); return false }
        input = started
        if (failed) { stop(); return false }
        if (currentVoiceInputMode() !== selectedMode) return owner.start()
        unsubscribe = subscribeVoiceInputMode(() => {
          if (current() && currentVoiceInputMode() !== selectedMode) void owner.start()
        })
        activating.end()
        return true
      } catch (error) {
        activating.end('error')
        if (current()) {
          stop()
          handlers.onError(error instanceof Error ? error.message : 'No se pudo activar el micrófono.')
        }
        return false
      } finally {
        activating.end(current() ? 'error' : 'cancelled')
        if (activation === activating) activation = undefined
      }
    },
  }
  return owner
}
