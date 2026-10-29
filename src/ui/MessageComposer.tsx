import { useEffect, useRef, useState } from 'react'
import { refreshWhisper, subscribeWhisperInvalidation, transcribeWhisper, useWhisperCapabilities, whisperAccept } from '../lib/whisper'

type Props = { onSendMessage: (text: string) => boolean | Promise<boolean> }
type Attachment = { file: File | null; phase: 'idle' | 'transcribing' | 'ready' | 'failed' | 'cancelled'; text: string; error: string }
const emptyAttachment = (): Attachment => ({ file: null, phase: 'idle', text: '', error: '' })

export function MessageComposer({ onSendMessage }: Props) {
  const [draft, setDraft] = useState('')
  const composing = useRef(false)
  const pending = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [audio, setAudio] = useState<Attachment>(emptyAttachment)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const whisper = useWhisperCapabilities()
  const caps = whisper.capabilities
  const available = whisper.state === 'ready' && caps?.available === true
  useEffect(() => {
    const stopCurrent = () => { generation.current++; request.current?.abort(); request.current = null }
    const invalidate = () => {
      stopCurrent()
      setAudio(emptyAttachment())
      if (fileInput.current) fileInput.current.value = ''
    }
    const unsubscribe = subscribeWhisperInvalidation(invalidate)
    return () => { unsubscribe(); stopCurrent() }
  }, [])

  const transcribe = async (file: File) => {
    request.current?.abort()
    const mine = ++generation.current
    const controller = new AbortController()
    request.current = controller
    setSendError('')
    setAudio({ file, phase: 'transcribing', text: '', error: '' })
    try {
      const text = await transcribeWhisper(file, { signal: controller.signal, filename: file.name, capabilities: caps || undefined })
      if (mine !== generation.current || controller.signal.aborted) return
      setAudio({ file, phase: 'ready', text, error: '' })
    } catch (cause) {
      if (mine !== generation.current || controller.signal.aborted) return
      setAudio({ file, phase: 'failed', text: '', error: cause instanceof Error ? cause.message : 'No se pudo transcribir con Whisper local.' })
    } finally { if (mine === generation.current) request.current = null }
  }
  const cancel = (remove = false) => {
    generation.current++; request.current?.abort(); request.current = null
    setAudio(current => remove ? emptyAttachment() : { ...current, phase: 'cancelled', text: '', error: '' })
    if (fileInput.current) fileInput.current.value = ''
  }
  const send = async () => {
    if (audio.file && (audio.phase !== 'ready' || !audio.text.trim())) return
    const text = [draft.trim(), audio.file ? audio.text.trim() : ''].filter(Boolean).join('\n\n')
    if (!text || composing.current || pending.current) return
    const attached = audio
    const mine = generation.current
    pending.current = true; setSending(true); setSendError('')
    try {
      if (await onSendMessage(text) === true) {
        setDraft(current => current === draft ? '' : current)
        if (mine === generation.current) setAudio(current => current.file === attached.file && current.text === attached.text ? emptyAttachment() : current)
      } else setSendError('No se confirmó el envío. Se conservó el borrador para reintentar.')
    } catch {
      setSendError('No se pudo enviar. Se conservó el borrador para reintentar.')
    } finally { pending.current = false; setSending(false) }
  }
  const ready = !!draft.trim() || !!audio.file && audio.phase === 'ready' && !!audio.text.trim()
  return <form className="message-composer message-composer--with-audio" aria-label="Enviar mensaje escrito" aria-busy={sending} onSubmit={(event) => {
    event.preventDefault(); void send()
  }}>
    <label className="visually-hidden" htmlFor="chat-message">Escribe un mensaje</label>
    <textarea id="chat-message" aria-label="Escribe un mensaje" rows={2} value={draft}
      placeholder="Escribe un mensaje…" aria-describedby="chat-message-hint"
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key !== 'Enter' || event.shiftKey || event.repeat || event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 || composing.current) return
        event.preventDefault(); void send()
      }} />
    <button type="submit" className="surface-button" disabled={sending || !ready || !!audio.file && audio.phase !== 'ready'}>{sending ? 'Enviando…' : 'Enviar'}</button>
    <span className="visually-hidden" id="chat-message-hint">Enter para enviar. Mayús + Enter para una nueva línea.</span>
    <div className="audio-attachment">
      <div className="audio-attachment__actions">
        <label className="surface-button audio-attachment__picker" data-disabled={!available || sending}>
          Adjuntar audio
          <input ref={fileInput} type="file" aria-label="Adjuntar audio para Whisper local" accept={whisperAccept(caps)} disabled={!available || sending}
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void transcribe(file) }} />
        </label>
        <span className="audio-attachment__scope">Whisper local → texto editable. El audio no se adjunta al chat.</span>
        {!available && <button type="button" className="surface-button" disabled={whisper.state === 'loading'}
          onClick={() => { void refreshWhisper().catch(() => {}) }}>{whisper.state === 'loading' ? 'Consultando Whisper…' : 'Comprobar Whisper'}</button>}
      </div>
      <p className="audio-attachment__help" role="status">{available && caps
        ? `Modelo: ${caps.model || 'local'}. Límite: ${(caps.maxBytes / 1048576).toFixed(1)} MB · ${caps.maxSeconds} s. Formatos: ${caps.formats.join(', ')}.`
        : whisper.error || 'Comprobando disponibilidad de Whisper local…'}</p>
      {audio.file && <div className="audio-attachment__review" aria-busy={audio.phase === 'transcribing'}>
        <p className="audio-attachment__filename">{audio.file.name}</p>
        <p role="status" aria-live="polite">{sending ? 'Enviando solo el texto reconocido…' : audio.phase === 'transcribing' ? 'Transcribiendo con Whisper local…'
          : audio.phase === 'ready' ? 'Transcripción lista. Revísala y pulsa Enviar.' : audio.phase === 'cancelled' ? 'Transcripción cancelada.' : 'Falló la transcripción local.'}</p>
        {audio.phase === 'ready' && <label className="audio-attachment__transcript">Transcripción de audio (editable)
          <textarea aria-label="Transcripción de audio (editable)" rows={4} value={audio.text}
            onChange={event => setAudio(current => ({ ...current, text: event.target.value }))} />
        </label>}
        {audio.error && <p className="audio-attachment__error" role="alert">{audio.error} No se usará otro motor.</p>}
        <div className="audio-attachment__actions">
          {audio.phase === 'transcribing' ? <button type="button" className="surface-button" onClick={() => cancel()}>Cancelar transcripción</button>
            : audio.phase !== 'ready' && <button type="button" className="surface-button" disabled={!available || sending} onClick={() => { if (audio.file) void transcribe(audio.file) }}>Reintentar transcripción</button>}
          <button type="button" className="surface-button" disabled={sending} onClick={() => cancel(true)}>Quitar audio</button>
        </div>
      </div>}
    </div>
    {sendError && <p className="audio-attachment__error" role="alert">{sendError}</p>}
  </form>
}
