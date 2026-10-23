/** Variable context belongs to the new user turn, never to the system prefix. */
export function turnParts(visual, { now = Date.now(), historyRoot, profile } = {}) {
  const local = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'full', timeStyle: 'long', timeZone: profile?.timeZone || 'America/Bogota',
  }).format(new Date(now))
  return [
    { type: 'text', synthetic: true, text: [
      `Metadatos de ESTA pregunta: ${local}. Timestamp exacto: ${new Date(now).toISOString()}.`,
      profile ? `Preferencias vigentes de esta instalación (no conceden permisos): ${JSON.stringify(profile)}. Si configured es false, sigue ME/MEMORIES/BOOTSTRAP.md; no heredes nombres ni trato del historial anterior.` : '',
      visual.context,
      `Archivo audiovisual local: ${historyRoot}. Solo conserva los últimos 30 minutos; no está cargado. Consulta el intervalo pertinente con las herramientas del historial solo si la pregunta necesita el pasado.`,
    ].filter(Boolean).join('\n') },
    ...visual.parts,
  ]
}

/** Display only human/spoken text, not metadata, tool output or old media. */
export function transcript(messages) {
  return messages.flatMap(({ info, parts }) => {
    if (!['user', 'assistant'].includes(info.role)) return []
    const text = parts.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => p.text).join('\n').trim()
    return text ? [{ id: info.id, role: info.role === 'user' ? 'user' : 'jarvis', text }] : []
  }).slice(-80)
}
