import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { openProject, refreshProjects, selectProject, useProjects, type Application } from '../lib/projects'
import { timedFetch } from '../lib/timings'

export function ProjectPicker({ disabled = false }: { disabled?: boolean }) {
  const { projects, selected, loading, error, available, defaultServerURL, applications }  = useProjects()
  const id = useId()
  const [applicationChoice, setApplicationChoice] = useState<{ project?: string; application: Application }>({ project: selected?.id, application: selected?.application || 'opencode' })
  const application = applicationChoice.project === selected?.id ? applicationChoice.application : selected?.application || 'opencode'
  const setApplication = (next: Application) => setApplicationChoice({ project: selected?.id, application: next })
  const applicationName = ({ opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' } as const)[application]
  const [directory, setDirectory] = useState('')
  const [serverURL, setServerURL] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [localError, setLocalError] = useState('')
  const [status, setStatus] = useState('')
  const busy = loading || browsing
  const locked = disabled || busy || !available

  async function browse() {
    if (locked) return
    setBrowsing(true)
    setLocalError('')
    setStatus('Elige una carpeta en la ventana del sistema.')
    try {
      const res = await timedFetch('project.browse', `${BRIDGE_HTTP_URL}/projects/browse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'No se pudo elegir la carpeta.')
      if (data?.directory !== null && typeof data?.directory !== 'string') throw new Error('La carpeta recibida no es válida.')
      if (data.directory !== null) setDirectory(data.directory)
      setStatus('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo elegir la carpeta.')
      setStatus('')
    } finally { setBrowsing(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    const secret = password
    setPassword('')
    setLocalError('')
    setStatus('')
    try {
      const existing = projects.find(project => project.application === application && project.directory === directory.trim())
      const opened = await openProject({ directory, application, ...(application === 'opencode' ? { serverURL: serverURL ?? existing?.serverURL ?? (selected?.application === 'opencode' ? selected.serverURL : defaultServerURL), password: secret } : {}) })
      setStatus(`Proyecto abierto: ${opened.name}.`)
    } catch { /* Store exposes a credential-redacted error. */ }
  }

  return <section className="conversation-card project-picker" aria-label="Proyectos" aria-busy={busy} onKeyDown={event => event.stopPropagation()}>
    <span className="surface-eyebrow">PROYECTO</span>
    {!available && <p role="status">Este puente usa el modo anterior; abrir proyectos no está disponible.</p>}
    <form onSubmit={submit}>
      <fieldset disabled={locked}>
        <legend>Abrir un proyecto</legend>
        <p>Abre solo carpetas de confianza: {applicationName} cargará sus instrucciones, skills y MCPs según su configuración nativa.</p>
        <label htmlFor={`${id}-application`}>Aplicación</label>
        <select id={`${id}-application`} value={application} onChange={event => {
          setApplication(event.target.value as Application)
          setPassword(''); setServerURL(null)
          if (!directory && selected) setDirectory(selected.directory)
        }}>
          <option value="opencode">OpenCode</option><option value="codex">Codex</option>
          {(['claude','antigravity'] as Application[]).map(id => { const info = applications?.find(app => app.id === id); return <option key={id} value={id} disabled={!info?.available}>{id === 'claude' ? 'Claude Code' : 'Antigravity'}{info?.available ? '' : ' · No disponible'}</option> })}
        </select>
        {applications?.filter(app => !app.available).map(app => <p key={app.id} role="status">{app.name}: {app.reason}</p>)}
        {application === 'antigravity' && <p>Conexión con agy instalado: solo texto. Historial de conversaciones creadas en Mi-asistente; los permisos se resuelven en sus reglas nativas.</p>}
        {application === 'claude' && <p>Usa Claude Code instalado, su cuenta y la configuración de esta carpeta. No reemplaza las instrucciones del proyecto.</p>}
        {application === 'codex' && <p>Usa Codex instalado en este equipo y su sesión iniciada. No necesitas pegar una clave aquí.</p>}
        <label htmlFor={`${id}-recent`}>Proyectos recientes</label>
        <select id={`${id}-recent`} value={selected?.id || ''} onChange={event => {
          selectProject(event.target.value)
          const next = projects.find(project => project.id === event.target.value)
          if (next) setApplication(next.application)
          setServerURL(null)
          setPassword('')
          setLocalError('')
          setStatus('')
        }}>
          <option value="" disabled>Elige un proyecto</option>
          {projects.map(p => <option key={p.id} value={p.id}>{({ opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' } as const)[p.application]} · {p.name} · {p.directory}</option>)}
        </select>
        <label htmlFor={`${id}-path`}>Ruta del proyecto</label>
        <input id={`${id}-path`} type="text" value={directory} onChange={event => setDirectory(event.target.value)} required autoComplete="off" placeholder="/ruta/a/tu/proyecto" />
        <button type="button" className="surface-button" onClick={() => { void browse() }}>Examinar carpeta</button>
        {application === 'opencode' && <details>
          <summary>Detalles de conexión</summary>
          <label htmlFor={`${id}-server`}>Servidor de OpenCode (URL)</label>
          <input id={`${id}-server`} type="url" value={serverURL ?? (selected?.application === 'opencode' ? selected.serverURL : defaultServerURL)} onChange={event => setServerURL(event.target.value)} placeholder="http://127.0.0.1:4096" autoComplete="off" />
          <label htmlFor={`${id}-password`}>Contraseña de OpenCode (opcional)</label>
          <input id={`${id}-password`} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" aria-describedby={`${id}-privacy`} />
          <p id={`${id}-privacy`}>La contraseña se usa al abrir y no se guarda en este navegador.</p>
        </details>}
        <button type="submit" className="surface-button" disabled={!directory.trim()}>Abrir proyecto</button>
      </fieldset>
    </form>
    <button type="button" className="surface-button" disabled={disabled || busy} onClick={() => { setLocalError(''); setStatus(''); void refreshProjects() }}>Actualizar proyectos</button>
    <p role="status" aria-live="polite">{browsing ? 'Esperando carpeta…' : loading ? 'Cargando proyecto…' : status || (selected ? `Proyecto seleccionado: ${selected.name}` : '')}</p>
    {(localError || error) && <p className="surface-error" role="alert">{localError || error}</p>}
  </section>
}
