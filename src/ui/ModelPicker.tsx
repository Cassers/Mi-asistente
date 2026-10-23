import type { ModelOption } from '../lib/models'
import { SearchableModelSelect } from './SearchableModelSelect'

const labels: Record<string, string> = { none: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' }
type Props = { models: ModelOption[]; model: string; variant: string; locked: boolean; loading: boolean; error: string;
  onChoose: (model: string, variant?: string) => void; onRefresh: () => void }

export function ModelPicker({ models, model, variant, locked, loading, error, onChoose, onRefresh }: Props) {
  const selected = models.find(m => m.id === model)
  return <details className="model-picker">
    <summary><span>Aplicación, modelo y pensamiento</span><small>OpenCode · {selected?.name || (loading ? 'Cargando modelos…' : 'Catálogo no disponible')} · {labels[variant] || variant || 'Automático'}</small></summary>
    <div className="model-picker__body">
      <label htmlFor="assistant-application">Aplicación</label>
      <select id="assistant-application" value="opencode" disabled aria-describedby="application-description">
        <option value="opencode">OpenCode</option>
      </select>
      <p id="application-description">Conexión local de OpenCode. Es la única aplicación habilitada por ahora.</p>
      <span className="surface-eyebrow">PROVEEDORES CONECTADOS</span>
      <label htmlFor="assistant-model">Modelo</label>
      <SearchableModelSelect models={models} model={model} disabled={locked || loading || !models.length}
        onChoose={id => onChoose(id)} onRefresh={onRefresh} />
      {selected && <p className={!selected.free ? 'model-picker__warning' : ''}>{selected.free ? 'Modelo gratuito según el catálogo actual.' : 'Puede consumir saldo o la cuota de tu suscripción. Se usa tu cuenta configurada en OpenCode; no hay cambio automático de modelo.'}</p>}
      <label htmlFor="assistant-thinking">Nivel de pensamiento</label>
      <select id="assistant-thinking" value={variant} disabled={locked || loading || !selected?.variants.length} onChange={e => onChoose(model, e.target.value)}>
        <option value="">Automático (predeterminado)</option>
        {selected?.variants.map(v => <option key={v} value={v}>{labels[v] || v}</option>)}
      </select>
      <p>{selected && !selected.variants.length ? 'OpenCode no expone niveles ajustables para este modelo.' : 'Más pensamiento puede aumentar el tiempo de respuesta. Se aplica a tu próxima pregunta.'}</p>
      {selected && <p className={!selected.image ? 'model-picker__warning' : ''}>{selected.image ? 'Recibe la captura actual al hablar.' : 'Solo texto: no recibirá la captura automática de tu monitor.'}{selected.audio ? ' Admite audio adjunto.' : ''}</p>}
      {error && <p className="surface-error" role="alert">{error}</p>}
      <button type="button" className="surface-button" disabled={locked || loading} onClick={onRefresh}>Actualizar modelos</button>
    </div>
  </details>
}
