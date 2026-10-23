import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, accentFor, type Phase } from '../store'
import { ResponseText } from './ResponseText'
import { ListeningControl } from './ListeningControl'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { setRecordingActive } from '../lib/brain'
import { useProfile, displayName, wakeWord } from '../lib/profile'

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

export function Hud({ onPause, onResume }: { onPause: () => void; onResume: () => void }) {
  const profile = useProfile()
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const phase = useStore((s) => s.phase)
  const conversationPaused = useStore((s) => s.conversationPaused)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const connected = useStore((s) => s.connected)
  const error = useStore((s) => s.error)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const screenCapture = useStore((s) => s.screenCapture)
  const recording = useStore((s) => s.recording)
  const ui = useStore((s) => s.ui)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [turns])

  return (
    <div className="hud" style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

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
            {conversationPaused && phase !== 'offline' && phase !== 'boot' ? 'SOLO ACTIVACIÓN' : phase === 'boot' && bootNote ? bootNote : statusText[phase]}
          </span>
        </div>
      </header>

      {/* Left rail: which integrations are live */}
      {ui.chrome.systems && (
        <aside className="rail rail-left">
          <div className="rail-title">SYSTEMS</div>
          {connected.length === 0 && <div className="rail-item dim">none linked</div>}
          {connected.map((c) => (
            <div key={c} className="rail-item">
              <span className="tick" />
              {c}
            </div>
          ))}
          <div className="rail-item">
            <span className="tick" />
            Web
          </div>
        </aside>
      )}

      {/* Right rail: live telemetry, mostly for flavour */}
      <aside className="rail rail-right">
        <div className="rail-title">SIGNAL</div>
        <div className="meter">
          <div className="meter-fill" style={{ height: `${level * 100}%` }} />
        </div>
        <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div>
      </aside>

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && (
          <motion.div
            className="tool-badge"
            // Anchored to the TOP of the frame, not the middle. The old home was
            // viewport-centre plus a fixed drop, which on a tall or square
            // window landed the headline straight on top of the bottom
            // transcript — two elements pinned to different edges of the screen
            // were always going to meet somewhere. Up here it sits in its own
            // band with the rest of the status chrome and can never collide with
            // the log. Framer owns `transform` on an animated element, so the
            // centring (x: -50%) lives in these props, not the stylesheet.
            initial={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
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

      {/* Conversation log — last few turns, fading upward */}
      {ui.chrome.transcript && turns.length > 0 && (
        <div className="log" ref={log} tabIndex={0} aria-label="Mensajes de la conversación"
          onScroll={() => { const el = log.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56 }}>
          <AnimatePresence initial={false}>
            {turns.slice(-4).map((t) => (
              <motion.div
                key={t.id}
                className={`log-line log-${t.role}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              >
                <span className="log-who">{t.role === 'user' ? 'TÚ' : displayName(profile)}</span>
                <div className="log-text"><ResponseText text={t.text} /></div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

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

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {ui.chrome.suggestions && <Suggestions />}

      {error && <div className="error">{error}</div>}

      <footer className="hud-bottom">
        <ListeningControl paused={conversationPaused} disabled={phase === 'offline' || phase === 'boot'}
          name={wakeWord(profile)} onPause={onPause} onResume={onResume} />
        {recording && (
          <button type="button" aria-pressed={recording.active}
            style={{ pointerEvents: 'auto', color: 'inherit', background: 'transparent', border: '1px solid currentColor', padding: '6px 10px', cursor: 'pointer', font: 'inherit' }}
            onClick={() => { void setRecordingActive(!recording.active).catch((err: Error) => useStore.getState().setError(err.message)) }}
            title={recording.error || 'Capturas + micrófono + sonido del PC. Se conservan los últimos 30 minutos.'}>
            {recording.error ? '⚠ ' : recording.active ? '● ' : ''}
            {recording.active ? `REC · ${recording.fps.toFixed(1)} fps · mic + PC · Pausar` : 'Historial pausado · Reanudar'}
            {recording.error && ` · ${recording.error}`}
          </button>
        )}
        <span className="hint">
          di <b>“hola, {wakeWord(profile)}”</b> · <kbd>Space</kbd> para hablar · <kbd>G</kbd> manos
          {screenCapture !== 'off' && (
            <span role="status">{' · '}{screenCapture === 'capturing'
              ? 'Capturando monitor…'
              : screenCapture === 'attached' ? 'Captura del monitor adjunta' : 'Sin captura del monitor'}</span>
          )}
          {voice && (
            <>
              {' · '}
              <kbd>V</kbd> voice: {voice.replace(/\(.*?\)/g, '').trim()}
            </>
          )}
        </span>
      </footer>

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
