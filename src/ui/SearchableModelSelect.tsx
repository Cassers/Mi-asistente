import { useEffect, useId, useRef, useState } from 'react'
import type { ModelOption } from '../lib/models'
import { filterModels } from '../lib/model-search'

type Props = { models: ModelOption[]; model: string; disabled: boolean; onChoose: (id: string) => void; onRefresh: () => void }
export function SearchableModelSelect({ models, model, disabled, onChoose, onRefresh }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const selected = models.find(m => m.id === model)
  const visible = filterModels(models, query)
  const index = Math.min(active, visible.length - 1)
  const expanded = open && !disabled
  const label = selected ? `${selected.provider} · ${selected.name}` : ''
  useEffect(() => {
    if (expanded) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query, expanded])
  const begin = () => { if (!disabled) { setOpen(true); setQuery(''); setActive(0) } }
  const choose = (option: ModelOption) => { onChoose(option.id); setOpen(false); setQuery('') }

  return <div className="model-search" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setQuery('') }
  }}>
    <div className="model-search__input">
      <input id="assistant-model" type="text" role="combobox" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={`${id}-list`} aria-describedby={`${id}-help`}
        aria-activedescendant={expanded && visible[index] ? `${id}-${index}` : undefined}
        disabled={disabled} autoComplete="off" spellCheck={false} value={expanded ? query : label}
        placeholder={models.length ? `Buscar entre ${models.length} modelos…` : 'Sin catálogo'} title={label}
        onFocus={() => { begin(); onRefresh() }} onClick={() => { if (!open) begin() }}
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!expanded) { begin(); return }
            setActive(Math.max(0, Math.min(visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (e.key === 'Enter' && expanded) {
            e.preventDefault(); if (visible[index]) choose(visible[index])
          } else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQuery('') }
          else if (e.key === 'Tab') { setOpen(false); setQuery('') }
        }} />
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m12 12 5 5" /></svg>
    </div>
    <p id={`${id}-help`} className="model-search__help">Escribe el modelo o proveedor. Flechas y Enter para elegir.</p>
    {expanded && <div className="model-search__results">
      <div className="model-search__count" role="status">{visible.length} {visible.length === 1 ? 'modelo' : 'modelos'}</div>
      <div id={`${id}-list`} role="listbox" aria-label="Modelos disponibles" ref={list}>
        {visible.map((option, n) => <button key={option.id} id={`${id}-${n}`} type="button" role="option"
          aria-selected={model === option.id} data-active={n === index} tabIndex={-1}
          onMouseDown={e => e.preventDefault()} onClick={() => choose(option)}
          onMouseEnter={() => setActive(n)}>
          <span>{option.name}</span><small>{option.provider} · {option.free ? 'Gratis' : 'Según tu plan'}</small>
        </button>)}
      </div>
      {!visible.length && <p className="model-search__empty">No hay coincidencias. Prueba otro nombre.</p>}
    </div>}
  </div>
}
