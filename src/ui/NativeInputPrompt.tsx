import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '../store'
import { replyUserInput } from '../lib/brain'

import { nativeQuestions } from '../lib/native-input'

/** Native questions are answered by the person, never by automatic approval. */
export function NativeInputPrompt({ request, onReply = replyUserInput }: { request: PermissionRequest; onReply?: typeof replyUserInput }) {
  const questions = nativeQuestions(request.metadata.questions)
  const [values, setValues] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, boolean>>({})
  const pending = useRef(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const respond = async (cancel = false) => {
    if (pending.current) return
    pending.current = true
    setSending(true); setError('')
    try {
      const answers = Object.fromEntries(questions.map(question => [question.id, { answers: [values[question.id] || ''] }]))
      await onReply(request.id, cancel ? {} : answers)
      setValues({})
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo enviar la respuesta.'); setSending(false); pending.current = false }
  }
  return <div className="permission-overlay" onKeyDown={event => event.stopPropagation()}>
    <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="native-input-title" ref={panel}
      aria-busy={sending} tabIndex={-1} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); void respond(true); return }
        if (event.key !== 'Tab') return
        const fields = panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')
        if (!fields?.length) { event.preventDefault(); panel.current?.focus(); return }
        const first = fields[0], last = fields[fields.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }}>
      <h2 id="native-input-title">Codex necesita tu respuesta</h2>
      <form onSubmit={event => { event.preventDefault(); void respond() }}>
        {!questions.length && <p role="alert">No se pudo mostrar esta solicitud. Puedes cancelarla y continuar conversando.</p>}
        {questions.map((question, index) => <div className="model-picker__body" key={question.id}>
          <label htmlFor={`native-question-${index}`}>{question.question}</label>
          {question.options.length > 0 && !question.isSecret && <select id={`native-question-${index}`} disabled={sending}
            value={other[question.id] ? '__custom_answer__' : values[question.id] || ''} required
            onChange={event => {
              const custom = event.target.value === '__custom_answer__'
              setOther(current => ({ ...current, [question.id]: custom }))
              setValues(current => ({ ...current, [question.id]: custom ? '' : event.target.value }))
            }}>
            <option value="" disabled>Elige una respuesta</option>
            {question.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` · ${option.description}` : ''}</option>)}
            {question.isOther && <option value="__custom_answer__">Escribir otra respuesta</option>}
          </select>}
          {(!question.options.length || question.isSecret || other[question.id]) && <input id={`native-question-${index}${question.options.length && !question.isSecret ? '-custom' : ''}`}
            aria-label={question.question} type={question.isSecret ? 'password' : 'text'} autoComplete="off" maxLength={16000}
            required disabled={sending} value={values[question.id] || ''}
            onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))} />}
        </div>)}
        {error && <p className="surface-error" role="alert">{error}</p>}
        <footer className="permission-dialog__actions">
          <button type="button" className="surface-button" disabled={sending} onClick={() => void respond(true)}>Cancelar solicitud</button>
          <button type="submit" className="surface-button surface-button--approve" disabled={sending || !questions.length || questions.some(question => !values[question.id]?.trim())}>
            {sending ? 'Enviando…' : 'Enviar respuestas'}
          </button>
        </footer>
      </form>
    </section>
  </div>
}
