import { useId } from 'react'
import { setVoiceInputMode, useVoiceInputMode, useVoiceInputStatus } from '../lib/voice-input-mode'

export function VoiceInputControl({ disabled = false, application = 'opencode' }: { disabled?: boolean; application?: 'opencode' | 'codex' }) {
  const mode = useVoiceInputMode()
  const status = useVoiceInputStatus()
  const id = useId()
  return <section aria-label="Entrada de voz">
    <label htmlFor={id}>Cómo enviar mi voz</label>
    <select id={id} value={mode} disabled={disabled} aria-describedby={`${id}-help`} onChange={event => setVoiceInputMode(event.target.value)}>
      <option value="direct" disabled={application === 'codex'}>Audio directo · responde en cada pausa</option>
      <option value="transcript">Solo transcripción</option>
    </select>
    {application === 'codex' && <p className="model-picker__warning">La integración de Codex admite voz mediante el dictado del navegador. El envío de clips directos todavía no está habilitado.</p>}
    {application === 'codex' && mode === 'direct' && <button type="button" className="surface-button" disabled={disabled} onClick={() => setVoiceInputMode('transcript')}>Usar dictado con Codex</button>}
    <p id={`${id}-help`}>{mode === 'direct'
      ? 'Cada pausa envía tu audio al modelo elegido, sin transcribirlo antes. Si vuelves a hablar, interrumpes la respuesta y continúas en el mismo chat. El dictado visible solo sirve como subtítulo. Puede consumir saldo o cuota.'
      : 'Se envía únicamente el texto del dictado. No se envía el clip de voz.'}</p>
    <p>La elección se guarda en este navegador. Se aplica a tu próxima intervención.</p>
    <p role="status" aria-live="polite">{status}</p>
  </section>
}
