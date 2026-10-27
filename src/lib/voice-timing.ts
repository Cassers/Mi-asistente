import { startTiming, newTrace, markTiming, recordTimingDuration } from './timings'

export type TimingStatus = 'ok' | 'error' | 'cancelled' | 'fallback' | 'timeout' | 'detached'
export type TimingSpan = { end: (status?: TimingStatus) => void }
export type VoiceTimingLabel = 'voice.activation' | 'voice.recognition' | 'voice.endpoint' | 'voice.assembly' | 'voice.input' | 'voice.followup' | 'voice.interruption' | 'turn.first_audio' | 'turn.total' | 'tts.first_audio' | 'tts.synthesis' | 'tts.queue' | 'tts.playback' | 'tts.total'

// Instrumentation is an observer: even a broken collector cannot stop voice.
export function timingTrace(): string | undefined {
  try { return newTrace() } catch { return undefined }
}
export function timingSpan(name: VoiceTimingLabel, traceId?: string): TimingSpan {
  let span: ReturnType<typeof startTiming> | undefined
  try { if (traceId) span = startTiming(name, traceId) } catch { /* observer only */ }
  let ended = false
  return { end(status = 'ok') {
    if (ended) return
    ended = true
    try { span?.end(status) } catch { /* observer only */ }
  } }
}
export function timingMark(name: VoiceTimingLabel, traceId?: string): void {
  try { if (traceId) markTiming(name, traceId) } catch { /* observer only */ }
}
export function timingCapture(durationMs: number, ready: boolean, traceId?: string) {
  try { if (traceId) recordTimingDuration('audio.capture', durationMs, traceId, ready ? 'ok' : 'fallback') } catch { /* Observer only. */ }
}

/** One owner per recognizer. Dispatch retires the input before calling App,
 * so a synchronous wake reset cannot cancel or reuse a dispatched trace. */
export function createVoiceTiming() {
  let current: { id?: string; input: TimingSpan; recognition?: TimingSpan; endpoint?: TimingSpan; assembly?: TimingSpan } | undefined
  const ensure = () => {
    if (!current) {
      const id = timingTrace()
      current = { id, input: timingSpan('voice.input', id) }
    }
    return current
  }
  const finish = (status: TimingStatus = 'ok') => {
    const old = current
    current = undefined
    old?.recognition?.end(status)
    old?.endpoint?.end(status)
    old?.assembly?.end(status)
    old?.input.end(status)
    return old?.id
  }
  return {
    onset() { ensure() },
    recognizing() {
      const state = ensure()
      state.recognition ??= timingSpan('voice.recognition', state.id)
      // A segment's delayed completion must never close the next segment/turn.
      const span = state.recognition
      return (status: TimingStatus = 'ok') => {
        span.end(status)
        if (state.recognition === span) state.recognition = undefined
      }
    },
    endpoint() {
      if (current) current.endpoint ??= timingSpan('voice.endpoint', current.id)
    },
    endpointed(status: TimingStatus = 'ok') {
      current?.endpoint?.end(status)
      if (current) current.endpoint = undefined
    },
    assembling() {
      const state = ensure()
      state.assembly ??= timingSpan('voice.assembly', state.id)
    },
    mark(name: 'voice.interruption') { timingMark(name, ensure().id) },
    dispatch: () => finish(),
    cancel: (status: TimingStatus = 'cancelled') => { finish(status) },
  }
}
