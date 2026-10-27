import { useRef, useState } from 'react'

type Props = { onSendMessage: (text: string) => boolean | Promise<boolean> }

export function MessageComposer({ onSendMessage }: Props) {
  const [draft, setDraft] = useState('')
  const composing = useRef(false)
  const pending = useRef(false)
  const [sending, setSending] = useState(false)
  const send = async () => {
    const text = draft.trim()
    if (!text || composing.current || pending.current) return
    pending.current = true
    setSending(true)
    try {
      if (await onSendMessage(text) === true) {
        // Preserve any newer text typed while native dispatch was being accepted.
        setDraft(current => current === draft ? '' : current)
      }
    } catch {
      // App owns the dispatch error; rejection must retain the user's draft.
    } finally {
      pending.current = false
      setSending(false)
    }
  }
  return <form className="message-composer" aria-label="Enviar mensaje escrito" aria-busy={sending} onSubmit={(event) => {
    event.preventDefault()
    void send()
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
        event.preventDefault()
        send()
      }} />
    <button type="submit" className="surface-button" disabled={sending || !draft.trim()}>{sending ? 'Enviando…' : 'Enviar'}</button>
    <span className="visually-hidden" id="chat-message-hint">Enter para enviar. Mayús + Enter para una nueva línea.</span>
  </form>
}
