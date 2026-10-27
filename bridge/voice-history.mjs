import { createHash } from 'node:crypto'

const legacyError = message => /file part media type audio\/wav.*functionality not supported/.test(String(message.info?.error?.data?.message || ''))
const bridgeMessage = id => /^msg_[a-f0-9]{43,46}$/.test(id || '')
const falseStatus = text => text?.trim() === 'No se ha detectado ningún audio adjunto para transcribir.'
const fingerprint = messages => createHash('sha256').update(JSON.stringify(messages.map(message => ({
  role: message.info.role,
  text: message.parts.filter(part => part.type === 'text').map(part => part.text),
  files: message.parts.filter(part => part.type === 'file').map(part => ({ mime: part.mime, filename: part.filename, url: part.url })),
})))).digest('hex')

/** Only repair failed artifacts created by the old JARVIS voice path, after a verified native backup. */
export async function recoverVoiceHistory(api, session, { signal } = {}) {
  signal?.throwIfAborted()
  const messages = await api('GET', `/session/${session.id}/message`)
  const failed = new Set(messages.filter(legacyError).map(message => message.info.parentID))
  const targets = messages.filter(message => message.info.role === 'user' && bridgeMessage(message.info.id) && failed.has(message.info.id)).flatMap(message => message.parts
    .filter(part => part.type === 'file' && part.mime === 'audio/wav' && part.filename === 'mi-voz.wav' && part.url?.startsWith('data:audio/wav;base64,') || part.type === 'text' && !part.ignored && falseStatus(part.text))
    .map(part => ({ messageID: message.info.id, part })))
  if (!targets.length) return null
  async function checkedIdle() {
    signal?.throwIfAborted()
    const live = await api('GET', `/session/${session.id}`)
    if (live.id !== session.id || live.directory !== session.directory) throw new Error('La conversación cambió de carpeta; no se recuperó el historial.')
    const statuses = await api('GET', '/session/status')
    if (statuses[session.id] && statuses[session.id].type !== 'idle') throw new Error('La conversación está trabajando; no se modificó el historial.')
    signal?.throwIfAborted()
  }
  await checkedIdle()
  const backup = await api('POST', `/session/${session.id}/fork`, {})
  if (!backup?.id || backup.id === session.id || !/^ses_[\w-]{1,120}$/.test(backup.id) || backup.directory !== session.directory) throw new Error('El respaldo del historial no se pudo verificar.')
  const saved = await api('GET', `/session/${backup.id}/message`)
  if (fingerprint(saved) !== fingerprint(messages)) throw new Error('El respaldo está incompleto; no se modificó la conversación original.')
  signal?.throwIfAborted()
  await api('PATCH', `/session/${backup.id}`, { title: `${session.title || 'Conversación'} · Respaldo previo a reparar voz`, metadata: { ...backup.metadata, jarvisVoiceBackupOf: session.id }, time: { archived: Date.now() } })
  if (fingerprint(await api('GET', `/session/${session.id}/message`)) !== fingerprint(messages)) throw new Error('El historial cambió durante el respaldo; no se modificó.')
  let removed = 0, hidden = 0
  for (const { messageID, part } of targets) {
    await checkedIdle()
    if (!/^prt_[\w-]+$/.test(part.id || '')) throw new Error('Identificador de adjunto inválido; se conservó el respaldo.')
    const path = `/session/${session.id}/message/${messageID}/part/${part.id}`
    if (part.type === 'file') {
      if (await api('DELETE', path) !== true) throw new Error('No se confirmó la recuperación del adjunto; el respaldo sigue disponible.')
      removed++
    } else {
      // Preserve the text record, but don't display or treat our old status as human speech.
      await api('PATCH', path, { ...part, ignored: true })
      hidden++
    }
  }
  const after = await api('GET', `/session/${session.id}/message`)
  for (const before of messages) {
    const next = after.find(message => message.info.id === before.info.id)
    if (!next || JSON.stringify(before.parts.filter(part => part.type === 'text').map(part => part.text)) !== JSON.stringify(next.parts.filter(part => part.type === 'text').map(part => part.text))) {
      throw new Error('No se pudo verificar el texto recuperado; el respaldo nativo sigue disponible.')
    }
  }
  return { backupID: backup.id, removed, hidden }
}
