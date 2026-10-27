import type { PermissionMode } from '../lib/bridge'
import { useEffect, useRef, useState } from 'react'
import { VoiceInputControl } from './VoiceInputControl'

const names: Record<PermissionMode, string> = { manual: 'Manual', limited: 'Automático limitado', total: 'Automático total' }
type Props = { application?: 'opencode' | 'codex'; mode: PermissionMode; connected: boolean; pending: boolean; error: string; autoApproved: number; rate: number;
  onMode: (mode: PermissionMode) => void; onRate: (rate: number) => void; onResetRate: () => void }

export function AssistantSettings({ mode, connected, pending, error, autoApproved, rate, onMode, onRate, onResetRate, application = 'opencode' }: Props) {
  const [confirmingTotal, setConfirmingTotal] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  useEffect(() => { if (confirmingTotal) cancel.current?.focus() }, [confirmingTotal])
  return <details className="model-picker assistant-settings" data-permission-mode={mode}>
    <summary><span>Voz y permisos</span><small>{rate.toFixed(2)}× · {names[mode]}{pending ? ' · Aplicando…' : ''}</small></summary>
    <div className="model-picker__body">
      <VoiceInputControl disabled={pending} application={application} />
      <div className="assistant-settings__rate-label"><label htmlFor="assistant-speech-rate">Velocidad de voz</label>
        <output htmlFor="assistant-speech-rate">{rate.toFixed(2)}×</output></div>
      <input id="assistant-speech-rate" type="range" min="0.5" max="2" step="0.05" value={rate}
        aria-valuetext={`${rate.toFixed(2)} veces la velocidad normal`} onChange={e => onRate(Number(e.target.value))} />
      <div className="assistant-settings__scale" aria-hidden="true"><span>0.5× · Pausada</span><span>2× · Rápida</span></div>
      <p>Se aplica a las próximas frases. Se guarda en este navegador; no cambia tu configuración del asistente.</p>
      <button type="button" className="surface-button" onClick={onResetRate}>Usar velocidad del perfil</button>
      <label htmlFor="assistant-permission-mode">Modo de permisos</label>
      <select id="assistant-permission-mode" ref={select} value={mode} disabled={!connected || pending} onChange={e => {
        const next = e.target.value as PermissionMode
        if (next === 'total' && mode !== 'total') setConfirmingTotal(true)
        else { setConfirmingTotal(false); onMode(next) }
      }}>
        <option value="manual">Manual · preguntar</option>
        <option value="limited">Automático limitado · leer configuración</option>
        <option value="total">Automático total · riesgo elevado</option>
      </select>
      {confirmingTotal && <section className="assistant-settings__warning" role="group" aria-labelledby="total-mode-warning">
        <h3 id="total-mode-warning">¿Activar automático total?</h3>
        <p>Podrá ejecutar comandos, modificar o borrar archivos y acceder fuera de su carpeta sin preguntarte. Solo para esta conexión; se respetan los bloqueos explícitos de la aplicación.</p>
        <p>No aprueba solicitudes anteriores. Volver a Manual no deshace operaciones ya iniciadas.</p>
        <button type="button" className="surface-button" ref={cancel} onClick={() => { setConfirmingTotal(false); select.current?.focus() }}>Cancelar</button>
        <button type="button" className="surface-button surface-button--approve" disabled={!connected || pending} onClick={() => { setConfirmingTotal(false); onMode('total'); select.current?.focus() }}>Activar modo total</button>
      </section>}
      <p>{mode === 'manual' ? 'Pide permiso para las operaciones que no estén ya preautorizadas en la aplicación.'
        : mode === 'limited' ? 'Solo autoaprueba leer los archivos básicos de su configuración: CONFIG, AGENTS, identidad, usuario y memorias base. Comandos, cambios y archivos fuera de esa lista siguen pidiendo permiso.'
        : 'ATENCIÓN: puede ejecutar comandos, modificar o borrar archivos y acceder fuera de su carpeta sin preguntarte. Los bloqueos explícitos de la aplicación siguen vigentes.'}</p>
      <p>Solo durante esta conexión. Al recargar, reconectar o cambiar de chat vuelve a Manual. Cambiar el modo no aprueba solicitudes anteriores ni deshace operaciones ya iniciadas.</p>
      <p role="status">{connected ? `${autoApproved} aprobaciones automáticas en esta conexión.` : 'Conecta con la aplicación para ajustar permisos.'}</p>
      {mode !== 'manual' && <button type="button" className="surface-button" disabled={!connected || pending} onClick={() => onMode('manual')}>Volver a Manual</button>}
      {error && <p className="surface-error" role="alert">{error}</p>}
    </div>
  </details>
}
