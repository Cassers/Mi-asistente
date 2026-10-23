const isMedia = (part) => part.type === 'file' && /^(image|audio|video)\//.test(part.mime ?? '')
const isScreenshotRead = (part) => part.type === 'text' && part.synthetic &&
  part.text?.startsWith('Called the Read tool with the following input:') &&
  part.text.includes('/jarvis-session-screen-')

/** Before adding THIS turn's screenshot, evict old visual payloads, not text
 * or recordings. Historical evidence stays available through the archive MCP. */
export async function clearPreviousMedia(api, sessionID, { signal } = {}) {
  signal?.throwIfAborted()
  const sessionPath = `/session/${encodeURIComponent(sessionID)}`
  const messages = await api('GET', `${sessionPath}/message`, undefined, { signal })
  const removed = { files: 0, toolAttachments: 0, screenshotReferences: 0 }
  for (const message of messages) {
    for (const part of message.parts) {
      signal?.throwIfAborted()
      // Never mutate a part owned by another session/message.
      if (part.sessionID !== sessionID || part.messageID !== message.info.id) {
        throw new Error('Invalid session media ownership')
      }
      const path = `${sessionPath}/message/${encodeURIComponent(message.info.id)}/part/${encodeURIComponent(part.id)}`
      if (isMedia(part) || isScreenshotRead(part)) {
        const ok = await api('DELETE', path, undefined, { signal })
        if (ok !== true) throw new Error('OpenCode did not remove old media')
        if (isMedia(part)) removed.files++
        else removed.screenshotReferences++
      } else if (part.type === 'tool' && part.state?.status === 'completed' && part.state.attachments?.some(isMedia)) {
        const attachments = part.state.attachments.filter((p) => !isMedia(p))
        const updated = await api('PATCH', path, { ...part, state: { ...part.state, attachments } }, { signal })
        if (updated?.id !== part.id || updated?.type !== 'tool' || updated.state?.attachments?.some(isMedia)) {
          throw new Error('OpenCode did not clear old tool media')
        }
        removed.toolAttachments += part.state.attachments.length - attachments.length
      }
    }
  }
  signal?.throwIfAborted()
  return removed
}
