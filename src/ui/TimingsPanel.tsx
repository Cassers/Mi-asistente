import { useEffect, useMemo, useState } from 'react'
import { refreshTimings, summarizeTimings, timingLabels, useTimings } from '../lib/timings'
const duration = (ms: number | null) => ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
const outcome: Record<string, string> = { ok: 'Completado', error: 'Error', cancelled: 'Cancelado / sin salida', detached: 'Vista desconectada', fallback: 'Alternativa usada', timeout: 'Tiempo agotado' }

export function TimingsPanel() {
  const { rows, persistence, dropped } = useTimings()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    void refreshTimings()
    const poll = setInterval(() => { setNow(Date.now()); void refreshTimings() }, 3000)
    return () => clearInterval(poll)
  }, [open])
  const traces = useMemo(() => {
    const ordered = [...rows].sort((a,b) => b.at - a.at)
    const conversational = ordered.filter(e => ['turn.total','voice.input'].includes(e.name))
    return [...new Map([...conversational, ...ordered].map(e => [e.traceId, e])).values()].slice(0, 40)
  }, [rows])
  const traceID = traces.some(e => e.traceId === selected) ? selected : traces[0]?.traceId
  const stages = rows.filter(e => e.traceId === traceID).sort((a,b) => a.at - b.at)
  const summaries = useMemo(() => summarizeTimings(rows), [rows])
  const active = rows.filter(e => e.phase === 'start').length
  const exportData = () => {
    const file = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), events: rows }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tiempos-asistente.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <details className="timings-panel" onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => event.stopPropagation()}>
    <summary>Rendimiento y tiempos <span>{active ? `${active} en curso` : `${rows.length} mediciones`}</span></summary>
    {open && <div className="timings-content">
      <p>Medición local activa. No se guardan conversaciones, imágenes, audio ni credenciales.</p>
      <p role="status">{persistence === 'unavailable' ? 'Sin confirmar guardado; se siguen mostrando mediciones de esta página.' : persistence === 'saved' ? 'Registro local conectado.' : 'Recogiendo mediciones…'}{dropped > 0 && ` ${dropped} muestras no se pudieron guardar.`}</p>
      <label>Flujo reciente<select value={traceID || ''} onChange={e => setSelected(e.target.value)}>
        {!traces.length && <option value="">Todavía sin mediciones</option>}
        {traces.map(e => <option key={e.traceId} value={e.traceId}>{new Date(e.at).toLocaleTimeString()} · {timingLabels[e.name]} · {e.traceId.slice(0, 6)}</option>)}
      </select></label>
      <ol className="timings-stages">{stages.map(e => <li key={e.source + e.id}>
        <div><strong>{timingLabels[e.name]}</strong><span>{e.phase === 'start' ? `${duration(Math.max(0, now - e.at))}…` : duration(e.durationMs)}</span></div>
        <small>{e.source === 'browser' ? 'Página' : 'Bridge'} · {e.phase === 'start' ? 'En curso' : outcome[e.status]}</small>
      </li>)}</ol>
      <details><summary>Resumen por etapa · mediana y p95</summary>
        <div className="timings-table"><table><thead><tr><th>Etapa</th><th>n</th><th>Mediana</th><th>p95</th><th>Otros estados</th></tr></thead>
          <tbody>{summaries.map(s => <tr key={s.source + s.name}><th>{timingLabels[s.name]}<small>{s.source === 'browser' ? 'Página' : 'Bridge'}</small></th><td>{s.count}</td><td>{duration(s.p50)}</td><td>{duration(s.p95)}</td><td>{s.other}</td></tr>)}</tbody></table></div>
      </details>
      <p>p95: el 95 % de las muestras completadas quedó por debajo de ese tiempo. Con pocas muestras es orientativo. Las etapas se solapan: no se suman. OpenCode se mide desde fuera; su tiempo incluye modelo, herramientas y esperas.</p>
      <button type="button" onClick={exportData} disabled={!rows.length}>Exportar mediciones</button>
      <p>Hasta 2.000 etapas en pantalla. Archivo local rotativo: hasta unos 4 MB. La ventana de carpeta incluye el tiempo que tardas en elegirla.</p>
    </div>}
  </details>
}
