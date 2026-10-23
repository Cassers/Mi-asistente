import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { useProfile, wakeWord } from '../lib/profile'

/**
 * Rotating example commands, shown only while idle.
 *
 * A voice interface has no menus — nothing tells you what it can do. This is
 * the affordance. It disappears the moment JARVIS is doing anything, so it
 * never competes with the answer.
 *
 * Each line is phrased the way you'd actually say it, not as a feature name.
 */
const EXAMPLES = [
  'qué pasó en IA esta semana',
  'busca noticias de educación en Colombia',
  'qué tengo en el calendario mañana',
  'busca el mejor café cerca de mí',
  'léeme la noticia principal de Hacker News',
  'resume lo que hay en mi correo',
  'qué clima va a hacer hoy',
  'explícame qué es una API en una frase',
]

const ROTATE_MS = 4200

export function Suggestions() {
  const profile = useProfile()
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Only while genuinely idle, and only until the first exchange — once the
  // user knows how it works, the prompt is just clutter.
  if (phase !== 'dormant' || turns.length > 0) return null

  return (
    <div className="suggest">
      <span className="suggest-lead">prueba</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          “hola, {wakeWord(profile)}, {EXAMPLES[i]}”
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
