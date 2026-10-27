/** Fixed vocabulary: telemetry cannot carry prompts, paths, URLs or credentials. */
export const timingLabels = Object.freeze({
  'app.ready': 'Primeros fotogramas de la interfaz', 'app.dom': 'Documento: DOM listo', 'app.load': 'Documento: carga completa',
  'app.long_task': 'Bloqueo del navegador', 'app.frame_gap': 'Salto de animación',
  'voice.activation': 'Activar micrófono', 'voice.recognition': 'Primera transcripción',
  'voice.endpoint': 'Esperar fin de voz', 'voice.assembly': 'Unir frase', 'voice.input': 'Intervención de voz',
  'voice.followup': 'Ventana de continuación', 'voice.interruption': 'Interrupción por voz',
  'turn.total': 'Turno hasta terminar de hablar', 'turn.first_audio': 'Pregunta lista → primer sonido', 'turn.connection': 'Esperar conexión',
  'turn.interrupt_wait': 'Confirmar detención antes del siguiente clip',
  'audio.queue': 'Esperar guardado de clips anteriores',
  'turn.selection': 'Resolver selección del modelo', 'turn.first_text': 'Envío → primer texto',
  'turn.response': 'Envío → respuesta completa', 'turn.first_activity': 'Envío → primera actividad',
  'connection.ready': 'Conectar y restaurar chat', 'connection.detach': 'Desconectar vista',
  'project.list': 'Listar proyectos', 'project.open': 'Abrir proyecto', 'project.browse': 'Elegir carpeta',
  'model.catalog': 'Cargar catálogo', 'profile.load': 'Cargar perfil visual',
  'bridge.prepare': 'Preparar petición', 'bridge.membership': 'Comprobar conversación',
  'bridge.status': 'Comprobar disponibilidad', 'bridge.recovery': 'Revisar historial de voz',
  'bridge.selection': 'Resolver modelo y capacidades', 'bridge.submit': 'Entregar petición a OpenCode',
  'bridge.first_text': 'OpenCode → primer texto observado', 'bridge.response': 'Respuesta de OpenCode observada',
  'bridge.sync': 'Sincronizar conversación', 'bridge.event_wait': 'Evento → inicio de sincronización',
  'bridge.events_connect': 'Conectar eventos de OpenCode', 'bridge.interrupt': 'Confirmar detención',
  'audio.total': 'Preparar e interpretar audio', 'audio.model': 'Resolver modelo de audio',
  'audio.capture': 'Duración del clip (no es espera)',
  'audio.encode': 'Convertir WAV a MP3', 'audio.credential': 'Preparar acceso de audio',
  'audio.provider': 'Proveedor: transcribir MP3', 'screen.capture': 'Capturar y adjuntar monitor',
  'permission.wait': 'Esperar autorización', 'tool.observed': 'Herramienta observada',
  'history.toggle': 'Activar o pausar historial', 'history.frame': 'Guardar captura del historial',
  'history.prune': 'Limpiar historial vencido', 'history.publish': 'Actualizar estado del historial',
  'tool.execution': 'Ejecución de herramienta (OpenCode)',
  'tts.first_audio': 'Primer texto → primer sonido', 'tts.synthesis': 'Generar voz',
  'tts.queue': 'Esperar turno de reproducción', 'tts.playback': 'Reproducir frase', 'tts.total': 'Salida de voz completa',
})
export const statuses = ['ok', 'error', 'cancelled', 'fallback', 'timeout', 'detached']
let sequence = 0
export function newTimingID() {
  try { return crypto.randomUUID() } catch { return `timing-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2, 12)}` }
}
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value)
export function validTiming(value, source) {
  if (!value || !id(value.traceId) || !id(value.id) || !Object.hasOwn(timingLabels, value.name) ||
      !['browser','bridge'].includes(value.source) || source && value.source !== source ||
      !['start','end'].includes(value.phase) || !statuses.includes(value.status) ||
      !Number.isFinite(value.at) || value.at < 0 || value.at > Date.now() + 60000 ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000) return null
  return { traceId: value.traceId, id: value.id, name: value.name, source: value.source,
    phase: value.phase, status: value.status, at: value.at, durationMs: Math.round(value.durationMs * 10) / 10 }
}
export function createTimings({ source, emit = () => {}, now = () => performance.now(), wall = () => Date.now(), uuid = newTimingID }) {
  const publish = value => { try { emit(value) } catch { /* Observation must not affect product execution. */ } }
  return {
    start(name, traceId) {
      let started, at, spanID
      try { traceId ||= uuid(); started = now(); at = wall(); spanID = uuid() }
      catch { return { traceId: traceId || newTimingID(), id: newTimingID(), end() {} } }
      let ended = false
      const event = { traceId, id: spanID, name, source, phase: 'start', status: 'ok', at, durationMs: 0 }
      if (Object.hasOwn(timingLabels, name)) publish(event)
      return { traceId, id: spanID, end(status = 'ok') {
        if (ended) return
        ended = true
        try {
          if (Object.hasOwn(timingLabels, name)) publish({ ...event, phase: 'end', status: statuses.includes(status) ? status : 'error', durationMs: Math.max(0, now() - started) })
        } catch { /* Broken timing clocks must not interrupt application work. */ }
      } }
    },
  }
}
export function summarizeTimings(events) {
  const keys = new Map(events.map(e => [e.source + ':' + e.name, { name: e.name, source: e.source }]))
  return [...keys.values()].map(({ name, source }) => {
    const rows = events.filter(e => e.name === name && e.source === source && e.phase === 'end')
    const samples = rows.filter(e => e.status === 'ok').map(e => e.durationMs).sort((a,b) => a-b)
    const percentile = p => samples.length ? samples[Math.max(0, Math.ceil(samples.length * p) - 1)] : null
    return { name, source, count: samples.length, other: rows.length - samples.length, p50: percentile(.5), p95: percentile(.95), max: samples.at(-1) ?? null }
  }).sort((a,b) => (b.p95 ?? -1) - (a.p95 ?? -1))
}
