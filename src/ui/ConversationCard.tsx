import type { ReactNode } from 'react'
type Entry = { id: string; title: string; busy: boolean }
type Props = {
  children?: ReactNode;
  id: string; entries: Entry[]; locked: boolean; status: string; error: string;
  onChoose: (id: string) => void; onRefresh: () => void; onDelete: () => void;
}

export function ConversationCard({ id, entries, locked, status, error, onChoose, onRefresh, onDelete, children }: Props) {
  return (
    <section className="conversation-card" aria-label="Conversaciones guardadas" aria-busy={locked}
      onKeyDown={(e) => e.stopPropagation()}>
      <div className="conversation-card__heading">
        <div>
          <span className="surface-eyebrow">TU ESPACIO</span>
          <h2>Conversaciones <span className="conversation-card__count">{entries.length}</span></h2>
        </div>
        <span className="conversation-card__mark" aria-hidden="true">◈</span>
      </div>
      <label className="conversation-card__label" htmlFor="saved-conversation">Conversación actual</label>
      <div className="conversation-card__select">
        <select id="saved-conversation" aria-label="Elegir conversación" value={id}
          disabled={locked || !id} onFocus={onRefresh} onChange={(e) => onChoose(e.target.value)}>
          {!id && <option value="">Sin conexión</option>}
          {entries.map(entry => <option key={entry.id} value={entry.id} disabled={entry.busy && entry.id !== id}>
            {entry.title} · {entry.id.slice(-4)}
          </option>)}
        </select>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </div>
      <div className="conversation-card__actions">
        <button type="button" className="surface-button surface-button--primary" disabled={locked} onClick={() => onChoose('new')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
          Nuevo chat
        </button>
        <button type="button" className="surface-button surface-button--danger" disabled={locked || !id} onClick={onDelete}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6" /></svg>
          Eliminar
        </button>
      </div>
      <div className="conversation-card__status" role="status">
        <span className="surface-status-dot" data-busy={locked} data-error={Boolean(error)} />
        {status}
      </div>
      {error && <p className="surface-error" role="alert">{error}</p>}
      {children}
    </section>
  )
}
