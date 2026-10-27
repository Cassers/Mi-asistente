import { setTimeout as pause } from 'node:timers/promises'

/** HTTP 204 from prompt_async precedes native message creation. A stop must
 * wait for the audio part itself, not merely acceptance of the background job. */
export async function deliverNativeVoice(api, sessionID, request, { noReply = false, receiptTimeoutMs = 6000 } = {}) {
  const audio = request.parts.find(part => part.type === 'file' && part.mime === 'audio/mpeg')
  const encoded = audio?.url?.split('base64,')[1]
  if (!encoded) throw new Error('Falta el clip que se debe conservar.')
  const saved = message => message?.info?.id === request.messageID && message.parts?.some(part =>
    part.type === 'text' && part.metadata?.miAsistenteAudio?.data === encoded)
  const receipt = async () => {
    const signal = AbortSignal.timeout(receiptTimeoutMs)
    for (;;) {
      signal.throwIfAborted()
      try {
        const message = await api('GET', `/session/${sessionID}/message/${request.messageID}`, undefined, { signal })
        if (saved(message)) return message
      } catch (error) {
        if (!/HTTP 404/.test(error.message)) throw error
      }
      await pause(25, undefined, { signal })
    }
  }
  let message
  try {
    message = await api('POST', `/session/${sessionID}/${noReply ? 'message' : 'prompt_async'}`, noReply ? { ...request, noReply: true } : request)
  } catch (error) {
    if (/HTTP 4\d\d/.test(error.message)) throw error
    // A lost response is not proof that the audio was lost. Reconcile the
    // SAME native message ID; never issue a second POST or invent another ID.
    try { return await receipt() } catch { throw error }
  }
  if (!noReply) return receipt()
  if (!saved(message)) throw new Error('OpenCode no confirmó que guardó el clip completo. No se descartó como una interrupción normal.')
  return message
}
