type Props = { paused: boolean; disabled: boolean; name: string; onPause: () => void; onResume: () => void }

export function ListeningControl({ paused, disabled, name, onPause, onResume }: Props) {
  return <div className="listening-control" data-paused={paused}>
    <button type="button" className="surface-button" disabled={disabled} aria-pressed={paused}
      aria-describedby="listening-explanation" onClick={paused ? onResume : onPause}>
      <svg viewBox="0 0 20 20" aria-hidden="true">{paused
        ? <path d="m7 4 8 6-8 6Z" /> : <path d="M7 4v12M13 4v12" />}</svg>
      {paused ? 'Reanudar conversación' : 'Pausar conversación'}
    </button>
    <span id="listening-explanation">{paused ? `Solo activación: di “${name}” o pulsa Espacio.` : 'Pausa hasta el nombre del agente o Espacio.'}
      {' '}El micrófono sigue activo para detectar el nombre; el historial se controla aparte.</span>
  </div>
}
