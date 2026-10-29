import { useState } from 'react'
import { setRecordingActive } from '../lib/brain'
import { useStore } from '../store'

type Recording = NonNullable<ReturnType<typeof useStore.getState>['recording']>
const style = { pointerEvents: 'auto' as const, color: 'inherit', background: 'transparent', border: '1px solid currentColor', padding: '6px 10px', cursor: 'pointer', font: 'inherit' }

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
  return <div style={{ pointerEvents: 'auto' }}>
    <button type="button" aria-pressed={recording.active} aria-busy={pending}
      disabled={pending || incompatible && !recording.active} style={style} onClick={() => { void toggle() }}
      aria-describedby="history-scope"
      title={withoutMicrophone ? 'Capturas + sonido del PC, sin micrófono. Se conservan los últimos 30 minutos.' : 'Capturas + micrófono + sonido del PC. Se conservan los últimos 30 minutos.'}>
      {problem ? '⚠ ' : recording.active ? '● ' : ''}
      {pending ? 'Confirmando historial…' : recording.active ? 'Historial activo · Pausar' : withoutMicrophone ? 'Historial pausado · Reanudar sin micrófono' : 'Historial pausado · Reanudar'}
    </button>
    <span id="history-scope" role="status">{withoutMicrophone ? 'Historial: pantalla y sonido del PC, sin micrófono.' : 'Historial: pantalla, micrófono y sonido del PC.'} Independiente de Compartir pantalla.</span>
    {incompatible && <span role="status">Reinicia el puente para activar los controles de privacidad del historial. No se iniciará una grabación con el puente anterior.</span>}
    {problem && <span role="alert">{problem} · Puedes reintentar.</span>}
  </div>
}

export function ScreenControl({ enabled, onChange, available = true }: { enabled: boolean; onChange: (enabled: boolean) => void; available?: boolean }) {
  return <div style={{ pointerEvents: 'auto' }}>
    <button type="button" style={style} aria-pressed={enabled} disabled={!available && !enabled} onClick={() => { if (available || enabled) onChange(!enabled) }} aria-describedby="screen-scope"
      title="Adjunta una imagen actual si el modelo admite imágenes. No inicia el historial ni el micrófono.">
      {enabled ? 'Compartir pantalla activo · Desactivar' : 'Compartir pantalla apagado · Activar'}
    </button>
    {!available && <span role="status">Conecta el puente actualizado para activar Compartir pantalla.</span>}
    <span id="screen-scope">Envía una captura del monitor principal con cada pregunta al activar Compartir pantalla.</span>
  </div>
}
