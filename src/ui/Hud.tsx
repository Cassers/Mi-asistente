import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, accentFor, type Phase } from '../store'
import { ResponseText } from './ResponseText'
import { ListeningControl } from './ListeningControl'
import { MicrophoneControl } from './MicrophoneControl'
import { MessageComposer } from './MessageComposer'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { HistoryControl, ScreenControl } from './CaptureControls'
import { useProfile, displayName, wakeWord } from '../lib/profile'
import { useVoiceInputMode } from '../lib/voice-input-mode'

const statusText: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: 'EN ESPERA',
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'RESPONDING',
}

function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <div className={`corner corner-${at}`} />
}

/* --------------------------------------------------------------------- hud */

type HudProps = {
  onPause: () => void
  onResume: () => void
  onToggleMicrophone: () => void
  onToggleStandby?: () => void
  onSubmitTranscript?: () => void
  onSendMessage?: (text: string) => boolean | Promise<boolean>
  onReplay?: (text: string) => void
  chatId?: string
  composerScope?: number
}

export function Hud({ onPause, onResume, onToggleMicrophone, onToggleStandby, onSubmitTranscript, onSendMessage, onReplay, chatId, composerScope }: HudProps) {
  const profile = useProfile()
  const inputMode = useVoiceInputMode()
  const log = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const previous = useRef<{ chatId?: string; ids: string[] }>({ chatId, ids: [] })
  const [chatMinimized, setChatMinimized] = useState(false)
  const savedScroll = useRef(0)
  const wasMinimized = useRef(false)
  const [showLatest, setShowLatest] = useState(false)
  const phase = useStore((s) => s.phase)
  const conversationPaused = useStore((s) => s.conversationPaused)
  const microphoneMuted = useStore((s) => s.microphoneMuted)
  const microphoneActive = useStore((s) => s.microphoneActive)
  const microphoneStandby = useStore((s) => s.microphoneStandby)
  const microphoneBusy = useStore((s) => s.microphoneBusy)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const screenCapture = useStore((s) => s.screenCapture)
  const recording = useStore((s) => s.recording)
  const autoScreen = useStore((s) => s.autoScreen)
  const ui = useStore((s) => s.ui)
  const transcriptPending = inputMode === 'transcript' && phase === 'listening' && microphoneActive && !microphoneMuted && !microphoneStandby && !conversationPaused && !!caption.trim() && !!onSubmitTranscript

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)
  const answerBusy = ['thinking', 'tooling', 'speaking'].includes(phase)
  const phaseStatus = phase === 'boot' && bootNote ? bootNote
    : !microphoneActive && !answerBusy && phase !== 'boot' ? 'SOLO TEXTO' : statusText[phase]
  const inputStatus = microphoneMuted ? 'MICRÓFONO APAGADO'
    : microphoneActive && (microphoneStandby || conversationPaused) && phase !== 'boot' ? 'SOLO ACTIVACIÓN' : ''

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  useLayoutEffect(() => {
    const ids = turns.map(turn => turn.id)
    // Shared IDs distinguish streamed/appended turns (or history trimming) from
    // a replacement session. chatId also covers conversations sharing a prefix.
    const old = previous.current
    const oldIds = new Set(old.ids)
    const replaced = old.chatId !== chatId || (old.ids.length > 0 &&
      (ids.length === 0 || !ids.some(id => oldIds.has(id))))
    previous.current = { chatId, ids }
    if (replaced) { follow.current = true; setShowLatest(false) }
    if (!chatMinimized && log.current) {
      if (follow.current) log.current.scrollTop = log.current.scrollHeight
      else if (wasMinimized.current) log.current.scrollTop = savedScroll.current
    }
    wasMinimized.current = chatMinimized
  }, [turns, chatId, ui.chrome.transcript, chatMinimized])

  useEffect(() => {
    const viewport = log.current
    const body = content.current
    if (chatMinimized || !viewport || !body || typeof ResizeObserver === 'undefined') return
    // Wrapping, fonts and a resized window can change height without a new turn.
    const observer = new ResizeObserver(() => {
      if (follow.current) viewport.scrollTop = viewport.scrollHeight
    })
    observer.observe(viewport)
    observer.observe(body)
    return () => observer.disconnect()
  }, [ui.chrome.transcript, chatMinimized])

  return (
    <div className="hud" data-microphone-muted={microphoneMuted} data-microphone-standby={microphoneStandby} data-transcript-pending={transcriptPending} style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

      <button type="button" className="surface-button chat-visibility-toggle" aria-controls="assistant-chat"
        aria-expanded={!chatMinimized} onClick={(event) => {
          if (!chatMinimized && log.current) savedScroll.current = log.current.scrollTop
          setChatMinimized(!chatMinimized)
          event.currentTarget.focus()
        }}>{chatMinimized ? 'Mostrar chat' : 'Minimizar chat'}</button>
      <section className="conversation-pane" data-minimized={chatMinimized} aria-label="Conversación con el asistente">
        <div className="conversation-content" id="assistant-chat" hidden={chatMinimized}>
          <header className="hud-top">
            {ui.chrome.brand && (
              <div className="brand">
                <span className="brand-mark">{displayName(profile)}</span>
                <span className="brand-sub">{profile.configured ? 'Asistente personal' : 'Configuración inicial por conversación'}</span>
              </div>
            )}

            <div className="status">
              <span className="dot" />
              <span className="status-text">
                {/* bootNote is the voice-model download readout. It is only ever
                    the right thing to show during boot — as a general fallback a
                    note that never got cleared (a stuck 'voice 97%') sits over
                    LISTENING and PROCESSING for the rest of the session. */}
                {inputStatus ? `${inputStatus} · ${phaseStatus}` : phaseStatus}
              </span>
            </div>
          </header>

          <AnimatePresence>
            {activeTool && ui.chrome.toolBadge && (
              <motion.div
                className="tool-badge"
                initial={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
                transition={{ type: 'spring', stiffness: 300, damping: 26 }}
              >
                <span className="tool-kicker">
                  <span className="spinner" />
                  accessing
                </span>
                <span className="tool-name">{activeTool.replace(/[_-]/g, ' ')}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="chat-history">
            {ui.chrome.transcript && <div className="log" ref={log} tabIndex={0} role="region" aria-label="Mensajes de la conversación"
              onScroll={() => {
                const el = log.current
                if (!el || chatMinimized) return
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 56
                setShowLatest(!follow.current)
              }}>
              <div className="log-content" ref={content}>
                {turns.length === 0 && <p className="chat-empty">Tu conversación aparecerá aquí.</p>}
                {turns.map((t) => (
                  <article key={t.id} className={`log-line log-${t.role}`}>
                    <span className="log-who">{t.role === 'user' ? 'TÚ' : displayName(profile)}</span>
                    <div className="log-text">
                      <ResponseText text={t.text} />
                      {t.role === 'jarvis' && t.text.trim() && onReplay && <button type="button" className="replay-message"
                        aria-label="Volver a leer" disabled={answerBusy}
                        onClick={() => onReplay(t.text)}>Volver a leer</button>}
                    </div>
                  </article>
                ))}
              </div>
            </div>}
            {ui.chrome.transcript && showLatest && <button type="button" className="surface-button jump-latest" onClick={() => {
              follow.current = true
              setShowLatest(false)
              if (log.current) log.current.scrollTop = log.current.scrollHeight
            }}>Ir al último mensaje ↓</button>}
            {ui.chrome.suggestions && microphoneActive && !microphoneMuted && !microphoneStandby && <Suggestions />}
          </div>

          {onSendMessage && <MessageComposer key={composerScope} onSendMessage={onSendMessage} />}
        </div>

        <div className="conversation-dock">
          <AnimatePresence>
            {caption && (
              <motion.div
                className="caption"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {caption}
              </motion.div>
            )}
          </AnimatePresence>

          {error && <div className="error" role="alert">{error}</div>}

          <footer className="hud-bottom">
            {transcriptPending && <div className="transcript-submit">
              <button type="button" className="surface-button" onClick={onSubmitTranscript}>
                Enviar texto <kbd>Enter</kbd>
              </button>
            </div>}
            <MicrophoneControl muted={microphoneMuted} busy={microphoneBusy || phase === 'boot'}
              inactive={!microphoneActive || phase === 'boot'}
              standby={microphoneStandby} name={wakeWord(profile)} onStandby={onToggleStandby}
              historyActive={recording?.active !== false} historyMicrophone={recording?.audio?.includes('mic') !== false} onToggle={onToggleMicrophone} />
            <ListeningControl paused={conversationPaused} muted={microphoneMuted || !microphoneActive} standby={microphoneStandby}
              disabled={phase === 'offline' || phase === 'boot' || microphoneMuted && conversationPaused}
              name={wakeWord(profile)} onPause={onPause} onResume={onResume} />
            {recording && <HistoryControl recording={recording} muted={microphoneMuted} />}
            <ScreenControl enabled={autoScreen} available={recording?.controlVersion === 1} onChange={(enabled) => useStore.getState().setAutoScreen(enabled)} />
            {screenCapture !== 'off' && <span className="capture-status" role="status">{screenCapture === 'capturing'
              ? 'Capturando monitor…' : screenCapture === 'attached' ? 'Captura adjunta' : 'Sin captura del monitor'}</span>}
          </footer>
        </div>
      </section>

      <Blades />

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live">
          {looking ? `LOOKING — ${looking.toUpperCase()}` : 'CAMERA ON · G TO STOP'}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}
