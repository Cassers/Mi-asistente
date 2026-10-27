import type { Phase } from '../store'
import type { VoiceMode } from './voice'

/** Standby is not hardware mute: the wake-name recognizer stays active. */
export function listeningMode(phase: Phase, configured: boolean, paused: boolean, muted = false, standby = false): VoiceMode {
  if (muted) return 'deaf'
  if (phase === 'offline' || phase === 'boot') return 'deaf'
  if (paused || standby) return 'wake'
  if (phase === 'dormant') return configured ? 'wake' : 'command'
  if (phase === 'listening' || phase === 'waking') return 'command'
  return 'guard'
}
