import { useEffect, useRef, useState } from 'react'
import { useStore, type PermissionRequest } from '../store'
import { replyPermission } from '../lib/brain'

/** Real OpenCode approvals, shown as untrusted plain text, never spoken approval. */
export function PermissionPrompt() {
  const requests = useStore((s) => s.permissions)
  const request = requests[0]
  return request ? <PermissionDialog key={request.id} request={request} count={requests.length} /> : null
}

export function PermissionDialog({ request, count, onReply = replyPermission }: {
  request: PermissionRequest; count: number; onReply?: typeof replyPermission;
}) {
  const deny = useRef<HTMLButtonElement>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const previous = document.activeElement
    deny.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const respond = async (reply: 'once' | 'reject') => {
    deny.current?.closest<HTMLElement>('[role="dialog"]')?.focus()
    setSending(true)
    try { await onReply(request.id, reply) }
    catch (err) { setError(String(err)); setSending(false) }
  }
  return (
    <div className="permission-overlay"
      onKeyDown={(e) => e.stopPropagation()}>
      <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title"
        aria-describedby="permission-description" aria-busy={sending} tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const items = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary')
          const first = items[0], last = items[items.length - 1]
          if (!first) { e.preventDefault(); e.currentTarget.focus(); return }
          if (document.activeElement === e.currentTarget) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
        }}>
        <header className="permission-dialog__header">
          <span className="permission-dialog__shield" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="M12 8v5m0 3h.01" /></svg>
          </span>
          <div><span className="surface-eyebrow">TÚ TIENES EL CONTROL</span>
            <h2 id="permission-title">Autorizar una operación</h2>
          </div>
          <span className="permission-dialog__kind">{request.permission}</span>
        </header>
        <p id="permission-description" className="permission-dialog__description">OpenCode solicita tu permiso para esta operación. Las solicitudes que ya estaban pendientes no se autoaprueban al cambiar de modo.</p>
        <div className="permission-dialog__code">
          <div className="permission-dialog__code-label">{typeof request.metadata.command === 'string' ? 'COMANDO SOLICITADO' : 'ALCANCE SOLICITADO'}<span>POR AUTORIZAR</span></div>
          <pre>{typeof request.metadata.command === 'string' ? request.metadata.command : request.patterns.join('\n')}</pre>
        </div>
        <details className="permission-dialog__details"><summary>Ver alcance y detalles técnicos</summary>
          <pre>{JSON.stringify({ patterns: request.patterns, metadata: request.metadata }, null, 2)}</pre>
        </details>
        {error && <p className="surface-error" role="alert">{error}</p>}
        <footer className="permission-dialog__footer">
          <div className="permission-dialog__actions">
            <button type="button" className="surface-button" ref={deny} disabled={sending} onClick={() => void respond('reject')}>Rechazar</button>
            <button type="button" className="surface-button surface-button--approve" disabled={sending} onClick={() => void respond('once')}>
              {sending ? 'Enviando decisión…' : 'Autorizar solo esta vez'}
            </button>
          </div>
          <p>{count} solicitud{count !== 1 ? 'es' : ''} pendiente{count !== 1 ? 's' : ''} · No se guardan aprobaciones permanentes.</p>
        </footer>
      </section>
    </div>
  )
}
