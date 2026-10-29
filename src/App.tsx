import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { PermissionPrompt } from './ui/PermissionPrompt'
import { ConversationsPanel } from './ui/ConversationsPanel'
import { useStore } from './store'
import { type VoiceMode } from './lib/voice'
import { createMicrophone } from './lib/microphone'
import { currentVoiceInputMode, subscribeVoiceInputMode } from './lib/voice-input-mode'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchRecording,
  setRecordingActive,
  watchPermissions,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { setMicBlocked, micLevel } from './lib/audio'
import { markUtteranceAudio, armUtteranceAudio, takeUtteranceAudio, captureDiagnostics, resetUtteranceAudio, type VoiceClip } from './lib/utterance-audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'
import { currentProfile, useProfile, refreshProfile, watchProfile, displayName, wakePattern } from './lib/profile'
import { listeningMode } from './lib/listening-policy'
import { selectedProject, projectMode, useProjects, subscribeProjects } from './lib/projects'
import { conversationSnapshot, conversationRevision, subscribeConversation, permissionModeSnapshot, subscribePermissionMode } from './lib/bridge'
import { bindWhisperScope } from './lib/whisper'
import { timingSpan, timingTrace, timingMark, timingCapture, type TimingSpan } from './lib/voice-timing'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */

export default function App() {
  const projects = useProjects()
  const conversation = useSyncExternalStore(subscribeConversation, conversationSnapshot)
  const profile = useProfile()
  useEffect(() => watchProfile(), [])
  useEffect(() => { document.title = displayName(profile) }, [profile])
  const store = useStore
  const phase = useStore((s) => s.phase)
  const microphoneMuted = useStore((s) => s.microphoneMuted)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<ReturnType<typeof createMicrophone> | null>(null)
  useEffect(() => bindWhisperScope(() => ({
    destination: [selectedProject()?.id || '', selectedProject()?.application || '', conversationRevision(), currentVoiceInputMode()].join(':'),
    chat: conversationSnapshot().chat?.id, connected: permissionModeSnapshot().connected,
  }), [subscribeProjects, subscribeConversation, subscribeVoiceInputMode, subscribePermissionMode], () => voice.current?.reset?.()), [])

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const activeTurnTiming = useRef<TimingSpan | null>(null)
  const followup = useRef(false)
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastProject = useRef<string | null>(null)
  useEffect(() => {
    const id = `${projects.selected?.id || ''}:${conversation.chat?.id || ''}`
    if (lastProject.current === id) return
    if (lastProject.current !== null) {
      followup.current = false
      turn.current++
      speaker.current?.cancel(); speaker.current = null
      activeTurnTiming.current?.end('cancelled')
      activeTurnTiming.current = null
      voice.current?.reset?.()
      history.current = []
      if (idleTimer.current) clearTimeout(idleTimer.current)
      if (!['offline','boot'].includes(store.getState().phase)) store.getState().setPhase('dormant')
    }
    lastProject.current = id
    void refreshProfile().catch(() => {})
  }, [projects.selected?.id, conversation.chat?.id, store])

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
    activeTurnTiming.current?.end('cancelled')
    activeTurnTiming.current = null
  }

  const goDormant = () => {
    followup.current = false
    resetUtteranceAudio()
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
    s.setScreenCapture('off')
  }

  /** Stop this turn, but keep wake-name recognition available. */
  const pauseConversation = () => {
    const s = store.getState()
    if (s.phase === 'offline' || s.phase === 'boot') {
      if (s.phase === 'offline' && selectedProject()) interrupt()
      return
    }
    s.setConversationPaused(true)
    voice.current?.reset?.()
    interrupt()
    goDormant()
  }

  const pauseHistoryForPrivacy = () => {
    void setRecordingActive(false).catch(() => store.getState().setError(
      'No se pudo confirmar la pausa del historial. Comprueba la conexión.',
    ))
  }

  const toggleMicrophone = async () => {
    const s = store.getState()
    if (s.microphoneBusy || s.phase === 'boot') return
    if (s.microphoneActive && !s.microphoneMuted) {
      s.setMicrophoneStandby(false)
      s.setMicrophoneMuted(true)
      s.setMicrophoneActive(false)
      followup.current = false
      voice.current?.stop()
      setMicBlocked(true)
      // Input and output are independent: let the current answer finish.
      clearIdle()
      s.setCaption('')
      s.setLevel(0)
      pauseHistoryForPrivacy()
      return
    }
    s.setMicrophoneBusy(true)
    s.setError(null)
    s.setMicrophoneMuted(false)
    try {
      if (s.phase === 'offline') { await powerOn(); return }
      if (await startCapture()) {
        const current = store.getState()
        current.setMicrophoneStandby(false)
        current.setConversationPaused(false)
        if (current.phase !== 'thinking' && current.phase !== 'tooling' && current.phase !== 'speaking') {
          listen(AWAIT_SPEECH_MS)
        }
      } else {
        s.setMicrophoneMuted(true)
      }
    } finally { s.setMicrophoneBusy(false) }
  }

  const toggleStandby = () => {
    const state = store.getState()
    if (!state.microphoneActive || state.microphoneMuted || state.microphoneBusy || state.phase === 'offline' || state.phase === 'boot') return
    const standby = !state.microphoneStandby
    state.setMicrophoneStandby(standby)
    followup.current = false
    clearIdle()
    voice.current?.reset?.()
    state.setCaption('')
    if (standby) pauseHistoryForPrivacy()
    else {
      state.setConversationPaused(false)
      if (!['thinking', 'tooling', 'speaking'].includes(state.phase)) listen(AWAIT_SPEECH_MS)
    }
  }

  /** `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    // Direct VAD owns the segment boundary, including audio before a fast wake
    // partial. Re-arming here could cut those first phonemes off.
    if (currentVoiceInputMode() !== 'direct' && currentVoiceInputMode() !== 'whisper') armUtteranceAudio()
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string, clip?: VoiceClip, traceId: string | undefined = timingTrace(), inputKind: 'voice' | 'text' = 'voice', acknowledge?: (accepted: boolean) => void): Promise<void> => {
    if (inputKind === 'voice' && !clip) {
      const captured = takeUtteranceAudio()
      if (currentVoiceInputMode() !== 'transcript' && currentVoiceInputMode() !== 'whisper') clip = captured
    }
    const directAudio = !!clip && currentVoiceInputMode() === 'direct'
    if (inputKind === 'voice') {
      const captured = captureDiagnostics()
      if (captured.durationMs > 0) timingCapture(captured.durationMs, !!clip, traceId)
    }
    if (projectMode() && !selectedProject()) {
      store.getState().setError('Abre un proyecto para conversar con el asistente.')
      return
    }
    activeTurnTiming.current?.end('cancelled')
    const turnTotal = timingSpan('turn.total', traceId)
    const turnFirstAudio = timingSpan('turn.first_audio', traceId)
    const totalTiming: TimingSpan = { end(status = 'ok') {
      turnFirstAudio.end(status === 'ok' ? 'cancelled' : status)
      turnTotal.end(status)
    } }
    activeTurnTiming.current = totalTiming
    followup.current = false
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.setError(null)
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    if (!selectedProject()) s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')
    s.setScreenCapture('off')
    if (inputKind === 'text' || currentVoiceInputMode() === 'transcript' || currentVoiceInputMode() === 'whisper') s.setCaption('Enviando mensaje…')

    const spk = createSpeaker(traceId, () => turnFirstAudio.end())
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text, status: responseStatus } = await ask(said, history.current, {
        onSubmitted: () => {
          if (!stale()) acknowledge?.(true)
          if (!stale() && !started) store.getState().setCaption('Mensaje recibido. Esperando respuesta…')
        },
        onAudio: (state, message) => {
          if (!stale()) store.getState().setCaption(message || (directAudio
            ? String(state) === 'attached' ? 'Audio adjunto al modelo.' : 'Preparando audio para el modelo.'
            : state === 'interpreted' ? 'MP3 interpretado por el modelo.' : 'Se usó la transcripción del dictado.'))
        },
        onScreen: (state) => {
          if (stale()) return
          store.getState().setScreenCapture(state)
          if (state === 'failed') {
            store.getState().setError('No pude capturar el monitor; esta pregunta se envió sin imagen.')
          }
        },
        onText: (delta) => {
          if (stale()) return
          if (delta) acknowledge?.(true)
          if (!started) {
            started = true
            store.getState().setCaption('')
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            if (!selectedProject()) store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          if (!selectedProject()) store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, clip, traceId, inputKind === 'text' ? { audioMode: 'transcript' } : undefined)

      if (stale()) return

      await refreshProfile().catch(() => {})
      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      totalTiming.end(responseStatus === 'cancelled' ? 'cancelled' : spk.timingStatus?.() ?? 'ok')
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      // Observe the existing queue only; errors must not flush buffered prose.
      void spk.finishTiming('error').then(() => totalTiming.end('error'))
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      acknowledge?.(false)
      if (stale()) {
        spk.cancel()
        totalTiming.end('cancelled')
      }
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        const state = store.getState()
        if (state.microphoneActive === false || state.microphoneMuted || state.microphoneStandby || state.conversationPaused) {
          followup.current = false
          state.setPhase('dormant')
        } else {
          followup.current = true
          listen(FOLLOW_UP_MS)
        }
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    const s = store.getState()
    return listeningMode(s.phase, currentProfile().configured, s.conversationPaused, s.microphoneMuted, s.microphoneStandby)
  }

  const onWake = (trailing: string, traceId?: string) => {
    if (store.getState().microphoneMuted) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    followup.current = false
    if (store.getState().microphoneStandby) {
      const state = store.getState()
      state.setMicrophoneStandby(false)
      state.setConversationPaused(false)
      state.setError(null)
      // Name-only activation changes input, never cancels/replaces playback.
      if (!trailing) {
        // Direct VAD keeps the whole current clip even when wake recognition lags.
        if (currentVoiceInputMode() !== 'direct' && currentVoiceInputMode() !== 'whisper') voice.current?.reset?.()
        if (!['thinking', 'tooling', 'speaking'].includes(phase)) listen(AWAIT_SPEECH_MS)
        return
      }
      if (['thinking', 'tooling', 'speaking'].includes(phase)) onSpeechStart()
    }
    if (currentVoiceInputMode() === 'direct') {
      store.getState().setConversationPaused(false)
      store.getState().setError(null)
      sfx.play('wake')
      // The VAD owns the current/held audio. Wake text is never a question.
      listen(AWAIT_SPEECH_MS)
      return
    }
    if (trailing) markUtteranceAudio()
    const capturedWakeClip = trailing ? takeUtteranceAudio() : undefined
    const wakeClip = currentVoiceInputMode() === 'transcript' || currentVoiceInputMode() === 'whisper' ? undefined : capturedWakeClip
    store.getState().setConversationPaused(false)
    // Local VAD may already have queued the rest of this spoken question.
    if (currentVoiceInputMode() !== 'whisper') voice.current?.reset?.()
    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing, wakeClip, traceId)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    if (store.getState().microphoneMuted || store.getState().conversationPaused || store.getState().microphoneStandby) return
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant' && currentProfile().configured) return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt('speech')
      store.getState().setActiveTool(null)
      store.getState().setScreenCapture('off')
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onClip = (clip: VoiceClip, traceId?: string) => {
    const state = store.getState()
    if (currentVoiceInputMode() !== 'direct' || state.microphoneMuted || state.conversationPaused || state.microphoneStandby) return
    if (state.phase === 'offline' || state.phase === 'boot' || state.phase === 'dormant' && currentProfile().configured) return
    if (followup.current) timingMark('voice.followup', traceId)
    void respond('Escucha el audio adjunto y responde a lo que digo.', clip, traceId)
  }

  const onUtterance = (text: string, traceId?: string) => {
    if (currentVoiceInputMode() === 'direct') return
    if (store.getState().microphoneMuted || store.getState().conversationPaused || store.getState().microphoneStandby) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant' && currentProfile().configured) return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (wakePattern(currentProfile(), 'bare').test(text)) {
      takeUtteranceAudio()
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(wakePattern(currentProfile(), 'leading'), '').trim()
    if (!said) {
      takeUtteranceAudio()
      listen(AWAIT_SPEECH_MS)
      return
    }

    if (followup.current) timingMark('voice.followup', traceId)
    void respond(said, undefined, traceId)
  }

  const onPartial = (text: string) => {
    if (store.getState().microphoneMuted || store.getState().conversationPaused || store.getState().microphoneStandby) return
    store.getState().setCaption(text)
  }

  const sendTranscript = (): boolean => {
    const state = store.getState()
    if (!['transcript', 'whisper'].includes(currentVoiceInputMode()) || state.microphoneMuted || state.conversationPaused || state.microphoneStandby || state.phase !== 'listening') return false
    // Commit only the recognizer's pending words, never a status/caption string.
    return voice.current?.commit?.() ?? false
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  const startCapture = async (): Promise<boolean> => {
    voice.current ??= createMicrophone({
      mode, requireGreeting: () => store.getState().microphoneStandby,
      onWake, onSpeechStart, onPartial, onUtterance, onClip, onError: onVoiceError,
    })
    const active = await voice.current.start()
    store.getState().setMicrophoneActive(active)
    return active
  }

  const sendTextMessage = async (message: string): Promise<boolean> => {
    const text = message.trim()
    const state = store.getState()
    if (!text || state.phase === 'boot') return false
    if (projectMode() && !selectedProject()) {
      state.setError('Abre un proyecto en Configuración para enviar mensajes.')
      return false
    }
    // Unlock output inside the input gesture; connecting may take seconds.
    void sfx.unlockAudio()
    const revision = conversationRevision()
    const destination = selectedProject()?.id
    const chat = conversationSnapshot().chat?.id
    try { await warm() }
    catch (error) { state.setError(error instanceof Error ? error.message : 'No se pudo conectar.'); return false }
    if (revision !== conversationRevision() || destination !== selectedProject()?.id || (chat && chat !== conversationSnapshot().chat?.id)) {
      state.setError('La conversación cambió antes de enviar. Tu mensaje sigue en el cuadro de texto.')
      return false
    }
    if (projectMode() && !conversationSnapshot().chat) {
      state.setError('La conversación todavía se está abriendo. Espera a que cargue y vuelve a enviar; tu texto se conserva.')
      return false
    }
    // Only unlock output. Typing must never open capture or change mute/standby.
    if (['thinking', 'tooling', 'speaking'].includes(store.getState().phase)) interrupt('speech')
    silence()
    return new Promise<boolean>(accepted => {
      void respond(text, undefined, timingTrace(), 'text', accepted).then(() => accepted(false), (error: unknown) => {
        store.getState().setError(error instanceof Error ? error.message : 'No se pudo enviar el mensaje.')
        accepted(false)
      })
    })
  }

  const replayResponse = (text: string) => {
    const state = store.getState()
    if (!text.trim() || ['boot', 'thinking', 'tooling', 'speaking'].includes(state.phase)) return
    void sfx.unlockAudio()
    clearIdle()
    silence()
    const playback = createSpeaker()
    speaker.current = playback
    state.setPhase('speaking')
    playback.say(text)
    void playback.end().catch((error: unknown) => state.setError(error instanceof Error ? error.message : 'No se pudo leer esta respuesta.')).finally(() => {
      if (speaker.current !== playback) return
      speaker.current = null
      const current = store.getState()
      if (current.microphoneActive && !current.microphoneMuted && !current.microphoneStandby && !current.conversationPaused) listen(FOLLOW_UP_MS)
      else current.setPhase('dormant')
    })
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      voice.current?.stop()
      store.getState().setMicrophoneActive(false)
      setMicBlocked(true)
      store.getState().setMicrophoneMuted(true)
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  // Data/tools are available to text chat before any microphone activation.
  const configureClient = () => {
    watchServers((servers) => store.getState().setConnected(servers))
    watchRecording((recording) => {
      store.getState().setRecording(recording)
      if (store.getState().microphoneMuted && recording.active && recording.audio?.includes('mic') !== false) pauseHistoryForPrivacy()
    })
    watchPermissions((permissions) => store.getState().setPermissions(permissions))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // OpenCode restores its saved chat on ready; legacy backends remain ephemeral.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Conexión restablecida; comprobando la conversación.')
      }
    })
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    // Keep tool audio available without playing the opening sound or music.
    music.enable()

    // This phase only guards real initialization; there is no intro overlay.
    s.setPhase('boot')
    await refreshProfile()

    configureClient()
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Preload the neural voice so the first "Hey Jarvis" isn't waiting on an
    // 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One capture owner, explicitly stopped and recreated by the microphone button.
    if (!store.getState().microphoneMuted && !await startCapture()) {
      store.getState().setMicrophoneMuted(true)
    }

    store.getState().setPhase('dormant')
    if (!currentProfile().configured && !store.getState().microphoneMuted) {
      const welcome = 'Antes de empezar, ¿cómo quieres llamarme y qué estilo de respuesta prefieres?'
      store.getState().pushTurn({ id: newId(), role: 'jarvis', text: welcome })
      const setup = createSpeaker()
      speaker.current = setup
      setup.say(welcome)
      void setup.end()
      listen(60000)
    }
  }

  useEffect(() => {
    if (!usingBridge || !projects.available) return
    configureClient()
    // Opening a project establishes its native chat without opening capture.
    void warm().catch((error: Error) => store.getState().setError(error.message))
    void probeCapabilities().catch(() => {})
    // Handlers read current stores/refs; registering again replaces subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.available])

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (projectMode()) return // capture starts only after an explicit user activation
    if (microphoneMuted) { setMicBlocked(true); return }
    if (phase !== 'offline') return
    setMicBlocked(false)
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, microphoneMuted])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return

      if (e.key === 'Enter' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && sendTranscript()) {
        e.preventDefault()
        return
      }

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voz cambiada a ${name.replace(/\(.*?\)/g, '').trim()}.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Prueba de audio. La salida de voz está funcionando.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        pauseConversation()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      if (store.getState().microphoneMuted) return
      if (store.getState().microphoneActive === false) { void toggleMicrophone(); return }
      if (store.getState().microphoneStandby) { onWake(''); return }

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore until microphone and connection initialization finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      store.getState().setMicrophoneActive(false)
      setMicBlocked(true)
      speaker.current?.cancel()
      activeTurnTiming.current?.end('cancelled')
      activeTurnTiming.current = null
      // Fast Refresh tears down the microphone too. Return to the activation
      // button instead of leaving a listening HUD with a stopped recognizer.
      store.getState().setPhase('offline')
      store.getState().setConversationPaused(false)
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud chatId={conversation.chat?.id} composerScope={conversationRevision()} onPause={pauseConversation} onResume={() => onWake('')} onToggleStandby={toggleStandby} onSendMessage={sendTextMessage} onReplay={replayResponse} onSubmitTranscript={() => { sendTranscript() }} onToggleMicrophone={() => {
        if (store.getState().phase === 'offline' && !store.getState().microphoneMuted) void powerOn()
        else void toggleMicrophone()
      }} />
      <PermissionPrompt />
      <ConversationsPanel onStop={pauseConversation} />
      <Diagnostics />
      <Ignition client={projects.available} onStart={() => {
        if (projectMode() && store.getState().microphoneMuted) void toggleMicrophone()
        else void powerOn()
      }} />
    </>
  )
}
