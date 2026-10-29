type Props = {
  muted: boolean
  busy: boolean
  onToggle: () => void
  historyActive: boolean
  historyMicrophone?: boolean
  inactive?: boolean
  standby?: boolean
  name?: string
  onStandby?: () => void
  availability?: 'active' | 'wake' | 'off'
}

export function MicrophoneControl({ muted, busy, onToggle, historyActive, historyMicrophone = true, inactive = false,
  standby = false, name = 'Asistente', onStandby, availability }: Props) {
  const off = muted || inactive || availability === 'off'
  const wakeOnly = !off && (availability === 'wake' || standby)
  const wakeControl = !!onStandby && !off
  return <div className="microphone-control" data-muted={off} data-standby={wakeOnly}>
    <p className="control-state" role="status">{off ? 'MICRÓFONO APAGADO' : wakeOnly ? 'SOLO ACTIVACIÓN' : 'ESCUCHA ACTIVA'}</p>
    <div className="microphone-actions">
      <button type="button" className="surface-button" aria-pressed={!off && !wakeOnly}
        disabled={busy} onClick={wakeControl ? onStandby : onToggle} aria-describedby="microphone-explanation">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          {off && <path d="m3 3 18 18" />}
        </svg>
        {busy ? 'Activando micrófono…' : off ? 'Activar micrófono'
          : wakeControl ? standby ? 'Reactivar escucha' : wakeOnly ? 'Exigir saludo de activación' : 'Silenciar conversación' : 'Apagar micrófono'}
      </button>
      {wakeControl && <button type="button" className="surface-button microphone-hardoff" disabled={busy}
        onClick={onToggle} aria-describedby="microphone-hardoff-explanation">Apagar por completo</button>}
    </div>
    <span id="microphone-explanation" className="control-help">{muted
      ? `Micrófono apagado: no escucha ni su nombre. La respuesta continúa.${historyActive ? historyMicrophone ? ' Historial: esperando confirmación de pausa…' : ' Historial activo sin micrófono: pantalla y sonido del PC.' : ' Historial pausado.'}`
      : inactive
        ? 'Activa la voz para usar el micrófono. Abrir proyectos no inicia captura de audio.'
        : wakeControl
          ? standby
            ? `Di «hola, ${name}» para reactivar. El micrófono sigue escuchando la activación; la respuesta continúa.`
            : wakeOnly
              ? 'Di «' + name + '» o pulsa Espacio. Exigir saludo cambia la activación a «hola, ' + name + '».'
              : 'Escucha activa. Silenciar conversación mantiene la activación por voz y la respuesta.'
          : 'Micrófono del asistente activo. Apágalo para hablar con tus estudiantes.'}</span>
    {wakeControl && <span id="microphone-hardoff-explanation" className="control-help">Apagar por completo impide reactivar por voz.</span>}
  </div>
}
