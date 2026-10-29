import { BRIDGE_HTTP_URL, SPEECH_LANG } from '../config'
import { getMic } from './audio'
import { speakingNow, speakingSince } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'
import { currentProfile, wakePattern } from './profile'
import { createVoiceTiming } from './voice-timing'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Explicit voice standby requires a greeting, not a mention of the name. */
  requireGreeting?: () => boolean
  /** Raw speech onset, before transcription latency or turn assembly. */
  onAudioStart?: (continuation?: boolean) => void
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string, traceId?: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string, traceId?: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** Submit only actual pending recognition/assembly text, never a caption/status. */
  commit?: () => boolean
  /** Discard pre-pause audio/transcripts without turning off wake listening. */
  reset?: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
const WAKE = {
  test: (text: string) => wakePattern(currentProfile()).test(text),
  exec: (text: string) => wakePattern(currentProfile()).exec(text),
}

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string, pattern = WAKE): string {
  const m = pattern.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither|y|o|pero|porque|que|cuando|mientras|de|del|en|con|por|para|el|la|los|las|un|una|unos|unas|mi|mis|tu|tus|su|sus)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
const SELF_GUARD_MS = 350

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
const COMPLETE_SHORT = /^(?:[¿¡]\s*)?(?:hola(?:[, ]+¿?c[oó]mo (?:vas|est[aá]s))?|hello|hi|hey|buenos d[ií]as|buenas tardes|buenas noches|gracias|muchas gracias|thanks|thank you|vale|listo|de acuerdo|entendido|perfecto|ok(?:ay)?|s[ií]|no)[.!?]*$/i

function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (COMPLETE_SHORT.test(text.trim())) return SETTLE_MS
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
  /** New speech belongs to the held thought; don't dispatch during its next clause. */
  resume: () => void
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim() && !held) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
    resume: clear,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no|espera|detente|alto|cancela|basta|silencio|calla|c[aá]llate|olv[ií]dalo|yarvis)\b/i

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (VAD+Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers, options: {
  browserOnly?: boolean
  localTranscribe?: (blob: Blob, signal: AbortSignal) => Promise<string>
} = {}): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false }
  }
  if (options.localTranscribe) {
    diag.engine = 'whisper'
    return startElevenVoice(h, options.localTranscribe)
  }
  const premium = !options.browserOnly && caps().stt
  diag.engine = premium ? 'elevenlabs' : 'browser'
  return premium ? startElevenVoice(h) : startBrowserVoice(h)
}

/** Shared VAD/ordered assembly; an explicit local engine never falls back. */
async function startElevenVoice(h: VoiceHandlers, localTranscribe?: (blob: Blob, signal: AbortSignal) => Promise<string>): Promise<Voice> {
  const WAKE = {
    test: (text: string) => wakePattern(currentProfile(), h.requireGreeting?.() ? 'greeting' : 'any').test(text),
    exec: (text: string) => wakePattern(currentProfile(), h.requireGreeting?.() ? 'greeting' : 'any').exec(text),
  }
  const timing = createVoiceTiming()
  let generation = 0
  let segmentGeneration = 0
  let lastWake = 0
  let vad: Vad | null = null

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: Blob[] = []
  let draining = false
  let transcription: AbortController | undefined

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text, timing.dispatch())
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async (blob: Blob) => {
    const mine = generation
    const mode = h.mode()
    if (mode === 'deaf') return
    const recognized = timing.recognizing()
    const t0 = performance.now()
    try {
      let text: string | undefined
      if (localTranscribe) {
        const controller = new AbortController()
        transcription = controller
        text = await localTranscribe(blob, controller.signal)
      } else {
        const res = await fetch(BRIDGE_HTTP_URL + '/stt', {
          method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
        })
        if (mine !== generation) return
        if (!res.ok) {
          diag.restarts++; recognized('error'); timing.cancel('error')
          diag.lastError = 'stt ' + res.status
          drop('transcription failed (' + res.status + ')')
          return
        }
        ;({ text } = await res.json() as { text?: string })
      }
      if (mine !== generation) return
      diag.idleMs = Math.round(performance.now() - t0)
      recognized()
      const said = (text ?? '').trim()
      diag.lastError = ''

      if (!said) {
        timing.cancel()
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        timing.cancel()
        drop('echo of his own voice')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        if (WAKE.test(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          timing.onset()
          h.onWake(afterWake(said, WAKE), timing.dispatch())
        } else {
          timing.cancel()
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      timing.assembling()
      assemble.feed(said, (vad?.meter().speaking ?? false) || pendingAudio.length > 0)
    } catch (err) {
      if (mine !== generation) return
      recognized('error')
      timing.cancel('error')
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service')
      if (localTranscribe) h.onError('Whisper local: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    const owner = generation
    try {
      while (pendingAudio.length && (!localTranscribe || owner === generation)) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      if (!localTranscribe || owner === generation) {
        draining = false
        // A failed continuation must not strand a valid earlier clause.
        if (!pendingAudio.length && !vad?.meter().speaking && ['command', 'guard'].includes(h.mode()) && assemble.held()) {
          assemble.feed('', false)
        }
      }
    }
  }

  vad = await startVad({
    onStart: () => {
      segmentGeneration = generation
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf') return
      h.onAudioStart?.(draining || pendingAudio.length > 0)
      if (mode === 'command' || mode === 'guard') assemble.resume()
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') {
        assemble.cancel()
        // Another capture can start while Scribe still owns the previous one.
        // Keep that owner until dispatch; a later queued turn starts at the
        // observed request boundary rather than borrowing its neighbor's onset.
        if (!draining && !pendingAudio.length) timing.cancel()
      }
      timing.onset()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        timing.mark('voice.interruption')
        h.onSpeechStart()
      }
    },
    onEnd: (blob) => {
      if (segmentGeneration !== generation) return
      // VAD exposes only the completed blob, not the beginning of its quiet
      // window. Endpoint duration is unavailable here; do not fabricate one.
      pendingAudio.push(blob)
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      timing.cancel('error')
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) { assemble.cancel(); timing.cancel() }
    if (mode === 'deaf') timing.cancel()
  }, 200)

  return {
    commit: () => {
      if (!localTranscribe || draining || !assemble.held() || !['command', 'guard'].includes(h.mode())) return false
      assemble.flush()
      return true
    },
    reset: () => {
      timing.cancel()
      generation++
      if (localTranscribe) { transcription?.abort(); draining = false; vad?.reset?.() }
      pendingAudio.length = 0
      assemble.cancel()
      diag.holding = ''
    },
    stop: () => {
      timing.cancel()
      generation++
      transcription?.abort()
      pendingAudio.length = 0
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(h: VoiceHandlers): Voice {
  const WAKE = {
    test: (text: string) => wakePattern(currentProfile(), h.requireGreeting?.() ? 'greeting' : 'any').test(text),
    exec: (text: string) => wakePattern(currentProfile(), h.requireGreeting?.() ? 'greeting' : 'any').exec(text),
  }
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false }
  }

  const timing = createVoiceTiming()
  let recognitionDone: (() => void) | undefined
  let stopped = false
  let running = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let speechActive = false
  let stableFinal = false
  let lastResult = ''
  let lastResultText = ''
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      publish(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
    speechActive = false
    stableFinal = false
    lastResult = ''
    lastResultText = ''
  }

  const emit = () => {
    // Results can arrive in bursts with gaps while the person is still speaking.
    // A transcription gap alone must not consume the beginning of their clip.
    if (stopped) return
    const completeShort = COMPLETE_SHORT.test(`${assemble.held()} ${settled} ${interim}`.trim())
    if (completeShort && interim.trim() && (h.mode() === 'command' || h.mode() === 'guard')) {
      // Keep provisional words in recognition until this last settling window.
      // A changed phrase cancels it; duplicate partials cannot postpone it.
      silenceTimer = setTimeout(() => { commit() }, SETTLE_MS)
      return
    }
    if (speechActive && !stableFinal && !completeShort) { bumpSilence(); return }
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    recognitionDone?.(); recognitionDone = undefined
    timing.endpointed()
    if (!text || mode === 'deaf') {
      if (!text && mode === 'command' && assemble.held()) assemble.feed('', false)
      else timing.cancel()
      return
    }
    if (isEcho(text, speakingNow())) {
      timing.cancel()
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        timing.onset()
        h.onWake(afterWake(text, WAKE), timing.dispatch())
      } else {
        timing.cancel()
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    timing.assembling()
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any, finals: Map<number, string>) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      timing.cancel()
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) {
        if (finals.get(i) !== chunk) { fresh = `${fresh} ${chunk}`.trim(); finals.set(i, chunk) }
      } else interim = `${interim} ${chunk}`.trim()
    }
    if (!fresh.trim() && !interim.trim()) return
    if (mode === 'wake' && h.requireGreeting?.()) {
      const incoming = `${fresh} ${interim}`.trim()
      if (/^hola\b/iu.test(incoming) || !/^hola\b/iu.test(settled.trim())) settled = ''
    }
    const heard = `${settled} ${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    const resultKey = `${fresh.trim() ? 'final' : 'interim'}:${heard}`
    if (resultKey === lastResult) return
    const sameText = heard === lastResultText
    lastResult = resultKey
    lastResultText = heard
    recognitionDone?.(); recognitionDone = undefined
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      if (!settled.trim() && !assemble.held()) timing.cancel()
      interim = ''
      return
    }

    stableFinal = !!fresh.trim() && !interim.trim()
    if (stableFinal || COMPLETE_SHORT.test(`${assemble.held()} ${heard}`.trim())) timing.endpoint()
    else timing.endpointed('cancelled')

    if (mode === 'wake') {
      settled = `${settled} ${fresh}`.replace(/\s+/g, ' ').trim()
      if (WAKE.test(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        // A wake-name partial may already contain the start of a long question.
        // Wait for its endpoint rather than dispatching that unfinished prefix.
        if (afterWake(heard, WAKE)) { bumpSilence(); return }
        lastWake = Date.now()
        diag.wakes++
        const trailing = afterWake(heard, WAKE)
        reset()
        timing.onset()
        h.onWake(trailing, timing.dispatch())
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    timing.onset()
    assemble.resume()
    settled = `${settled} ${fresh}`.replace(/\s+/g, ' ').trim()
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        if (!OVERRIDE.test(full)) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything.
          if (words < 2) return
        }
      }
      started = true
      if (mode === 'guard') { barged = true; timing.mark('voice.interruption') }
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    if (!sameText || !silenceTimer) bumpSilence()
  }

  const spin = () => {
    if (stopped || running) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = currentProfile().language || SPEECH_LANG
    const instance = rec
    const finals = new Map<number, string>()
    rec.onspeechstart = () => {
      if (rec !== instance || stopped || h.mode() === 'deaf') return
      speechActive = true
      stableFinal = false
      timing.endpointed('cancelled')
      touch()
      if (!assemble.held() && !settled.trim() && !interim.trim()) timing.cancel()
      timing.onset()
      recognitionDone = timing.recognizing()
      h.onAudioStart?.(h.mode() === 'wake' && WAKE.test(`${settled} ${interim}`))
      if (h.mode() === 'command' || h.mode() === 'guard') { assemble.resume(); clearSilence() }
    }
    rec.onspeechend = () => {
      if (rec !== instance || stopped) return
      speechActive = false
      if (h.mode() === 'wake' && !WAKE.test(`${settled} ${interim}`)) timing.cancel()
      else timing.endpoint()
      if (settled.trim() || interim.trim() || assemble.held()) bumpSilence()
    }
    rec.onstart = () => {
      if (stopped || rec !== instance) return
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = (event: any) => { if (!stopped && rec === instance) onResult(event, finals) }
    rec.onerror = (ev: any) => {
      if (stopped || rec !== instance) return // abort() during teardown is intentional, not a mic failure
      speechActive = false
      timing.cancel(ev.error === 'no-speech' || ev.error === 'aborted' ? 'cancelled' : 'error')
      recognitionDone = undefined
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'network') {
        h.onError(
          'El reconocimiento de voz falló (network). Si estás en el panel de Codex, ' +
          'abre http://localhost:5173 en Google Chrome e inicia JARVIS allí.',
        )
      }
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      if (stopped || rec !== instance) return
      speechActive = false
      if (settled.trim() || interim.trim() || assemble.held()) bumpSilence()
      if (!settled.trim() && !interim.trim() && !assemble.held()) timing.cancel()
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      setTimeout(spin, 250)
    }
  }

  // Sealing a committed recognition session makes its late final results inert.
  // The shared microphone/PCM owner stays up; only browser dictation is renewed.
  function rotateRecognizer() {
    const old = rec
    rec = null; running = false; diag.running = false
    if (old) {
      old.onresult = null; old.onend = null; old.onerror = null; old.onstart = null
      old.onspeechstart = null; old.onspeechend = null
      try { old.abort() } catch { /* already ended */ }
    }
    touch()
    if (!stopped) spin()
  }
  function publish(text: string) {
    recognitionDone?.(); recognitionDone = undefined
    const traceId = timing.dispatch()
    reset()
    diag.dropped = ''; diag.accepted++; diag.holding = ''
    rotateRecognizer()
    h.onUtterance(text, traceId)
  }
  const commit = (): boolean => {
    if (stopped) return false
    const mode = h.mode()
    if (mode !== 'command' && mode !== 'guard') return false
    const text = [assemble.held(), settled, interim].join(' ').replace(/\s+/g, ' ').trim()
    if (!text || isEcho(text, speakingNow())) return false
    if (mode === 'guard') { timing.mark('voice.interruption'); h.onSpeechStart() }
    timing.onset()
    timing.endpointed()
    timing.assembling()
    assemble.cancel()
    diag.heard = text; diag.heardAt = Date.now()
    publish(text)
    return true
  }

  spin()

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000 || speechActive && idle < 120000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    speechActive = false
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  return {
    commit,
    reset: () => {
      if (stopped) return
      lastWake = 0
      timing.cancel()
      recognitionDone = undefined
      reset()
      assemble.cancel()
      diag.holding = ''
      rotateRecognizer()
    },
    stop: () => {
      timing.cancel()
      recognitionDone = undefined
      stopped = true
      clearInterval(health)
      reset()
      assemble.cancel()
      rotateRecognizer()
    },
    live: () => running,
  }
}
