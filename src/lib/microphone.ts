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
      let replacement: Promise<boolean> | undefined
      // Subscribe before permission/driver awaits. Forward the startup result to
      // the replacement owner so an app switch cannot revive the old capture.
      unsubscribe = subscribeVoiceInputMode(() => {
        if (current() && currentVoiceInputMode() !== selectedMode) replacement = owner.start()
      })
      setMicBlocked(false)
      let failed = false
      try {
        // Animation failure must not prevent speech recognition.
        await startAnalyser().catch(() => {})
        if (!current()) return replacement ?? false
        const stream = await getMic()
        if (!current()) return replacement ?? false
        const capturing = startUtteranceAudio(stream, () => current() ? handlers.mode() : 'deaf')
        if (selectedMode === 'direct') await capturing
        else await capturing.catch(() => {})
        if (!current()) return replacement ?? false
        // Old direct callbacks must never become fresh Codex dictation, even
        // when a third-party driver completes after its owner was replaced.
        const accepting = () => current() && currentVoiceInputMode() === selectedMode
        const callbacks: ClipHandlers = {
          requireGreeting: () => accepting() && !!handlers.requireGreeting?.(),
          mode: () => accepting() ? handlers.mode() : 'deaf',
          onAudioStart: (continuation = false) => { if (accepting()) markUtteranceAudio(handlers.mode() === 'wake' && !continuation) },
          onWake: (text, traceId) => { if (accepting()) handlers.onWake(text, traceId) },
          onSpeechStart: () => { if (accepting()) { markUtteranceAudio(); handlers.onSpeechStart() } },
          onPartial: text => { if (accepting()) handlers.onPartial(text) },
          onUtterance: (text, traceId) => { if (accepting()) handlers.onUtterance(text, traceId) },
          onClip: (clip, traceId) => { if (accepting()) handlers.onClip?.(clip, traceId) },
          onError: message => {
            if (!accepting()) return
            activating.end('error')
            // A rejected direct segment is visible but does not kill capture.
            if (!input) failed = true
            handlers.onError(message)
          },
        }
        const started = await (selectedMode === 'direct' ? startDirectVoice(callbacks) : startVoice(callbacks, { browserOnly: selectedMode === 'transcript' }))
        if (!current()) { started.stop(); return replacement ?? false }
        input = started
        if (failed) { stop(); return false }
        if (currentVoiceInputMode() !== selectedMode) return owner.start()
        activating.end()
        return true
      } catch (error) {
        activating.end('error')
        if (current()) {
          stop()
          handlers.onError(error instanceof Error ? error.message : 'No se pudo activar el micrófono.')
        }
        return replacement ?? false
      } finally {
        activating.end(current() ? 'error' : 'cancelled')
        if (activation === activating) activation = undefined
      }
    },
  }
  return owner
}
