type Props = { paused: boolean; disabled: boolean; name: string; muted?: boolean; standby?: boolean; onPause: () => void; onResume: () => void }

export function ListeningControl({ paused, disabled, name, muted = false, standby = false, onPause, onResume }: Props) {
  return <div className="listening-control" data-paused={paused}>
    <button type="button" className="surface-button" disabled={disabled} aria-pressed={paused}
      aria-describedby="listening-explanation" onClick={!muted && !standby && paused ? onResume : onPause}>
      <svg viewBox="0 0 20 20" aria-hidden="true">{paused && !muted && !standby
        ? <path d="m7 4 8 6-8 6Z" /> : <path d="M7 4v12M13 4v12" />}</svg>
      {muted || standby ? 'Detener respuesta' : paused ? 'Reanudar conversación' : 'Pausar conversación'}
    </button>
    <span id="listening-explanation">{muted || standby
      ? standby && !muted ? 'Detiene la respuesta actual sin reactivar la escucha.' : 'Detiene la respuesta actual sin activar el micrófono.'
      : <>{paused ? `Solo activación: di “${name}” o pulsa Espacio.` : 'Pausa hasta el nombre del agente o Espacio.'}
        {' '}El micrófono sigue activo para detectar el nombre; el historial se controla aparte.</>}</span>
  </div>
}
