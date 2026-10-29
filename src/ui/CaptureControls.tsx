import { useState } from 'react'
import { setRecordingActive } from '../lib/brain'
import { useStore } from '../store'

type Recording = NonNullable<ReturnType<typeof useStore.getState>['recording']>

export function HistoryControl({ recording, muted }: { recording: Recording; muted: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const withoutMicrophone = recording.active ? recording.audio?.includes('mic') === false : muted
  const incompatible = recording.controlVersion !== 1
  const problem = error || recording.error
  const toggle = async () => {
    if (pending || incompatible && !recording.active) return
    setPending(true); setError('')
    try { await setRecordingActive(!recording.active) }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'No se confirmó el cambio del historial.'
      setError(message); useStore.getState().setError(message)
    } finally { setPending(false) }
  }
  return <section className="control-section control-section--history" aria-labelledby="history-controls-title">
    <h2 className="control-section__title" id="history-controls-title">Historial</h2>
    <p className="control-state" role="status">{pending ? 'Confirmando cambio…' : recording.active ? 'Activo' : 'Pausado'}</p>
    <button type="button" className="surface-button" aria-pressed={recording.active} aria-busy={pending}
      disabled={pending || incompatible && !recording.active} onClick={() => { void toggle() }}
      aria-describedby="history-scope"
      title={withoutMicrophone ? 'Capturas + sonido del PC, sin micrófono. Se conservan los últimos 30 minutos.' : 'Capturas + micrófono + sonido del PC. Se conservan los últimos 30 minutos.'}>
      {problem ? '⚠ ' : recording.active ? '● ' : ''}
      {pending ? 'Confirmando historial…' : recording.active ? 'Historial activo · Pausar' : withoutMicrophone ? 'Historial pausado · Reanudar sin micrófono' : 'Historial pausado · Reanudar'}
    </button>
    <span id="history-scope" className="control-help">{withoutMicrophone ? 'Historial: pantalla y sonido del PC, sin micrófono.' : 'Historial: pantalla, micrófono y sonido del PC.'} Independiente de Compartir pantalla.</span>
    {incompatible && <span className="control-help" role="status">Reinicia el puente para activar los controles de privacidad del historial. No se iniciará una grabación con el puente anterior.</span>}
    {problem && <span className="control-error" role="alert">{problem} · Puedes reintentar.</span>}
  </section>
}

export function ScreenControl({ enabled, onChange, available = true, captureStatus = 'off', unavailableReason }: {
  enabled: boolean; onChange: (enabled: boolean) => void; available?: boolean; unavailableReason?: string
  captureStatus?: 'off' | 'capturing' | 'attached' | 'failed'
}) {
  return <section className="control-section control-section--screen" aria-labelledby="screen-controls-title">
    <h2 className="control-section__title" id="screen-controls-title">Pantalla</h2>
    <p className="control-state" role="status" aria-live="polite">{!enabled ? available ? 'Apagada' : 'Apagada · no disponible' : !available ? 'No disponible'
      : captureStatus === 'capturing' ? 'Capturando monitor…' : captureStatus === 'attached' ? 'Captura adjunta al último envío'
        : captureStatus === 'failed' ? 'Falló la captura del último envío' : 'Activada · próxima pregunta'}</p>
    <button type="button" className="surface-button" aria-pressed={enabled} disabled={!available && !enabled} onClick={() => { if (available || enabled) onChange(!enabled) }} aria-describedby="screen-scope"
      title="Adjunta una imagen actual si el modelo admite imágenes. No inicia el historial ni el micrófono.">
      {enabled ? available ? 'Compartir pantalla activo · Desactivar' : 'Compartir pantalla no disponible · Desactivar' : 'Compartir pantalla apagado · Activar'}
    </button>
    {!available && <span className="control-help" role="status">{unavailableReason || 'Conecta el puente actualizado para activar Compartir pantalla.'}</span>}
    <span id="screen-scope" className="control-help">Envía una captura del monitor principal con cada pregunta al activar Compartir pantalla, si el modelo admite imágenes. No inicia el historial ni el micrófono.</span>
  </section>
}
