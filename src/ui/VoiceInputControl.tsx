import type { Application } from '../lib/projects'
import { useId } from 'react'
import { setVoiceInputMode, useVoiceInputMode, useVoiceInputStatus } from '../lib/voice-input-mode'
import { refreshWhisper, useWhisperCapabilities } from '../lib/whisper'

export function VoiceInputControl({ disabled = false, application = 'opencode' }: { disabled?: boolean; application?: Application }) {
  const name = { opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }[application]
  const mode = useVoiceInputMode(application)
  const status = useVoiceInputStatus()
  const whisper = useWhisperCapabilities()
  const id = useId()
  return <section aria-label="Entrada de voz">
    <label htmlFor={id}>Cómo enviar mi voz</label>
    <select id={id} value={mode} disabled={disabled} aria-describedby={`${id}-help`} onChange={event => setVoiceInputMode(event.target.value, application)}>
      <option value="direct" disabled={application !== 'opencode'}>Audio directo · responde en cada pausa</option>
      <option value="transcript">Solo transcripción · navegador</option>
      <option value="whisper">Whisper local · solo texto</option>
    </select>
    {application !== 'opencode' && <p className="model-picker__warning">{name} recibe solo texto transcrito, sin adjuntar audio. El audio directo está deshabilitado. Elige dictado del navegador o Whisper local. La elección de OpenCode se conserva.</p>}
    <p id={`${id}-help`}>{mode === 'direct'
      ? 'Cada pausa envía tu audio al modelo elegido, sin transcribirlo antes. Si vuelves a hablar, interrumpes la respuesta y continúas en el mismo chat. El dictado visible solo sirve como subtítulo. Puede consumir saldo o cuota.'
      : mode === 'whisper' ? 'Whisper transcribe en el equipo local, incluida la activación por nombre. Se envía únicamente el texto reconocido; nunca el clip ni un subtítulo del navegador. No hay cambio automático a otro motor.'
        : 'Se envía únicamente el texto del dictado del navegador. No se envía el clip de voz.'}</p>
    <p>La elección se guarda por aplicación en este navegador. Cambiarla no activa el micrófono.</p>
    {mode === 'whisper' && <div className="whisper-availability" role="status">
      <p>{whisper.state === 'ready' && whisper.capabilities ? `Whisper disponible · ${whisper.capabilities.model || 'modelo local'}. Límite: ${(whisper.capabilities.maxBytes / 1048576).toFixed(1)} MB · ${whisper.capabilities.maxSeconds} s.`
        : whisper.error || 'Consultando Whisper local…'}</p>
      <button type="button" className="surface-button" disabled={whisper.state === 'loading'} onClick={() => { void refreshWhisper().catch(() => {}) }}>Comprobar disponibilidad</button>
    </div>}
    <p role="status" aria-live="polite">{status}</p>
  </section>
}
